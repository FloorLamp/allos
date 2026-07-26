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
import { now as clockNow } from "./clock";
import { canonicalFoodGroup } from "./food-groups";
import { type FoodSlot } from "./food-slot";
import { foodSlotForProfileEvent } from "./profile-food-slot";

// The typed result of a serving write, so a Telegram tap answers from what ACTUALLY
// happened rather than unconditionally confirming (the markDoseTaken contract, #232):
//   logged        — a serving was recorded; `servings` is the group's new total for the day.
//   unknown-group  — the slug isn't in the catalog (forged/stale token); nothing written.
export type FoodLogOutcome =
  | {
      kind: "logged";
      servings: number;
      mealSlot?: FoodSlot;
      mealServings?: number;
    }
  | { kind: "unknown-group" };

// The typed result of an undo (issue #748 item 5): a serving was removed and
// `servings` is the group's REMAINING daily total (0 once the row is dropped), or the
// slug isn't in the catalog. Undo is idempotent — undoing a group with nothing logged
// is a no-op that reports 0.
export type FoodUndoOutcome =
  | {
      kind: "undone";
      servings: number;
      mealSlot?: FoodSlot;
      mealServings?: number;
    }
  | { kind: "unknown-group" };

function mealServingCount(
  profileId: number,
  slug: string,
  date: string,
  mealSlot: FoodSlot
): number {
  const events = db
    .prepare(
      `SELECT logged_at, meal_slot FROM food_log_events
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .all(profileId, date, slug) as {
    logged_at: string;
    meal_slot: FoodSlot | null;
  }[];
  return events.filter(
    (event) =>
      foodSlotForProfileEvent(profileId, event.logged_at, event.meal_slot) ===
      mealSlot
  ).length;
}

// Log one serving of a food group on a day. Upserts the day's row, incrementing its
// servings, and returns the group's resulting daily total. Single IMMEDIATE
// transaction (#468) so the insert + the count read see one consistent state even
// under a concurrent web/Telegram tap on the same group.
export function logFoodServingCore(
  profileId: number,
  group: string,
  date: string,
  // The tap instant (an ISO-8601 UTC string), appended to the food_log_events ledger
  // (#950). Defaults to NOW and always remains the audit/tap time. `mealSlot`, when
  // supplied, separately records the consumed window for an honest backfill; callers
  // without an explicit meal retain the legacy timestamp-derived behavior. The instant
  // remains injectable so tests can seed a specific legacy slot.
  loggedAt: string = clockNow().toISOString(),
  mealSlot?: FoodSlot
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
      `INSERT INTO food_log_events
         (profile_id, group_key, date, logged_at, meal_slot)
       VALUES (?, ?, ?, ?, ?)`
    ).run(profileId, slug, date, loggedAt, mealSlot ?? null);
    const row = db
      .prepare(
        `SELECT servings FROM food_log
          WHERE profile_id = ? AND date = ? AND group_key = ?`
      )
      .get(profileId, date, slug) as { servings: number } | undefined;
    return {
      kind: "logged",
      servings: row?.servings ?? 1,
      ...(mealSlot ? { mealSlot } : {}),
      ...(mealSlot
        ? { mealServings: mealServingCount(profileId, slug, date, mealSlot) }
        : {}),
    };
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
  date: string,
  mealSlot?: FoodSlot
): FoodUndoOutcome {
  // Canonicalize so undo targets the same row a canonical log wrote (#883).
  const slug = canonicalFoodGroup(group);
  if (slug === null) return { kind: "unknown-group" };
  return writeTx(() => {
    const current = db
      .prepare(
        `SELECT servings FROM food_log
          WHERE profile_id = ? AND date = ? AND group_key = ?`
      )
      .get(profileId, date, slug) as { servings: number } | undefined;
    if (!current || current.servings <= 0)
      return {
        kind: "undone",
        servings: 0,
        ...(mealSlot ? { mealSlot, mealServings: 0 } : {}),
      };

    const candidates = db
      .prepare(
        `SELECT id, logged_at, meal_slot FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ?
          ORDER BY logged_at DESC, id DESC`
      )
      .all(profileId, date, slug) as {
      id: number;
      logged_at: string;
      meal_slot: FoodSlot | null;
    }[];
    const event = mealSlot
      ? candidates.find(
          (candidate) =>
            foodSlotForProfileEvent(
              profileId,
              candidate.logged_at,
              candidate.meal_slot
            ) === mealSlot
        )
      : candidates[0];

    // A slot-scoped undo may only remove a serving visible in that meal. This keeps
    // a Morning minus from silently deleting Dinner. Legacy counter-only history has
    // no assignable meal and therefore remains daily-only.
    if (mealSlot && !event)
      return {
        kind: "undone",
        servings: current.servings,
        mealSlot,
        mealServings: 0,
      };

    db.prepare(
      `UPDATE food_log SET servings = servings - 1
        WHERE profile_id = ? AND date = ? AND group_key = ? AND servings > 0`
    ).run(profileId, date, slug);
    db.prepare(
      `DELETE FROM food_log
        WHERE profile_id = ? AND date = ? AND group_key = ? AND servings <= 0`
    ).run(profileId, date, slug);
    // Pop the chosen ledger event alongside the counter decrement (#950), one tx.
    // Default callers remove the newest event; meal-aware callers remove the newest
    // event in that meal. A pre-ledger counter row has no event to pop, which remains
    // a tolerated "popless decrement" for default callers.
    if (event) {
      db.prepare(
        `DELETE FROM food_log_events
          WHERE id = ? AND profile_id = ?`
      ).run(event.id, profileId);
    }
    const row = db
      .prepare(
        `SELECT servings FROM food_log
          WHERE profile_id = ? AND date = ? AND group_key = ?`
      )
      .get(profileId, date, slug) as { servings: number } | undefined;
    const removedSlot =
      mealSlot && event
        ? foodSlotForProfileEvent(profileId, event.logged_at, event.meal_slot)
        : undefined;
    return {
      kind: "undone",
      servings: row?.servings ?? 0,
      ...(removedSlot ? { mealSlot: removedSlot } : {}),
      ...(mealSlot
        ? { mealServings: mealServingCount(profileId, slug, date, mealSlot) }
        : {}),
    };
  });
}
