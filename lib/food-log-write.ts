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
import { isRealIsoDate } from "./date";
import { canonicalFoodGroup } from "./food-groups";
import { type FoodSlot } from "./food-slot";
import { foodSlotForProfileEvent } from "./profile-food-slot";
import { isProteinNudgeKey } from "./protein-nudge";

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

// ---- Correction (issue #1934) ----

// Where one ledger event SITS after a write, with the two authoritative counts that
// placement owns: the day counter for its (date, group) and the ledger tally for its
// (date, group, window). An edit answers with the placement BEFORE and the placement
// AFTER, both re-read post-write, so the surface reconciles its optimistic counts from
// the server rather than re-deriving a move client-side (the #748 item 2 discipline).
export interface FoodEventPlacement {
  date: string;
  groupKey: string;
  mealSlot: FoodSlot;
  // food_log servings for (profile, date, groupKey) AFTER the write. 0 once the row
  // is dropped.
  servings: number;
  // food_log_events count for (profile, date, groupKey) whose derived window is
  // `mealSlot`, AFTER the write.
  mealServings: number;
}

// The typed result of a correction:
//   updated        — the event moved; `from`/`to` carry both placements' post-write counts.
//   not-found      — no such event for this profile (a forged/stale id, or another
//                    profile's row — the statement is id + profile_id scoped).
//   unknown-group  — the requested group isn't in the catalog; nothing written.
//   invalid-date   — the requested date isn't a real calendar date; nothing written.
//   not-correctable — the row is the reserved `__protein__` ranking event, which is not
//                    a food-group serving: its truth is the protein_log grams total, and
//                    re-keying it onto a catalog group would mint a serving from a shake.
export type FoodEventEditOutcome =
  | {
      kind: "updated";
      id: number;
      from: FoodEventPlacement;
      to: FoodEventPlacement;
    }
  | { kind: "not-found" }
  | { kind: "unknown-group" }
  | { kind: "invalid-date" }
  | { kind: "not-correctable" };

// The post-write placement of one (date, group, window) coordinate. Read INSIDE the
// caller's transaction so `from` and `to` describe one consistent state.
function placementOf(
  profileId: number,
  date: string,
  groupKey: string,
  mealSlot: FoodSlot
): FoodEventPlacement {
  const row = db
    .prepare(
      `SELECT servings FROM food_log
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .get(profileId, date, groupKey) as { servings: number } | undefined;
  return {
    date,
    groupKey,
    mealSlot,
    servings: row?.servings ?? 0,
    mealServings: mealServingCount(profileId, groupKey, date, mealSlot),
  };
}

// Correct one already-logged serving: its food group, its day, and/or its meal window
// (issue #1934). The one-tap surfaces got create + delete and never got correction, and
// delete-and-re-log is NOT equivalent — a re-log stamps the CURRENT instant and window,
// so "logged last night's dinner this morning" cannot be repaired faithfully.
//
// The event ledger and the food_log day counter are ONE fact in two shapes, so the
// counter MOVES with the event in the same IMMEDIATE transaction: a (date, group) change
// decrements the old counter (dropping the row at zero, the undoFoodServingCore
// discipline) and increments the new one. Exactly one serving exists throughout — the
// derived reads (slot tallies, the day's counts, the weekly frequency-target progress)
// all recompute live off these two tables, so a move can never double-count.
//
// `logged_at` is deliberately NOT edited: it is the audit/tap instant, and the MEANINGFUL
// grain is the window, which `meal_slot` asserts explicitly. An event left without an
// explicit window keeps its NULL and therefore keeps deriving from `logged_at` — a
// correction never silently freezes a legacy row's window.
export function updateFoodLogEventCore(
  profileId: number,
  eventId: number,
  patch: { groupKey?: string; date?: string; mealSlot?: FoodSlot }
): FoodEventEditOutcome {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT group_key, date, logged_at, meal_slot FROM food_log_events
          WHERE id = ? AND profile_id = ?`
      )
      .get(eventId, profileId) as
      | {
          group_key: string;
          date: string;
          logged_at: string;
          meal_slot: FoodSlot | null;
        }
      | undefined;
    if (!row) return { kind: "not-found" as const };
    if (isProteinNudgeKey(row.group_key))
      return { kind: "not-correctable" as const };

    // Canonicalize only a REQUESTED group (#883). The stored key is used verbatim for
    // the old-counter decrement — a retired slug must still be able to give its serving
    // back, which is exactly the repair someone reaches for.
    const nextGroup =
      patch.groupKey === undefined
        ? row.group_key
        : canonicalFoodGroup(patch.groupKey);
    if (nextGroup === null) return { kind: "unknown-group" as const };
    const nextDate = patch.date ?? row.date;
    if (!isRealIsoDate(nextDate)) return { kind: "invalid-date" as const };
    const nextSlot = patch.mealSlot ?? row.meal_slot;

    const fromSlot = foodSlotForProfileEvent(
      profileId,
      row.logged_at,
      row.meal_slot
    );
    const toSlot = foodSlotForProfileEvent(profileId, row.logged_at, nextSlot);

    if (nextDate !== row.date || nextGroup !== row.group_key) {
      db.prepare(
        `UPDATE food_log SET servings = servings - 1
          WHERE profile_id = ? AND date = ? AND group_key = ? AND servings > 0`
      ).run(profileId, row.date, row.group_key);
      db.prepare(
        `DELETE FROM food_log
          WHERE profile_id = ? AND date = ? AND group_key = ? AND servings <= 0`
      ).run(profileId, row.date, row.group_key);
      db.prepare(
        `INSERT INTO food_log (profile_id, date, group_key, servings)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (profile_id, date, group_key)
         DO UPDATE SET servings = servings + 1`
      ).run(profileId, nextDate, nextGroup);
    }
    db.prepare(
      `UPDATE food_log_events
          SET group_key = ?, date = ?, meal_slot = ?
        WHERE id = ? AND profile_id = ?`
    ).run(nextGroup, nextDate, nextSlot, eventId, profileId);

    return {
      kind: "updated" as const,
      id: eventId,
      from: placementOf(profileId, row.date, row.group_key, fromSlot),
      to: placementOf(profileId, nextDate, nextGroup, toSlot),
    };
  });
}
