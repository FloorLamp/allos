// Derived workout presence (issue #921) — the ONE computation that answers
// "is this profile mid-workout / just finished / neither" from EXISTING rows,
// with no new tables. Every consumer (the app-wide minimized dock, the
// finish-triggered post-workout nudge, the stale-session suggest, the household
// chip, and the rest-coaching tense) is a formatter/policy over this result
// (#221 one-question-one-computation).
//
// The signals, all already on the `activities` row:
//   - `start_time` / `end_time`  — HH:MM wall clock in the profile's timezone on
//     the row's `date`; end_time is NULL while a live session is unfinished.
//   - `updated_at`               — the #451 auto-save timestamp (UTC), bumped on
//     every debounced save while the session is being logged. This is the
//     LIVENESS signal: a live session touches it every set; a saved-and-left row
//     goes quiet. NULL on a freshly INSERTed row (its first save), so we fall
//     back to `created_at`.
//   - `created_at`               — UTC instant the row was first written. For an
//     IMPORTED row this is the sync/first-seen time — the freshness anchor.
//   - `source`                   — NULL for a manually-logged/live session, set
//     for an integration import (Strava / Health Connect / …).
//
// Pure (Intl only, via lib/date's zone helpers) so the whole state matrix is
// unit-testable without a DB. The DB gather (getWorkoutPresence) lives in
// lib/queries and simply feeds candidate rows to computeWorkoutPresence.

import { parseUtcSql, zonedWallTimeToUtc } from "./date";
import type { ActivityType } from "./types/training";

// --- Window constants (documented; the boundary tests pin each edge). ---

// A session counts as `finished` while its end instant is within this trailing
// window. Also the guarantee that the hourly notify tick observes every finish
// exactly once: any moment is at most ~59 min from the next hourly tick, so a
// 60-min window always contains a tick within it.
export const FINISHED_WINDOW_MIN = 60;

// Freshness cap for IMPORTED finishes: an integration row must ALSO have been
// first-seen (created_at) within this window to read as just-finished. A delayed
// bulk sync about this morning's run (end instant already outside the finished
// window) is rejected by the window; this is the belt-and-suspenders guard for a
// row whose end instant looks recent but whose sync landed long ago.
export const IMPORT_FRESHNESS_MIN = 60;

// An `active` session whose draft has gone quiet for at least this long is
// flagged `stale` — the "Still working out? Finish or discard?" suggest (#560).
// A genuine live session bumps its auto-save every set (minutes apart), so this
// much silence means it's very likely done or abandoned. Suggest-only: presence
// NEVER auto-ends a session.
export const STALE_MIN = 45;

// Liveness cap: an unfinished session (no end_time) whose draft has been quiet
// longer than this is treated as abandoned and drops to `idle`, so a draft left
// open all day (or a quick manual log that was never marked done) doesn't hold
// the dock forever. Must be > STALE_MIN so `stale` is an observable sub-state of
// `active` (the hourly stale-suggest tick fires in the STALE_MIN..this window).
export const ACTIVE_MAX_QUIET_MIN = 90;

// Small tolerance for a finish/end instant that reads slightly in the future
// (clock skew, or an end time rounded up past `now`) — still "just finished".
const FUTURE_SKEW_MIN = 5;

export type WorkoutPresenceState = "idle" | "active" | "finished";

export interface WorkoutPresence {
  state: WorkoutPresenceState;
  // The activity the state is about (the live session, or the just-finished one);
  // null when idle. Id-keyed, so a marker/finding built on it is #203-safe.
  activityId: number | null;
  activityType: ActivityType | null;
  title: string | null;
  // active: minutes elapsed since start_time; finished: minutes since end_time;
  // idle: 0. Clamped to >= 0.
  sinceMin: number;
  // active AND the draft has been quiet >= STALE_MIN — drives the stale-suggest.
  stale: boolean;
}

// The subset of an activity row the presence derivation reads. `getWorkoutPresence`
// maps DB rows to this; tests construct it directly.
export interface PresenceActivityRow {
  id: number;
  type: ActivityType;
  title: string;
  date: string; // YYYY-MM-DD in the profile timezone
  start_time: string | null; // HH:MM
  end_time: string | null; // HH:MM
  duration_min: number | null;
  created_at: string | null; // UTC sql ("YYYY-MM-DD HH:MM:SS")
  updated_at: string | null; // UTC sql; NULL until the first update
  source: string | null; // NULL = manual/live; set = imported
}

const IDLE: WorkoutPresence = {
  state: "idle",
  activityId: null,
  activityType: null,
  title: null,
  sinceMin: 0,
  stale: false,
};

// The last time the row's draft was touched — the #451 auto-save timestamp, with
// created_at as the fallback for a row that's only been INSERTed once.
function lastTouchMs(row: PresenceActivityRow): number | null {
  const t = parseUtcSql(row.updated_at) ?? parseUtcSql(row.created_at);
  return t ? t.getTime() : null;
}

// The instant a finished session ended: the end wall time on its date, else the
// start wall time plus its logged duration. Returns null when neither is known —
// an end-less, duration-less import has no reliable end, so it is NOT treated as
// finished (the scheduled slot remains its fallback) rather than guessed.
function endInstantMs(row: PresenceActivityRow, tz: string): number | null {
  if (row.end_time)
    return zonedWallTimeToUtc(tz, row.date, row.end_time).getTime();
  if (row.start_time && row.duration_min != null && row.duration_min > 0)
    return (
      zonedWallTimeToUtc(tz, row.date, row.start_time).getTime() +
      row.duration_min * 60_000
    );
  return null;
}

export function computeWorkoutPresence(
  rows: PresenceActivityRow[],
  now: Date,
  tz: string,
  today: string
): WorkoutPresence {
  const nowMs = now.getTime();

  // --- active: today's started-but-unended session, draft touched recently. ---
  let active: { row: PresenceActivityRow; touch: number; quietMin: number } | null =
    null;
  for (const row of rows) {
    if (row.date !== today) continue;
    // Only a manually-logged in-app session can be LIVE. An imported row is a
    // completed activity (it can be `finished`, never `active`) even if the
    // provider gave it no end_time.
    if (row.source) continue;
    if (!row.start_time || row.end_time) continue;
    const touch = lastTouchMs(row);
    if (touch == null) continue;
    const quietMin = (nowMs - touch) / 60_000;
    if (quietMin > ACTIVE_MAX_QUIET_MIN) continue; // abandoned draft → idle
    // Most recently touched wins when two drafts are somehow open.
    if (!active || touch > active.touch)
      active = { row, touch, quietMin: Math.max(0, quietMin) };
  }
  if (active) {
    const startMs = zonedWallTimeToUtc(
      tz,
      active.row.date,
      active.row.start_time!
    ).getTime();
    return {
      state: "active",
      activityId: active.row.id,
      activityType: active.row.type,
      title: active.row.title,
      sinceMin: Math.max(0, Math.round((nowMs - startMs) / 60_000)),
      stale: active.quietMin >= STALE_MIN,
    };
  }

  // --- finished: an end instant inside the trailing window (imports also
  //     freshness-capped on first-seen). ---
  let finished: { row: PresenceActivityRow; endMs: number } | null = null;
  for (const row of rows) {
    const endMs = endInstantMs(row, tz);
    if (endMs == null) continue;
    const ageMin = (nowMs - endMs) / 60_000;
    if (ageMin < -FUTURE_SKEW_MIN || ageMin > FINISHED_WINDOW_MIN) continue;
    if (row.source) {
      const firstSeen = parseUtcSql(row.created_at);
      if (!firstSeen) continue;
      if ((nowMs - firstSeen.getTime()) / 60_000 > IMPORT_FRESHNESS_MIN)
        continue;
    }
    if (!finished || endMs > finished.endMs) finished = { row, endMs };
  }
  if (finished) {
    return {
      state: "finished",
      activityId: finished.row.id,
      activityType: finished.row.type,
      title: finished.row.title,
      sinceMin: Math.max(0, Math.round((nowMs - finished.endMs) / 60_000)),
      stale: false,
    };
  }

  return IDLE;
}
