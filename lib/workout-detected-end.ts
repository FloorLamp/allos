// THE DETECTOR PROPOSES, THE PERSON DISPOSES (issue #5194, reader 1 of #5113).
//
// A live workout ends only by hand, and the app notices a forgotten one by CLOCK and
// late — a draft quiet past the workout kind's stale bound raises "Still working out?"
// and its Finish stamps `end_time` at the TAP instant. So a session that ended at 11:35
// is offered a finish at 12:30 with 12:30 as its end, and the recovery, the zone split
// and the recap it feeds are all measured over an hour of sitting down.
//
// `detectedWorkoutEnd` (#5139, pure and mutation-tested) already holds the whole
// judgment about when an effort ended. This is its database tier and NOTHING MORE: it
// gathers what that function takes, asks it, and hands back the instant. It WRITES
// NOTHING, and neither reader writes without a person's tap — the owner's 2026-09-06
// ruling, after seven falsifying passes on the unattended version. Every one of those
// was harmful only because a sweep wrote: a wrong finish flipped presence to
// `finished`, fired the safety-tier post-workout dose reminder mid-workout, and removed
// the stale suggest's Finish/Discard, the one message the person could have argued
// with. Removing the write retires the class rather than moving it to the next input,
// and a wrong answer is now a wrong sentence in a message. What that costs, accepted
// knowingly in the ruling: the automaticity — a forgotten workout stays wrong until the
// person acts on the suggestion.
//
// ── THE TRACE DECIDES, NEVER THE CLOCK ───────────────────────────────────────
// With no HR minutes past the start there is no proposal, the nudge says what it always
// said, and a tap stamps its own instant as it always did. A wrist that comes off
// mid-session reads as absence rather than as recovery, which the detector's own
// coverage gate already refuses. Nothing here takes a clock at all.
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
// the stamp, and so does every other edit, so this can never propose an end a set would
// have contradicted — which is the direction the honesty rule cares about.
//
// The cost is the opposite case and it is worth stating plainly: someone who fixes a
// title at 11:50, after an effort that ended at 11:35, gets no proposal. And that
// refusal is PERMANENT rather than delayed, because `updated_at` only moves forward.
// For those rows this changes nothing and the tap's own instant is still the end.
// Giving `exercise_sets` an instant is a schema change and an owner decision (#5194,
// and the same absence blocked the rest timer on #5143); if it ever lands, the cancel
// below becomes a one-line swap and this paragraph retires.

import { db } from "./db";
import { parseUtcSql, shiftDateStr, zonedWallTimeToUtc } from "./date";
import { getTimezone } from "./settings/display";
import { detectedWorkoutEnd, type ExertionSample } from "./exertion-window";
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
 * EST had their effort stacked onto the 00:20 EDT rest that preceded it, the newest
 * measured minute moved back an hour, and the earlier rest became the quiet that
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
  end_time: string | null;
  duration_min: number | null;
  updated_at: string | null;
  created_at: string | null;
}

/**
 * THE ROW'S SHAPE, NOT THE EDITOR'S MODE (#5212 falsifying pass, F1 and F2).
 *
 * The first draft asked `getWorkoutPresence` whether a session was `active` — the
 * dock's question, which carries the workout kind's own bounds with it. Past
 * `EPISODE_BOUNDS.workout.abandonMin` a draft reads `idle`, and `updated_at` only moves
 * forward, so at ninety-one minutes of quiet the row was unreachable FOREVER: the
 * forgotten workout this module opens with was the single case it could never serve.
 * `active` also requires `row.date === today`, which no session started at 23:50 can
 * satisfy while its closing quiet is being measured.
 *
 * Both dissolve into the gate `detectedWorkoutEnd`'s own doc already stated: "'Open' is
 * the ROW's shape rather than the editor's mode" — `isCompletedSessionRow`'s three
 * questions plus the source. Nothing here touches `EPISODE_BOUNDS`, which the dock and
 * every other reader still share. (The NUDGE that quotes this answer has the dock's
 * bounds of its own; a row past them is reached by opening the workout instead.)
 */
function openWorkoutRow(
  profileId: number,
  activityId: number
): OpenWorkoutRow | null {
  const row = db
    .prepare(
      `SELECT id, type, date, start_time, end_time, duration_min, updated_at, created_at
         FROM activities
        WHERE id = ? AND profile_id = ? AND source IS NULL AND start_time IS NOT NULL`
    )
    .get(activityId, profileId) as OpenWorkoutRow | undefined;
  if (!row || isCompletedSessionRow(row)) return null;
  return row;
}

/**
 * The END this open row should adopt, or null when the trace does not say.
 *
 * Read-only, and safe to ask on any tick: with no trace it costs one query. The answer
 * is a PROPOSAL — the two callers are the nudge that shows it and the finish core that
 * stamps it when a person taps.
 */
export function detectedWorkoutEndAt(
  profileId: number,
  activityId: number
): Date | null {
  const row = openWorkoutRow(profileId, activityId);
  if (!row) return null;

  // No resting range of their own is no ceiling to compare against, and this module
  // refuses to invent one (#4775).
  const ceiling = restingCeilingBpm(profileId);
  if (ceiling == null) return null;

  const tz = getTimezone(profileId);
  const startedAt = zonedWallTimeToUtc(tz, row.date, row.start_time);
  if (!startedAt) return null;

  // THE ROW'S OWN DAY AND THE ONE AFTER IT, and no further. A session that started at
  // 23:50 ends on the next profile-local day and the quiet that closes it is entirely
  // on that day, so one day is not enough — and two is never short, because a session
  // cannot cross two midnights and still be a session. The first draft read from the
  // row's day through TODAY, which was unbounded for a draft left open for a month:
  // the same answer, over a month of minute-resolution HR.
  const samples = traceInstants(profileId, row.date, shiftDateStr(row.date, 1));
  // A BARE WRIST COSTS ONE READ, not eleven (#5212 review, the cost note). With no
  // trace there is no answer this module can give, and asking for it first means the
  // expensive part below — ten prior windows, each its own day-span HR read — never
  // runs for a profile that was never going to get an answer.
  if (samples.length === 0) return null;

  // THE WHOLE WINDOW, HANDED OVER WHOLE. Bounding it here was tried twice and each
  // bound had a neighbouring case it got wrong (#5289). `detectedWorkoutEnd` answers
  // one unambiguous shape and refuses everything else, which is a contract a caller
  // cannot improve on by feeding it a narrower slice — a slice is exactly how a second
  // effort stops being visible to the rule that refuses because of it. Two days go in.
  const end = detectedWorkoutEnd({
    samples,
    ceilingBpm: ceiling,
    usualRecoveryMin: usualRecoveryMin(
      profileId,
      priorEventWindows(profileId, row.type, { date: row.date, id: row.id })
    ),
    startedAt: startedAt.getTime(),
    // The save stamp, read as the cancel — see the header for why it is not a set.
    lastSetAt: parseUtcSql(row.updated_at ?? row.created_at)?.getTime() ?? null,
  });
  return end == null ? null : new Date(end);
}
