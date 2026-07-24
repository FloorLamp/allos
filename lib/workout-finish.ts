// The shared, auth-blind, id-keyed workout-FINISH write core (issues #1124 / #1205,
// #221). The live-panel Finish (in-app) and the plain-form Finish (#1124) persist
// through the form's auto-save; this headless core is what the OFF-app entrypoints
// use — the "Still working out?" Telegram nudge's Finish button (#1205) — and any
// future programmatic finish, so every finish path stamps end the SAME way and can't
// diverge. profileId-first, no lib/auth import (the calling Server Action / callback
// handler owns the auth + cross-profile gate); every statement is profile-scoped.
//
// "Finish" = stamp `end_time = now` (profile-local wall clock) on the persisted live
// draft, filling `duration_min` (active minutes) from the start→now span when it was
// still null, so the finished session reads as completed everywhere (presence, load,
// the post-workout dose dispatch). Idempotent + low-risk: a re-tap on an
// already-finished session is a no-op, and a stale draft (quiet by definition, #560)
// has no live client edits to race (#467). Every caller answers from the typed
// outcome union — never an unconditional confirm.

import { db, writeTx } from "./db";
import { now as clockNow } from "./clock";
import { zonedDateParts } from "./date";
import { minutesBetween } from "./activity-meta";
import { getTimezone } from "./settings/display";
import { parseComponents } from "./types/training";

export type FinishWorkoutOutcome =
  | { kind: "finished"; activityId: number }
  | { kind: "already-finished"; activityId: number }
  | { kind: "empty-draft"; activityId: number }
  | { kind: "not-found" };

export type DiscardWorkoutOutcome =
  | { kind: "discarded"; activityId: number }
  | { kind: "already-finished"; activityId: number }
  | { kind: "not-found" };

interface DraftRow {
  id: number;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  components: string | null;
  source: string | null;
}

function loadDraft(profileId: number, activityId: number): DraftRow | null {
  const row = db
    .prepare(
      `SELECT id, start_time, end_time, duration_min, components, source
         FROM activities WHERE id = ? AND profile_id = ?`
    )
    .get(activityId, profileId) as DraftRow | undefined;
  return row ?? null;
}

// Whether the draft has any logged content — at least one set or one component.
// A finish must never turn an empty started-but-nothing-logged draft into a
// 0-content activity (#1205 §4): that path returns `empty-draft` (Discard instead).
function hasLoggedContent(row: DraftRow): boolean {
  const setCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM exercise_sets WHERE activity_id = ?")
      .get(row.id) as { c: number }
  ).c;
  return setCount > 0 || parseComponents(row.components).length > 0;
}

// Stamp end = now on a live draft. See the file header for the contract.
export function finishWorkoutSession(
  profileId: number,
  activityId: number,
  now: Date = clockNow()
): FinishWorkoutOutcome {
  const row = loadDraft(profileId, activityId);
  // A missing row, or a source-owned import (never a live in-app draft), is not
  // finishable here — the stale nudge only fires for manual/live sessions anyway.
  if (!row || row.source) return { kind: "not-found" };
  if (row.end_time) return { kind: "already-finished", activityId };
  if (!hasLoggedContent(row)) return { kind: "empty-draft", activityId };

  const tz = getTimezone(profileId);
  const { hhmm } = zonedDateParts(tz, now);
  // Active minutes: fill from the start→now span only when none is stored yet
  // (a strength session's session-total). Never overwrite a value the logger set.
  const duration =
    row.duration_min ??
    (row.start_time ? minutesBetween(row.start_time, hhmm) : null);
  writeTx(() => {
    db.prepare(
      `UPDATE activities
         SET end_time = ?, duration_min = ?, updated_at = datetime('now')
       WHERE id = ? AND profile_id = ?`
    ).run(hhmm, duration, activityId, profileId);
  });
  return { kind: "finished", activityId };
}

// Discard a live draft (#1205 §4): delete the started-but-abandoned session and its
// sets. Refuses a finished session (nothing to discard) and a foreign/absent id.
export function discardWorkoutSession(
  profileId: number,
  activityId: number
): DiscardWorkoutOutcome {
  const row = loadDraft(profileId, activityId);
  if (!row || row.source) return { kind: "not-found" };
  if (row.end_time) return { kind: "already-finished", activityId };
  writeTx(() => {
    db.prepare("DELETE FROM exercise_sets WHERE activity_id = ?").run(
      activityId
    );
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      activityId,
      profileId
    );
  });
  return { kind: "discarded", activityId };
}
