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
// ── IT IS THE FIRST WRITER IN THIS APP THAT STAMPS AN END IN THE PAST ────────
// Both other `finishWorkoutSession` callers take the tap's own instant, and the
// safety-tier post-workout dose delivery was built on that: it fires when presence
// reads `finished`, which is bounded by `FINISHED_WINDOW_MIN`. So this sweep runs
// BEFORE that dispatch on the tick (`lib/notifications/tick.ts`, pinned by
// lib/__tests__/detected-finish-tick-order.test.ts) — after it, every detected finish
// was already outside the window and the dose reminder and the #924 recap were silenced
// for every session this feature ever finished. A detected end genuinely older than the
// window is still declined, and that is right: a post-workout reminder for a session
// that ended yesterday is not a reminder, and `isPostWorkoutReady` still opens the item
// at the scheduled slot.
//
// ── IT WRITES AND SAYS NOTHING, AND THAT IS #5291 ───────────────────────────
// #5194's AC asks the finish to SEND, carrying time-correction chips so a wrong end is
// one tap to move. This sweep does not, and the cost is not only silence: a finished
// row is no longer `active`, so the stale suggest that used to carry Finish/Discard
// stops reaching it — the sweep takes away the one message a person could have argued
// with. Filed as #5291 rather than bolted on here, because the chip family it belongs
// to (`lib/notifications/telegram-time-correction.ts`) corrects a burst of ledger rows
// and this corrects one row's end, which is a design decision and not a wiring job.

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
//
// ── WHAT THIS COSTS PER TICK, STATED RATHER THAN UNDERSTATED ─────────────────
// A row with no trace at all costs ONE read: the sample gather returns nothing and the
// ten prior windows are never asked for. A CONTENT-BEARING open draft that has a trace
// but never yields an end pays the full gather every tick, forever — `expireWorkoutDrafts`
// only deletes zero-content husks, so nothing ages it out. That is real and it is not
// solved here: bounding it means remembering an answer across ticks, which is a
// different mechanism from this one. Said plainly because the first draft of this
// comment claimed the trace window was the cost bound, and the trace window bounds the
// SIZE of each read rather than how many times it happens.
// For those rows this changes nothing and the stale suggest is still the path. Giving
// `exercise_sets` an instant is a schema change and an owner decision (#5194, and the
// same absence blocked the rest timer on #5143); if it ever lands, the cancel below
// becomes a one-line swap and this paragraph retires.

import { db } from "./db";
import { parseUtcSql, shiftDateStr, zonedWallTimeToUtc } from "./date";
import { getTimezone } from "./settings/display";
import { detectedWorkoutEnd, type ExertionSample } from "./exertion-window";
import { finishWorkoutSession } from "./workout-finish";
import { isCompletedSessionRow } from "./workout-presence";
import { getHrInstantsInRange } from "./queries/metrics";
import {
  priorEventWindows,
  restingCeilingBpm,
  usualRecoveryMin,
} from "./queries/event-physiology";

/**
 * The trace, as INSTANTS, read as instants rather than reconstructed from local minutes
 * (#5212 falsifying pass, F3).
 *
 * The first draft of this took `getHrMinutesInRange`, which projects every stamp to the
 * profile's local minute (#2096's boundary rule), and resolved each local string back
 * through the zone. That round trip is not lossless and the loss is exactly the
 * quantity this module measures: in a FALL-BACK hour two stored instants carry the same
 * local minute, `zonedWallTimeToUtc` answers with the first of the two for both, and an
 * hour of readings collapses onto the hour before it. A person still lifting at 01:20
 * EST had their effort stacked onto the 00:20 EDT rest that preceded it, the sweep's
 * newest measured minute moved back an hour, and the earlier rest became the quiet that
 * "closed" a session still in progress — the one thing #5113's cancel exists to stop,
 * defeated because `updated_at` is a real instant while the candidate had been shifted.
 *
 * `getHrInstantsInRange` is the same window and the same one-source-per-day pick,
 * answered in the stored instants. Nothing is resolved, so nothing can collapse.
 */
function traceInstants(
  profileId: number,
  since: string,
  until: string
): ExertionSample[] {
  return getHrInstantsInRange(profileId, since, until).map((row) => ({
    at: row.at,
    bpm: row.bpm,
  }));
}

interface OpenWorkoutRow {
  id: number;
  type: string;
  date: string;
  start_time: string;
  updated_at: string | null;
  created_at: string | null;
}

/**
 * THE ROW'S SHAPE, NOT THE EDITOR'S MODE (#5212 falsifying pass, F1 and F2).
 *
 * The first draft asked `getWorkoutPresence` whether a session was `active`, which is
 * the dock's question: is there a live editor to render? That carries the workout
 * kind's own bounds with it, so a draft quiet past `EPISODE_BOUNDS.workout.abandonMin`
 * reads `idle` — and `updated_at` only moves forward, so past ninety minutes the row
 * became unreachable FOREVER. The forgotten workout this module opens with ("the person
 * leaves, the draft goes quiet for two hours") was the single case it could never serve,
 * and its own headline fixture sat one minute inside the bound.
 *
 * `active` also requires `row.date === today`, so a session started at 23:50 could not
 * be finished at any instant: before local midnight its closing quiet has not happened,
 * and after it the row is skipped for being yesterday's.
 *
 * Both dissolve into the same gate, and it is the one `detectedWorkoutEnd`'s own doc
 * already stated: "'Open' is the ROW's shape rather than the editor's mode". A start,
 * no end, no stored duration, and not imported — `isCompletedSessionRow`'s three
 * questions plus the source, exactly as `computeWorkoutPresence` asks them before it
 * applies any bound. Nothing here touches `EPISODE_BOUNDS`, which the dock and every
 * other reader still share.
 *
 * NO TIME BOUND ON THE QUERY, and that is the point rather than an omission: an open
 * draft is rare and a forgotten one is old by definition. The COST bound is the trace
 * window, one day per row, not the age of the row.
 */
function openWorkoutRows(profileId: number): OpenWorkoutRow[] {
  return (
    db
      .prepare(
        `SELECT id, type, date, start_time, duration_min, end_time, updated_at, created_at
           FROM activities
          WHERE profile_id = ?
            AND source IS NULL
            AND end_time IS NULL
            AND start_time IS NOT NULL
          ORDER BY date ASC, id ASC`
      )
      .all(profileId) as (OpenWorkoutRow & {
      end_time: string | null;
      duration_min: number | null;
    })[]
  ).filter((row) => !isCompletedSessionRow(row));
}

/**
 * Finish every open workout whose heart rate says it already ended.
 *
 * Returns how many rows were finished. Idempotent: a finished row is no longer
 * `active`, so a second pass sees nothing. Runs as housekeeping on every tick and is
 * deliberately NOT waking-gated — the session ended whether or not the person is awake,
 * and gating the write would make the recorded end depend on a sleep schedule.
 */
export function finishDetectedWorkouts(profileId: number): number {
  const tz = getTimezone(profileId);
  const ceiling = restingCeilingBpm(profileId);
  // No resting range of their own is no ceiling to compare against, and this module
  // refuses to invent one (#4775). The stale suggest still reaches the row.
  if (ceiling == null) return 0;

  let finished = 0;
  for (const row of openWorkoutRows(profileId)) {
    const startedAt = zonedWallTimeToUtc(tz, row.date, row.start_time);
    if (!startedAt) continue;

    // THE ROW'S OWN DAY AND THE ONE AFTER IT, and no further. A session that started at
    // 23:50 ends on the next profile-local day and the quiet that closes it is entirely
    // on that day, so one day is not enough — and two is never short, because a session
    // cannot cross two midnights and still be a session. The first draft read from the
    // row's day through TODAY, which was unbounded for a draft left open for a month:
    // the same answer, over a month of minute-resolution HR.
    const samples = traceInstants(
      profileId,
      row.date,
      shiftDateStr(row.date, 1)
    );
    // A BARE WRIST COSTS ONE READ, not eleven (#5212 review, the cost note). With no
    // trace there is no answer this module can give, and asking for it first means the
    // expensive part below — ten prior windows, each its own day-span HR read — never
    // runs for a profile that was never going to get an answer. An open draft with no
    // trace is otherwise permanent, so that cost would have recurred every tick forever.
    if (samples.length === 0) continue;

    const recovery = usualRecoveryMin(
      profileId,
      priorEventWindows(profileId, row.type, { date: row.date, id: row.id })
    );
    // THE WHOLE WINDOW, HANDED OVER WHOLE. Bounding it here was tried twice and each
    // bound had a neighbouring case it got wrong (#5289). `detectedWorkoutEnd` answers
    // one unambiguous shape and refuses everything else, which is a contract a caller
    // cannot improve on by feeding it a narrower slice — a slice is exactly how a second
    // effort stops being visible to the rule that refuses because of it. Two days go in.
    const end = detectedWorkoutEnd({
      samples,
      ceilingBpm: ceiling,
      usualRecoveryMin: recovery,
      startedAt: startedAt.getTime(),
      // The save stamp, read as the cancel — see the header for why it is not a set.
      lastSetAt:
        parseUtcSql(row.updated_at ?? row.created_at)?.getTime() ?? null,
    });
    if (end == null) continue;

    // THE SAME CORE THE TELEGRAM FINISH USES, handed the measured instant instead of
    // the tap's. It fills `duration_min` from start→end when none was stored, so the
    // finished session reads as completed everywhere presence, load and the recap look.
    if (
      finishWorkoutSession(profileId, row.id, new Date(end)).kind === "finished"
    )
      finished++;
  }
  return finished;
}
