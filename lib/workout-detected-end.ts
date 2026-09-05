// THE OPEN WORKOUT FINISHES ITSELF (issue #5194, reader 1 of #5113).
//
// A live workout ends only by hand. The app notices a forgotten one by CLOCK and late
// — a draft quiet past the workout kind's stale bound raises "Still working out?" and
// its Finish stamps `end_time` at the TAP instant. So a session that ended at 11:35 is
// offered a finish at 12:30 with 12:30 as its end, and the recovery, the zone split and
// the recap it feeds are all measured over an hour of sitting down.
//
// `detectedWorkoutEnd` (#5139, pure and mutation-tested) already holds the whole
// judgment. This is its database tier and nothing more: gather what that function
// takes, ask it, and when it answers hand the instant to the finish core the Telegram
// button already uses. NO NEW JUDGMENT about when a session ended is made here, and no
// new write path is minted — `finishWorkoutSession` has always taken the instant to
// stamp; nobody had ever passed it a measured one.
//
// ── THE TRACE DECIDES, NEVER THE CLOCK ───────────────────────────────────────
// With no HR minutes past the start, nothing happens and the stale suggest stays as the
// fallback for a bare wrist. A wrist that comes off mid-session reads as absence rather
// than as recovery, which the detector's own coverage gate already refuses.
//
// ── A REST IS NOT AN END, AND THE DATABASE CANNOT SAY IT EXACTLY ─────────────
// The detector takes `lastSetAt` — "the newest set's instant on this row" — because a
// set logged after the candidate minute proves the session had not ended there.
// `exercise_sets` carries NO timestamp of any kind (`001-baseline.ts`): a set records
// what was lifted, never when it was recorded. So that parameter has no source.
//
// What the row does carry is `updated_at`, the auto-save stamp that bumps on every
// debounced save while sets are added (#451) and the same signal `computeWorkoutPresence`
// reads as liveness. The cancel here is therefore "no SAVE since the candidate minute"
// rather than "no SET since it". That is STRICTER, never looser: every set write bumps
// the stamp, and so does every other edit, so this can never finish a session a set
// would have saved — which is the direction the honesty rule cares about.
//
// The cost is the opposite case and it is worth stating plainly: someone who fixes a
// title at 11:50, after an effort that ended at 11:35, gets no detected end. And that
// refusal is PERMANENT rather than delayed, because `updated_at` only moves forward.
// For those rows this changes nothing and the stale suggest is still the path. Giving
// `exercise_sets` an instant is a schema change and an owner decision (#5194, and the
// same absence blocked the rest timer on #5143); if it ever lands, the cancel below
// becomes a one-line swap and this paragraph retires.

import { db, today } from "./db";
import { now as clockNow } from "./clock";
import { parseUtcSql, zonedWallTimeToUtc } from "./date";
import { getTimezone } from "./settings/display";
import { detectedWorkoutEnd, type ExertionSample } from "./exertion-window";
import { finishWorkoutSession } from "./workout-finish";
import { getWorkoutPresence } from "./queries/presence";
import { getHrMinutesInRange } from "./queries/metrics";
import {
  priorEventWindows,
  restingCeilingBpm,
  usualRecoveryMin,
} from "./queries/event-physiology";

/**
 * The trace, as INSTANTS. `getHrMinutesInRange` projects every stamp to the profile's
 * local minute before returning it (#2096's boundary rule), and the detector measures
 * real elapsed spans — so each local minute is resolved back through the zone rather
 * than read as if it were UTC. Across a DST jump those two readings differ by an hour,
 * and the quiet stretch that closes a span is exactly the quantity that would be wrong.
 */
function traceInstants(
  profileId: number,
  tz: string,
  since: string,
  until: string
): ExertionSample[] {
  const out: ExertionSample[] = [];
  for (const row of getHrMinutesInRange(profileId, since, until)) {
    const [day, clock] = row.ts.split("T");
    const at = zonedWallTimeToUtc(tz, day, clock);
    if (at) out.push({ at: at.getTime(), bpm: row.bpm });
  }
  return out;
}

/**
 * Finish every open workout whose heart rate says it already ended.
 *
 * Returns how many rows were finished. Idempotent: a finished row is no longer
 * `active`, so a second pass sees nothing. Runs as housekeeping on every tick and is
 * deliberately NOT waking-gated — the session ended whether or not the person is awake,
 * and gating the write would make the recorded end depend on a sleep schedule.
 */
export function finishDetectedWorkouts(
  profileId: number,
  now: Date = clockNow()
): number {
  const presence = getWorkoutPresence(profileId, now);
  if (presence.state !== "active" || presence.activityId == null) return 0;

  const row = db
    .prepare(
      `SELECT id, type, date, start_time, updated_at, created_at
         FROM activities WHERE id = ? AND profile_id = ?`
    )
    .get(presence.activityId, profileId) as
    | {
        id: number;
        type: string;
        date: string;
        start_time: string | null;
        updated_at: string | null;
        created_at: string | null;
      }
    | undefined;
  if (!row || !row.start_time) return 0;

  const tz = getTimezone(profileId);
  const ceiling = restingCeilingBpm(profileId);
  // No resting range of their own is no ceiling to compare against, and this module
  // refuses to invent one (#4775). The stale suggest still reaches the row.
  if (ceiling == null) return 0;

  const startedAt = zonedWallTimeToUtc(tz, row.date, row.start_time);
  if (!startedAt) return 0;

  const end = detectedWorkoutEnd({
    // FROM THE ROW'S OWN DAY THROUGH TODAY, not through the row's day. A session that
    // started at 23:50 ends on the next profile-local day, and the quiet that closes it
    // is entirely on that day — asking only for the start day would hand the detector a
    // trace that stops before the answer.
    samples: traceInstants(profileId, tz, row.date, today(profileId)),
    ceilingBpm: ceiling,
    usualRecoveryMin: usualRecoveryMin(
      profileId,
      priorEventWindows(profileId, row.type, { date: row.date, id: row.id })
    ),
    startedAt: startedAt.getTime(),
    // The save stamp, read as the cancel — see the header for why it is not a set.
    lastSetAt: parseUtcSql(row.updated_at ?? row.created_at)?.getTime() ?? null,
  });
  if (end == null) return 0;

  // THE SAME CORE THE TELEGRAM FINISH USES, handed the measured instant instead of the
  // tap's. It fills `duration_min` from start→end when none was stored, so the finished
  // session reads as completed everywhere presence, load and the recap look.
  return finishWorkoutSession(profileId, row.id, new Date(end)).kind ===
    "finished"
    ? 1
    : 0;
}
