// The GATHER for the sleep clock-skew detector (issue #4299).
//
// Pairs each SYNCED sleep session with the `hr_minutes` the same database already holds
// across it, and hands both to the one pure judgement in lib/sleep-clock-skew.ts. This
// layer opens the database and nothing else: it chooses no threshold, compares no
// bedtimes, and reads no timezone history to decide anything.
//
// TWO READS, BOTH RAW UTC. Every other hr_minutes reader in lib/queries/metrics.ts
// PROJECTS its rows to a profile-local minute stamp on the way out (#2205), because its
// consumers compare them against local wall clocks. This one must not: it compares HR
// against `metric_samples.started_at`/`ended_at`, which are the source's own absolute
// instants, and projecting one side of an instant-to-instant comparison would introduce
// exactly the confusion the whole issue is about.
//
// SYNCED ONLY, SPELLED THE WAY THIS REPO SPELLS IT. A manual duration-only row stores
// `${date}T00:00:00` — a profile-local day midnight wearing an instant's shape
// (docs/internals/time-columns.md) — so it is not an instant to contradict, and its
// author is the person reading the hedge. `source <> 'manual'` is the filter
// `getSyncedSleepWakeDays` and `getSyncedSleepSources` already use for this exact
// question; `source IS NOT NULL` would have been the obvious guess and would have let
// every hand-logged night through, because manual rows carry the literal source
// 'manual' rather than a NULL. (SQL's NULL-unsafe `<>` also drops a NULL-source row,
// which is the same answer those two readers give.)

import { db } from "../db";
import { utcInstant } from "../date";
import { cache } from "../request-cache";
import { getTravelSwitches } from "../settings/travel";
import {
  detectSleepClockSkew,
  type HrMinuteSample,
  type SleepClockSkew,
} from "../sleep-clock-skew";
import { mainSleepPeriod } from "../sleep-regularity";

// How far back the detector looks. The Sleep log's own display window (#2556's
// SLEEP_MOOD_HISTORY_DAYS is 60) is the surface that offers the repair, so a suspect
// night the log still lists must still be judgeable.
export const SLEEP_SKEW_HISTORY_DAYS = 60;

// How much of the surrounding day to fetch either side of a claimed session. It must
// cover the pure module's own search radius; anything more is rows the judgement cannot
// reach.
const HR_CONTEXT_HOURS = 13;

export interface SuspectSleepSession {
  /** The `metric_samples` row id — the identity the repair's delete target names. */
  sampleId: number;
  /** The stored wake-day the Sleep log and the dashboard key their rows on. */
  wakeDay: string;
  source: string;
  evidence: SleepClockSkew;
  /**
   * Whether a recorded timezone switch sits within a day of the claimed session.
   *
   * WORDING ONLY (#4299). It is read AFTER the detection above has already returned
   * evidence, never as an input to it, so it cannot make a session suspect and cannot
   * fire on its own — which is the whole reason a real jet-lag week does not flag.
   */
  nearTimezoneSwitch: boolean;
}

interface SyncedSessionRow {
  id: number;
  date: string;
  started_at: string;
  ended_at: string;
  source: string;
  /** Provider-reported minutes asleep, which the shared classifier prefers over the
   *  window when a source reports both (Oura/Withings include awake time in the
   *  window). Selected only so `mainSleepPeriod` here decides exactly as it does
   *  everywhere else. */
  value: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The samples of a `ts`-sorted trace inside `[from, to)`, by binary search.
 *
 * Both bounds are canonical instants, and so is every stored `ts`, so the ordering the
 * search relies on is the SAME lexicographic order the SQL `ORDER BY ts` produced —
 * this is not a second sort convention, it is the one the query already used.
 */
function sliceByTs(
  samples: readonly HrMinuteSample[],
  from: string,
  to: string
): readonly HrMinuteSample[] {
  const lowerBound = (bound: string) => {
    let lo = 0;
    let hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].ts < bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return samples.slice(lowerBound(from), lowerBound(to));
}

function suspectSleepSessionsUncached(
  profileId: number,
  since: string
): SuspectSleepSession[] {
  const sessions = db
    .prepare(
      `SELECT id, date, started_at, ended_at, source, value
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
          AND source <> 'manual'
          AND date >= ?
          AND julianday(ended_at) > julianday(started_at)
        ORDER BY ended_at DESC`
    )
    .all(profileId, since) as SyncedSessionRow[];
  if (sessions.length === 0) return [];

  // THE NIGHT, NOT EVERY SESSION (#5019).
  //
  // The judgement below asks whether a claimed window disagrees with the surrounding
  // day's heart rate, and for a DAYTIME NAP the surrounding day always contains the
  // overnight trough. A person napping runs above their own overnight trough by
  // definition, so every nap of any length reads as a contradiction — measured on prod:
  // a 68-minute nap at 17:41Z flagged at median 67 against the 07:26Z trough's 55, on a
  // day whose actual night was fine.
  //
  // So this asks the question of the wake day's MAIN session only. `mainSleepPeriod` is
  // the shared classifier (#1118/#1191) the nap-aware readers already use, taken here
  // rather than re-derived so the skew judge and the nap classifier cannot disagree
  // about which row is the night. The grouping key is the STORED wake day, which is the
  // same column `SuspectSleepSession.wakeDay` carries and the same one every consumer
  // keys its hedge on — so at most one suspect per day comes out of here BY
  // CONSTRUCTION, and the Map in lib/queries/sleep.ts can no longer be a race between
  // two rows for one day's hedge.
  //
  // A fragmented night is judged through its representative member, which is the row a
  // repair would name; the other members carry the same claim and the same clock.
  //
  // A WAKE DAY WHOSE ONLY SYNCED ROW IS A NAP still has that nap judged, and against
  // the surrounding day's trough exactly as before. `mainSleepSession` elects the
  // longest candidate, and nothing in the repo supplies `SleepSession.type`, so the
  // provider-labeled-nap arm of `candidateSessions` never fires and a lone nap IS the
  // day's main session. That is strictly better than judging every nap on every day
  // and it is a much smaller class, but it is not nothing, and naming it here is
  // cheaper than someone re-deriving it from a surprising hedge.
  const byWakeDay = new Map<string, SyncedSessionRow[]>();
  for (const row of sessions) {
    const day = byWakeDay.get(row.date);
    if (day) day.push(row);
    else byWakeDay.set(row.date, [row]);
  }
  const nights: SyncedSessionRow[] = [];
  for (const day of byWakeDay.values()) {
    const period = mainSleepPeriod(
      day.map((row) => ({
        start: row.started_at,
        end: row.ended_at,
        value: row.value ?? undefined,
        date: row.date,
        source: row.source,
        row,
      }))
    );
    if (period) nights.push(period.main.row);
  }
  if (nights.length === 0) return [];

  // ONE HR read for the whole judged span, not one per night.
  //
  // The per-session read this replaced cost a statement PER NIGHT, and a profile with a
  // synced night every day pays that on every dashboard render: the query-budget
  // baseline in lib/__db_tests__/dashboard-placement-manifest.test.ts measured the
  // biohacker persona at +33 statements before this change and +2 after. The union of
  // the per-session context windows is contiguous once nights are consecutive, so
  // fetching them separately was buying nothing but round trips.
  //
  // The SLICE still has to be per session — `detectSleepClockSkew` steps a
  // session-width window across its own ±12h and would otherwise walk the whole span
  // for every step. `sliceByTs` does that with two binary searches on the sorted `ts`,
  // so each night is handed exactly the minutes it can reach.
  const context = HR_CONTEXT_HOURS * 60 * 60 * 1000;
  const spans = nights.map((row) => ({
    start: Date.parse(row.started_at),
    end: Date.parse(row.ended_at),
  }));
  const usable = spans.filter(
    (s) => Number.isFinite(s.start) && Number.isFinite(s.end)
  );
  if (usable.length === 0) return [];
  // Bound in the CANONICAL instant shape, not a bare toISOString(): `hr_minutes.ts`
  // stores `YYYY-MM-DDTHH:MM:SSZ`, the comparison is a string comparison, and a
  // millisecond-bearing bound sorts either side of the same instant depending on which
  // end of the range it is.
  const hr = db
    .prepare(
      `SELECT ts, bpm FROM hr_minutes
        WHERE profile_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts`
    )
    .all(
      profileId,
      utcInstant(new Date(Math.min(...usable.map((s) => s.start)) - context)),
      utcInstant(new Date(Math.max(...usable.map((s) => s.end)) + context))
    ) as HrMinuteSample[];
  if (hr.length === 0) return [];
  const switches = getTravelSwitches(profileId);

  return nights.flatMap((row) => {
    const start = Date.parse(row.started_at);
    const end = Date.parse(row.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    const evidence = detectSleepClockSkew(
      { start: row.started_at, end: row.ended_at },
      sliceByTs(
        hr,
        utcInstant(new Date(start - context)),
        utcInstant(new Date(end + context))
      )
    );
    if (!evidence) return [];
    return [
      {
        sampleId: row.id,
        wakeDay: row.date,
        source: row.source,
        evidence,
        nearTimezoneSwitch: switches.some((s) => {
          const at = Date.parse(s.at);
          return (
            Number.isFinite(at) && at >= start - DAY_MS && at <= end + DAY_MS
          );
        }),
      },
    ];
  });
}

/**
 * Every synced sleep session on or after `since` whose stored instants disagree with
 * the heart rate recorded across them. Empty on a profile with no HR trace, which is
 * the ordinary case and deliberately not an error state.
 */
export const getSuspectSleepSessions = cache(suspectSleepSessionsUncached);

/**
 * The wake-days carrying a suspect session, for the surfaces that only need to know
 * whether to hedge a row rather than what the evidence was.
 */
export function getSuspectSleepWakeDays(
  profileId: number,
  since: string
): Set<string> {
  return new Set(
    getSuspectSleepSessions(profileId, since).map((s) => s.wakeDay)
  );
}

/**
 * Is THIS wake-day's synced session suspect?
 *
 * The narrow read for a surface that states ONE night — the dashboard's last-night
 * bed/wake row. `since` is the day itself, so the gather's `date >= ?` bound reduces the
 * scan to that night and any later one rather than walking the whole history to answer a
 * question about a single row.
 */
export function isSuspectSleepWakeDay(
  profileId: number,
  wakeDay: string
): boolean {
  return getSuspectSleepWakeDays(profileId, wakeDay).has(wakeDay);
}
