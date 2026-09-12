// The DB gather behind the school-return countdown (issue #859 item 2). Turns a
// profile's open illness episode into the two logged clocks the PURE
// computeSchoolReturn (lib/school-return.ts) needs: the last FEVER-RANGE temperature
// reading and the last ANTIPYRETIC administration. ONE gather, three formatters — the
// illness Now cockpit, the episode page, and the household line all render over the SAME
// SchoolReturnStatus (#221), never a second engine.
//
// Every statement is profile-scoped (the temperature series rides the already-scoped
// AssembledEpisode; the antipyretic query reaches profile_id via its JOIN to
// intake_items, matching assembleIllnessEpisode's own PRN gather).

import { db } from "./db";
import { zonedWallTimeToUtc } from "./date";
import { bestKnownInstant, instantDate } from "./row-instants";
import { getTimezone, getProfileSetting } from "./settings";
import { formatGivenAtClock } from "./administration-format";
import { parseRxcuiIngredients } from "./rxnorm";
import { isAntipyreticIntakeItem } from "./prn-defaults";
import { isOutOfRange } from "./reference-range/flags";
import type { AssembledEpisode } from "./illness-episode-format";
import {
  computeSchoolReturn,
  type LastAntipyretic,
  type SchoolReturnStatus,
} from "./school-return";

const DEFAULT_THRESHOLD_HOURS = 24;

interface AntipyreticAdministrationRow {
  [key: string]: unknown;
  name: string;
  rxcui: string | null;
  rxcui_ingredients: string | null;
  occurred_at: string | null;
  recorded_at: string;
}

// EVERY ANTIPYRETIC ADMINISTRATION ON THE RECORD — **NOT BOUNDED BY `l.date`** (#5882,
// owner ruling), exactly as the sibling redose clock gathers (`prn-family.ts`).
//
// A dose's `date` is SCHEDULE-OWNED (#614 — the token's date is the day the reminder
// was asking about), not a fact about when the dose was given: `restampDoseLogsCore`
// moves `occurred_at` across midnight and leaves `date` where the schedule put it,
// reporting `crossedMidnight` for exactly this. `prn-family.ts` refuses a `MAX(date)`
// narrowing on those grounds — it "drops the genuinely-latest dose" — and a window
// bound against the EPISODE's days drops it the same way, in the same direction: an
// antipyretic the record says was TAKEN disappeared from a school-clearance
// computation because its schedule-owned day sat outside the episode. The note then
// read "fever-free 25h of 24", met, naming no reducer at all.
//
// So the day decides nothing about which administrations EXIST. The row is not even
// selected: this query reads no `l.date` anywhere, and the only ordering key is the
// stated instant with the capture chain behind it.
//
// The cost is honest and small: one profile's `may`-obligation taken administrations,
// filtered to fever reducers in TypeScript below. There is no cheaper bound that is
// also sound — every one tried was a day or a stamp standing in for an instant nobody
// logged.
function antipyreticAdministrationRows(
  profileId: number
): AntipyreticAdministrationRow[] {
  return db
    .prepare(
      `SELECT ii.name AS name, ii.rxcui AS rxcui,
              ii.rxcui_ingredients AS rxcui_ingredients,
              l.occurred_at AS occurred_at, l.recorded_at AS recorded_at
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND l.status = 'taken' AND ii.obligation = 'may'
        ORDER BY COALESCE(l.occurred_at, l.recorded_at) ASC, l.id ASC`
    )
    .all(profileId) as AntipyreticAdministrationRow[];
}

// The per-profile school-return threshold in hours (the common 24h convention by
// default). Clamped to a sane 1..168h range so a corrupt setting can't produce a
// nonsense countdown.
export function getSchoolReturnThresholdHours(profileId: number): number {
  const raw = getProfileSetting(profileId, "school_return_threshold_hours");
  const n = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD_HOURS;
  return Math.min(168, Math.max(1, Math.round(n)));
}

// Compute the school-return countdown for an assembled OPEN episode, or null when it
// doesn't apply yet — there has been no fever-range reading in the episode, so there
// is nothing to count down from. A fever WITHOUT a later normal reading is a
// different state, not an absent one: the status is returned with no fever-free claim
// in it (#4685). `nowMs` is injectable for tests.
function schoolReturnStatusForRows(
  profileId: number,
  episode: AssembledEpisode,
  nowMs: number,
  prefetchedRows?: readonly AntipyreticAdministrationRow[],
  prefetchedSettings?: { timeZone: string; thresholdHours: number }
): SchoolReturnStatus | null {
  const tz = prefetchedSettings?.timeZone ?? getTimezone(profileId);

  // Last FEVER-RANGE reading: the newest temperature whose reference-range flag is
  // "high". The episode's temperatures are date-then-time ascending.
  //
  // A day-granular reading with no clock time is anchored at local noon (a neutral
  // mid-day instant) — the countdown is informational and hour-granular. An unreadable
  // clock is SKIPPED, not anchored at noon: the countdown this feeds is a
  // return-to-school clearance, and a fabricated fever instant would move it (#2245).
  //
  // NOON IS A PLACEHOLDER, NOT A MEASUREMENT, and the ordering rule below is what keeps
  // that honest.
  // TWO QUESTIONS, NOT ONE: what ORDERS the readings, and what the surface QUOTES.
  //
  // The ordering anchor may be an UNPLACED reading — one that states no clock — because
  // an unplaced reading could be later than every placed one on its day, and letting it
  // govern is what keeps `establishedAfterFever` below from being bypassed by noon
  // arithmetic.
  //
  // But a placeholder must never become a QUOTED FACT. Letting the unplaced reading
  // govern `lastFeverDegF` too produced "No reading since 100.5 °F (14h ago)" where the
  // last measured fever was a LATER, HIGHER 103.4 at 19:00 — the line quoted the lower
  // reading and doubled the elapsed time, both off a noon placeholder, both in the
  // reassuring direction, on a surface whose whole posture is the person's own logged
  // facts. So the quoted reading is the latest fever that actually STATES a time, and
  // only when no fever states one at all does the unplaced reading get quoted, because
  // then there is nothing else to quote.
  let lastFever: { ms: number; day: string; timed: boolean } | null = null;
  let quoted: { ms: number; degF: number } | null = null;
  let unplacedFallback: { ms: number; degF: number } | null = null;
  for (const t of episode.temperatures) {
    if (t.flag !== "high") continue;
    const at = zonedWallTimeToUtc(tz, t.date, t.time ?? "12:00");
    if (!at) continue;
    const ms = at.getTime();
    const timed = !!t.time;

    // The ORDERING anchor. A later DAY always wins; on the SAME day an unplaced
    // reading wins over a placed one, a later placed instant wins between two placed
    // ones, and the later in the episode's own order wins between two unplaced ones.
    if (lastFever == null) {
      lastFever = { ms, day: t.date, timed };
    } else {
      const laterDay = t.date > lastFever.day;
      const sameDay = t.date === lastFever.day;
      const wins = laterDay
        ? true
        : !sameDay
          ? false
          : lastFever.timed && !timed
            ? true
            : lastFever.timed === timed
              ? ms >= lastFever.ms
              : false;
      if (wins) lastFever = { ms, day: t.date, timed };
    }

    // The QUOTED reading, tracked separately: the latest fever that states a time.
    if (timed) {
      if (quoted == null || ms >= quoted.ms) quoted = { ms, degF: t.degF };
    } else if (unplacedFallback == null || ms >= unplacedFallback.ms) {
      unplacedFallback = { ms, degF: t.degF };
    }
  }
  if (lastFever == null) return null;
  // Quoted from a measured reading whenever one exists; the placeholder only when no
  // fever in this episode states a time.
  const quotedFever = quoted ?? unplacedFallback!;
  const lastFeverAtMs = quotedFever.ms;
  const lastFeverDegF = quotedFever.degF;

  // THE EVIDENCE (#4685): the first IN-RANGE reading established to be AFTER that
  // fever.
  //
  // OUT OF RANGE IN EITHER DIRECTION IS NOT CLEARANCE. Skipping only `high` let a
  // HYPOTHERMIC reading start the fever-free clock: 103.4 then 95.0 read as
  // "Fever-free 24h/24h, met" — and 95 °F in a sick child is a red flag, not a
  // recovery. `isOutOfRange` is the shipped predicate (high / low / abnormal) and is
  // null-safe, which matters because a normal manual reading stores flag NULL rather
  // than "normal" — testing for the string would have matched nothing at all and
  // stranded every parent at "No reading since".
  //
  // AND "AFTER" MUST BE ESTABLISHED, NOT ARITHMETIC. Comparing the two anchored
  // instants treats noon as if somebody had measured at noon: an untimed 103.4 and a
  // 13:00 normal on the same day resolved to "the normal came after" and cleared the
  // child, though the fever may have been at 19:10. Ordering between two readings on
  // ONE day is knowable only when BOTH state a clock; across days it is knowable from
  // the days alone, because every instant on a later day follows every instant on an
  // earlier one. Anything else is unproven, and unproven is not evidence.
  const establishedAfterFever = (day: string, timed: boolean, ms: number) =>
    day > lastFever.day
      ? true
      : day < lastFever.day
        ? false
        : lastFever.timed && timed && ms > lastFever.ms;

  let firstNormalAfterFeverAtMs: number | null = null;
  for (const t of episode.temperatures) {
    if (isOutOfRange(t.flag)) continue;
    const at = zonedWallTimeToUtc(tz, t.date, t.time ?? "12:00");
    if (!at) continue;
    const ms = at.getTime();
    if (
      establishedAfterFever(t.date, !!t.time, ms) &&
      (firstNormalAfterFeverAtMs == null || ms < firstNormalAfterFeverAtMs)
    ) {
      firstNormalAfterFeverAtMs = ms;
    }
  }

  // Last ANTIPYRETIC administration ON THE RECORD — no episode window (#5882; the
  // gather says why). Mirrors assembleIllnessEpisode's PRN gather (obligation 'may' +
  // status 'taken', profile-scoped by JOIN), then filters to fever reducers via the
  // curated PRN dataset.
  const rows = prefetchedRows ?? antipyreticAdministrationRows(profileId);

  // ONLY A STATED ADMINISTRATION TIME FEEDS THE CLOCK (#5688). `bestKnownInstant`
  // answers with the stated event instant (`occurred_at`) when the row has one and with
  // the record chain's immutable capture (`recorded_at`) otherwise — and SAYS which
  // (#2205 phase 3). The note has always used that to LABEL the clock honestly; the
  // arithmetic below used to ignore it and count from whichever instant came back.
  //
  // And a capture stamp bounds the administration in NEITHER direction: a past-day
  // skipped→taken flip keeps the SKIP's `recorded_at`, which PREDATES the dose, so the
  // fever-free clock started early and could clear a child for school while a reducer
  // was still masking a fever. So an unstated dose contributes no instant at all and
  // the countdown is HELD (owner ruling, #5688) behind the "add it in Dose history"
  // door. No conservative-hour fallback: this document quotes no time it was not given.
  const doses: {
    statedMs: number | null;
    name: string;
    clockLabel: string | null;
  }[] = [];
  for (const r of rows) {
    if (
      !isAntipyreticIntakeItem({
        name: r.name,
        rxcui: r.rxcui,
        rxcuiIngredients: parseRxcuiIngredients(r.rxcui_ingredients),
      })
    ) {
      continue;
    }
    const when = bestKnownInstant("intake_item_logs", r);
    if (!when.known) {
      // Neither column readable: the row states no time either, so it holds like any
      // other unstated dose rather than dropping out — dropping a fever reducer is the
      // permissive direction, and that is the whole point of this gather.
      doses.push({
        statedMs: null,
        name: r.name,
        clockLabel: null,
      });
      continue;
    }
    const d = instantDate(when);
    // The school-return note is a document a caregiver hands to a school, so its
    // claim must match what the row states (#2228 decision 4): "last ibuprofen
    // recorded 4:02pm" when nobody stated an intake time, a bare clock only when
    // somebody did. The value stays visible with its provenance either way.
    const clock = formatGivenAtClock(tz, when.at) || null;
    doses.push({
      // An `event` answer, and nothing else.
      statedMs: d && when.semantic === "event" ? d.getTime() : null,
      name: r.name,
      clockLabel:
        clock != null && when.semantic === "record"
          ? `recorded ${clock}`
          : clock,
    });
  }

  // HOW LONG AN UNSTATED DOSE HOLDS: UNTIL SOMEBODY STATES ITS TIME. There is no
  // second bound, and both of the ones this fix tried are in the branch history for
  // the same reason — each ended by manufacturing an instant the record does not
  // carry, which is the one thing the ruling forbids.
  //
  //   • Scoped to the latest `l.date` carrying a reducer. A dose's day is
  //     SCHEDULE-OWNED (#614): a midnight-crossing correction moves `occurred_at` and
  //     leaves `date` where the schedule put it (`restampDoseLogsCore` reports
  //     `crossedMidnight` for exactly this), and `prn-family.ts` refuses a `MAX(date)`
  //     narrowing on the same grounds — it "drops the genuinely-latest dose". So a
  //     dose dated today can have been given yesterday, and the narrowing dropped
  //     yesterday's unstated one as "not the last".
  //   • Bounded by max(end of its schedule-owned day, its own capture stamp). A
  //     past-day skipped→taken flip does NOT move `recorded_at` — the tri-state write
  //     keeps that column out of its SET list on purpose, so the stamp stays the
  //     SKIP's — and a dose skipped on a day and tapped Taken after midnight sits past
  //     both of those bounds, so the note cleared the child again.
  //
  // Both are the same mistake: they answer "when could this dose have been given" with
  // a number nobody logged. So the hold rests on the only thing the row does state —
  // that it states no administration time (`when.semantic === "record"`) — and runs
  // until one is added.
  //
  // AND THE THIRD BOUND, WHICH WAS NEVER THIS FIX'S AND IS GONE TOO (#5882): the
  // gather's own `l.date >= ? AND l.date <= ?` against the episode's day window, which
  // predated every pass of #5688 and dropped an unstated reducer out of the
  // computation entirely whenever its schedule-owned day fell outside. Same mistake in
  // a third spelling — a day deciding which administrations exist — and the same
  // direction: the note cleared the child naming no reducer at all. See the gather.
  //
  // "THE LATEST STATED DOSE COMPUTES; ANY UNSTATED DOSE LATER THAN IT HOLDS" (the
  // ruling) IS THE `unstated.length > 0` BELOW, and the step between the two sentences
  // is the point: an unstated dose can never be established to be EARLIER than the
  // stated one, because establishing that needs an instant it does not carry. Its day
  // will not do it — that is this whole issue. So "later than it" is true of every
  // unstated dose the record holds, and mere existence is the test. `prn-family.ts`
  // reaches the identical rule from the identical premise: `ARMING_ORDER` sorts a taken
  // administration that states no instant AHEAD of every one that does, "such a row
  // could be the latest and nothing in it says otherwise".
  //
  // THE CONSEQUENCE, WRITTEN DOWN RATHER THAN SOFTENED: one unstated fever-reducer
  // dose holds the fever-free countdown until somebody states that dose's time through
  // the Dose history door the held clause names — and since the gather is no longer
  // bounded by the episode, that dose need not be in this illness at all: an unstated
  // antipyretic filed months ago holds today's note. That is what this code does,
  // deliberately. Any expiry — the dose's day, its filing stamp, a "surely by now"
  // hour — is the manufactured instant again in a new spelling, and it fails in the
  // reassuring direction: a countdown that clears itself is a clearance nobody
  // measured. Whether the door is escape enough, and whether a stale unstated dose
  // should be openable some other way, are PRODUCT questions on the owner's report
  // (#5688 / #5882), not ones this computation may settle for itself.
  //
  // And this narrows ONE computation, nothing wider: it keeps the filing stamp out of
  // the school-return clock. It does not make every unsafe clearance impossible.
  let lastAntipyretic: LastAntipyretic | null = null;
  const unstated = doses.filter((dose) => dose.statedMs == null);
  if (unstated.length > 0) {
    // The dose the note names is the last unstated one in the gather's own order
    // (event-then-capture ascending, id tie-break).
    const shown = unstated[unstated.length - 1];
    lastAntipyretic = {
      timeStated: false,
      name: shown.name,
      clockLabel: shown.clockLabel,
    };
  } else {
    let best: { ms: number; name: string; clockLabel: string | null } | null =
      null;
    for (const dose of doses) {
      if (dose.statedMs != null && (best == null || dose.statedMs >= best.ms)) {
        best = {
          ms: dose.statedMs,
          name: dose.name,
          clockLabel: dose.clockLabel,
        };
      }
    }
    if (best != null) {
      lastAntipyretic = {
        timeStated: true,
        atMs: best.ms,
        name: best.name,
        clockLabel: best.clockLabel,
      };
    }
  }

  return computeSchoolReturn({
    lastFeverAtMs,
    lastFeverDegF,
    firstNormalAfterFeverAtMs,
    lastAntipyretic,
    nowMs,
    thresholdHours:
      prefetchedSettings?.thresholdHours ??
      getSchoolReturnThresholdHours(profileId),
  });
}

export function schoolReturnStatusFor(
  profileId: number,
  episode: AssembledEpisode,
  nowMs: number = Date.now()
): SchoolReturnStatus | null {
  return schoolReturnStatusForRows(profileId, episode, nowMs);
}

// Resolve every open cockpit for one profile over a single antipyretic read. The
// fever side already rides each preassembled episode; adding an episode therefore
// changes only the pure partition below, not SQL count.
//
// THE PREFETCH STILL EARNS ITS EXISTENCE, AND EARNS IT MORE PLAINLY THAN BEFORE. It
// used to fold a min/max day window across the episodes and read that union, which
// meant each episode was handed rows it then had to re-narrow to its own window — the
// prefetch and the per-episode answer were not reading the same thing. With the
// window gone (#5882) the gather's only argument is `profileId`, so every episode
// wants the SAME row set, byte for byte; reading it once is the whole of the saving
// and there is nothing left to re-narrow. Dropping the prefetch would re-issue one
// identical unbounded query per open episode for no answer that differs, so it stays.
// The SQL count is unchanged by this change — one antipyretic read before, one now —
// so no query budget needed adjusting; no budget test covers this path today anyway.
export function schoolReturnStatusesFor(
  profileId: number,
  episodes: readonly (AssembledEpisode & { id: number })[],
  nowMs: number = Date.now()
): Map<number, SchoolReturnStatus | null> {
  const out = new Map<number, SchoolReturnStatus | null>();
  if (episodes.length === 0) return out;
  if (
    !episodes.some((episode) =>
      episode.temperatures.some((temperature) => temperature.flag === "high")
    )
  ) {
    for (const episode of episodes) out.set(episode.id, null);
    return out;
  }
  const rows = antipyreticAdministrationRows(profileId);
  const settings = {
    timeZone: getTimezone(profileId),
    thresholdHours: getSchoolReturnThresholdHours(profileId),
  };
  for (const episode of episodes) {
    out.set(
      episode.id,
      schoolReturnStatusForRows(profileId, episode, nowMs, rows, settings)
    );
  }
  return out;
}
