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
import { parseUtcSql, shiftDateStr, zonedWallTimeToUtc } from "./date";
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

// The far-past floor for an episode whose start is unknown (before the change-log),
// mirroring assembleIllnessEpisode.
const OPEN_START_FLOOR = "0001-01-01";

const DEFAULT_THRESHOLD_HOURS = 24;

interface AntipyreticAdministrationRow {
  [key: string]: unknown;
  name: string;
  rxcui: string | null;
  rxcui_ingredients: string | null;
  date: string;
  occurred_at: string | null;
  recorded_at: string;
}

function antipyreticAdministrationRows(
  profileId: number,
  from: string,
  to: string
): AntipyreticAdministrationRow[] {
  return db
    .prepare(
      `SELECT ii.name AS name, ii.rxcui AS rxcui,
              ii.rxcui_ingredients AS rxcui_ingredients, l.date AS date,
              l.occurred_at AS occurred_at, l.recorded_at AS recorded_at
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND l.status = 'taken' AND ii.obligation = 'may'
          AND l.date >= ? AND l.date <= ?
        ORDER BY COALESCE(l.occurred_at, l.recorded_at) ASC, l.id ASC`
    )
    .all(profileId, from, to) as AntipyreticAdministrationRow[];
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

  // Last ANTIPYRETIC administration in the episode window. Mirrors
  // assembleIllnessEpisode's PRN gather (obligation 'may' + status 'taken', profile-scoped by
  // JOIN), then filters to fever reducers via the curated PRN dataset.
  const from = episode.firstDay ?? OPEN_START_FLOOR;
  const to = episode.lastActiveDay ?? episode.asOf;
  const rows =
    prefetchedRows ?? antipyreticAdministrationRows(profileId, from, to);

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
    day: string;
    statedMs: number | null;
    // The row's capture stamp, used ONLY as the plausibility bound below — never as an
    // instant the countdown computes from.
    recordedMs: number | null;
    name: string;
    clockLabel: string | null;
  }[] = [];
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
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
        day: r.date,
        statedMs: null,
        recordedMs: parseUtcSql(r.recorded_at)?.getTime() ?? null,
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
      day: r.date,
      // An `event` answer, and nothing else.
      statedMs: d && when.semantic === "event" ? d.getTime() : null,
      recordedMs: parseUtcSql(r.recorded_at)?.getTime() ?? null,
      name: r.name,
      clockLabel:
        clock != null && when.semantic === "record"
          ? `recorded ${clock}`
          : clock,
    });
  }

  // HOW LONG AN UNSTATED DOSE HOLDS, AND WHY IT IS NOT "UNTIL ITS DAY IS OVER".
  //
  // An earlier pass of this fix scoped the hold to the latest `l.date` carrying a
  // reducer, on the reasoning that a later day's instants all follow an earlier day's.
  // THAT IS FALSE FOR THIS TABLE and the tree already said so: a dose's day is
  // SCHEDULE-OWNED (#614) and a midnight-crossing correction moves `occurred_at` while
  // leaving `date` where the schedule put it (`restampDoseLogsCore`, which returns
  // `crossedMidnight` for exactly this). `prn-family.ts` refuses a `MAX(date)`
  // narrowing for the same reason — "drops the genuinely-latest dose". So a dose dated
  // TODAY can have been given yesterday, a `MAX(date)` filter drops yesterday's
  // unstated dose as "not the last one", and the countdown clears on a reducer nobody
  // placed. The bound has to be an INSTANT.
  //
  // So the question is not "which dose is last" but "could any unstated dose still be
  // masking a fever". A dose that states no time is bounded by the latest moment it
  // could plausibly have been given:
  //
  //   • the END of its schedule-owned day, in the profile's zone; and
  //   • its own capture stamp, for a dose FILED after that day ended (a backfill, or a
  //     confirm just past midnight). Read as a plausibility bound only — it is never
  //     an instant the countdown computes from, which is what the ruling forbids.
  //
  // Past that bound plus the threshold, the dose cannot be inside the fever-free window
  // however it is placed, so dropping it is provably safe and the hold ends. That keeps
  // the door meaningful: one unstated dose on day 1 of a ten-day flu stops holding, and
  // does not train anyone to ignore the one that matters.
  //
  // WHAT THIS STILL DOES NOT COVER, stated rather than claimed away: a dose logged
  // against a day it OUTLIVED — given at 00:30 and confirmed onto the previous day's
  // bedtime schedule with no minute — sits past both bounds, by the gap between that
  // day's end and when it was really given. Stating the time removes the guess
  // entirely, which is what the door asks for.
  const thresholdHours =
    prefetchedSettings?.thresholdHours ??
    getSchoolReturnThresholdHours(profileId);
  // The latest moment a dose that states no time could have been given. An unreadable
  // day AND an unreadable capture leave it unbounded, which holds: nothing about such a
  // row rules the fever-free window out.
  const latestPossibleMs = (dose: (typeof doses)[number]): number => {
    const dayEnd = zonedWallTimeToUtc(tz, shiftDateStr(dose.day, 1), "00:00");
    return Math.max(
      dayEnd ? dayEnd.getTime() : Number.NEGATIVE_INFINITY,
      dose.recordedMs ?? Number.NEGATIVE_INFINITY
    );
  };

  let lastAntipyretic: LastAntipyretic | null = null;
  const holding = doses
    .filter((dose) => dose.statedMs == null)
    .map((dose) => ({ dose, bound: latestPossibleMs(dose) }))
    .filter(
      ({ bound }) =>
        !Number.isFinite(bound) || nowMs - bound < thresholdHours * 3_600_000
    );
  if (holding.length > 0) {
    // The dose the note names is the one holding the clock longest: the latest moment
    // any unstated dose could still have been given.
    const shown = holding.reduce((a, b) => (b.bound >= a.bound ? b : a)).dose;
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
    thresholdHours,
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
  const from = episodes.reduce((earliest, episode) => {
    const start = episode.firstDay ?? OPEN_START_FLOOR;
    return start < earliest ? start : earliest;
  }, episodes[0].firstDay ?? OPEN_START_FLOOR);
  const to = episodes.reduce((latest, episode) => {
    const end = episode.lastActiveDay ?? episode.asOf;
    return end > latest ? end : latest;
  }, episodes[0].lastActiveDay ?? episodes[0].asOf);
  const rows = antipyreticAdministrationRows(profileId, from, to);
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
