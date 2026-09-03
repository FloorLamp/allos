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
}

const DAY_MS = 24 * 60 * 60 * 1000;

function suspectSleepSessionsUncached(
  profileId: number,
  since: string
): SuspectSleepSession[] {
  const sessions = db
    .prepare(
      `SELECT id, date, started_at, ended_at, source
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
          AND source <> 'manual'
          AND date >= ?
          AND julianday(ended_at) > julianday(started_at)
        ORDER BY ended_at DESC`
    )
    .all(profileId, since) as SyncedSessionRow[];
  if (sessions.length === 0) return [];

  const hrInWindow = db.prepare(
    `SELECT ts, bpm FROM hr_minutes
      WHERE profile_id = ? AND ts >= ? AND ts < ?
      ORDER BY ts`
  );
  const switches = getTravelSwitches(profileId);

  return sessions.flatMap((row) => {
    const start = Date.parse(row.started_at);
    const end = Date.parse(row.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    const context = HR_CONTEXT_HOURS * 60 * 60 * 1000;
    // Bound in the CANONICAL instant shape, not a bare toISOString(): `hr_minutes.ts`
    // stores `YYYY-MM-DDTHH:MM:SSZ`, the comparison is a string comparison, and a
    // millisecond-bearing bound sorts either side of the same instant depending on
    // which end of the range it is.
    const hr = hrInWindow.all(
      profileId,
      utcInstant(new Date(start - context)),
      utcInstant(new Date(end + context))
    ) as HrMinuteSample[];
    const evidence = detectSleepClockSkew(
      { start: row.started_at, end: row.ended_at },
      hr
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
