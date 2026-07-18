// Auth-blind write core for the food-group serving log (issues #579, #682). Takes
// profileId first and never imports lib/auth — the profileId-first + lib-write-core
// convention: both the `logFoodServing` Server Action (web one-tap bar) and the
// Telegram button handler (handleFoodLog) call this, so the ingestion path is one
// computation regardless of surface. The auth gate stays entirely in the action.
//
// One serving = one row per (profile, date, group_key) whose `servings` count is
// incremented; the keyed upsert is idempotent-friendly. group_key is validated
// against the curated catalog so a forged/stale slug (a tampered Telegram token, a
// retired group) lands nothing and is answered honestly by the caller.

import { db, writeTx } from "./db";
import { canonicalFoodGroup } from "./food-groups";

// The typed result of a serving write, so a Telegram tap answers from what ACTUALLY
// happened rather than unconditionally confirming (the markDoseTaken contract, #232):
//   logged        — a serving was recorded; `servings` is the group's new total for the day.
//   unknown-group  — the slug isn't in the catalog (forged/stale token); nothing written.
export type FoodLogOutcome =
  { kind: "logged"; servings: number } | { kind: "unknown-group" };

// The typed result of an undo (issue #748 item 5): a serving was removed and
// `servings` is the group's REMAINING daily total (0 once the row is dropped), or the
// slug isn't in the catalog. Undo is idempotent — undoing a group with nothing logged
// is a no-op that reports 0.
export type FoodUndoOutcome =
  { kind: "undone"; servings: number } | { kind: "unknown-group" };

// Log one serving of a food group on a day. Upserts the day's row, incrementing its
// servings, and returns the group's resulting daily total. Single IMMEDIATE
// transaction (#468) so the insert + the count read see one consistent state even
// under a concurrent web/Telegram tap on the same group.
export function logFoodServingCore(
  profileId: number,
  group: string,
  date: string,
  // The tap instant (an ISO-8601 UTC string), appended to the food_log_events ledger
  // (#950). Defaults to NOW — the load-bearing "logged_at is TAP time, never
  // backfilled" decision: even when `date` is yesterday (the backfill toggle), the
  // event records WHEN the user reached for the button, because ranking predicts the
  // next tap. Injectable so tests can seed a specific slot; production always passes
  // the default.
  loggedAt: string = new Date().toISOString()
): FoodLogOutcome {
  // Persist the canonical slug, not the raw input (#883): the matcher accepts
  // case/punctuation variants, but downstream readers compare group_key exactly.
  const slug = canonicalFoodGroup(group);
  if (slug === null) return { kind: "unknown-group" };
  return writeTx(() => {
    db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
    ).run(profileId, date, slug);
    // Append the per-tap event in the SAME transaction (#950): the counter and its
    // ledger see one consistent state, so a reader can never observe a bumped count
    // with no matching event (or vice versa). Additive — the counter row above is
    // byte-identical to the pre-ledger write.
    db.prepare(
      `INSERT INTO food_log_events (profile_id, group_key, date, logged_at)
       VALUES (?, ?, ?, ?)`
    ).run(profileId, slug, date, loggedAt);
    const row = db
      .prepare(
        `SELECT servings FROM food_log
          WHERE profile_id = ? AND date = ? AND group_key = ?`
      )
      .get(profileId, date, slug) as { servings: number } | undefined;
    return { kind: "logged", servings: row?.servings ?? 1 };
  });
}

// Undo one serving of a food group on a day (issue #748 item 5): decrement the day's
// row and drop it when it would hit zero, so a fully-undone group leaves no stray row.
// Single IMMEDIATE transaction (#468) — the decrement, the zero-cleanup DELETE, and the
// remaining-count read see one consistent state under a concurrent web/Telegram tap. An
// auth-blind core next to logFoodServingCore so a future Telegram "undo" button reuses
// the same computation rather than duplicating the two-statement sequence.
export function undoFoodServingCore(
  profileId: number,
  group: string,
  date: string
): FoodUndoOutcome {
  // Canonicalize so undo targets the same row a canonical log wrote (#883).
  const slug = canonicalFoodGroup(group);
  if (slug === null) return { kind: "unknown-group" };
  return writeTx(() => {
    db.prepare(
      `UPDATE food_log SET servings = servings - 1
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    ).run(profileId, date, slug);
    db.prepare(
      `DELETE FROM food_log
        WHERE profile_id = ? AND date = ? AND group_key = ? AND servings <= 0`
    ).run(profileId, date, slug);
    // Pop the NEWEST ledger event for (profile, date, group) alongside the counter
    // decrement (#950), one tx. Undo removes the last thing you logged, so it removes
    // the last event. A pre-ledger counter row (counter > events — logged before this
    // migration) has no event to pop: the subquery finds nothing and the DELETE is a
    // tolerated no-op (a "popless decrement"), so the counter still decrements.
    db.prepare(
      `DELETE FROM food_log_events
        WHERE id = (
          SELECT id FROM food_log_events
           WHERE profile_id = ? AND date = ? AND group_key = ?
           ORDER BY logged_at DESC, id DESC LIMIT 1
        )`
    ).run(profileId, date, slug);
    const row = db
      .prepare(
        `SELECT servings FROM food_log
          WHERE profile_id = ? AND date = ? AND group_key = ?`
      )
      .get(profileId, date, slug) as { servings: number } | undefined;
    return { kind: "undone", servings: row?.servings ?? 0 };
  });
}
