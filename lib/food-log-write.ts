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
import { isValidFoodGroup } from "./food-groups";

// The typed result of a serving write, so a Telegram tap answers from what ACTUALLY
// happened rather than unconditionally confirming (the markDoseTaken contract, #232):
//   logged        — a serving was recorded; `servings` is the group's new total for the day.
//   unknown-group  — the slug isn't in the catalog (forged/stale token); nothing written.
export type FoodLogOutcome =
  { kind: "logged"; servings: number } | { kind: "unknown-group" };

// Log one serving of a food group on a day. Upserts the day's row, incrementing its
// servings, and returns the group's resulting daily total. Single IMMEDIATE
// transaction (#468) so the insert + the count read see one consistent state even
// under a concurrent web/Telegram tap on the same group.
export function logFoodServingCore(
  profileId: number,
  group: string,
  date: string
): FoodLogOutcome {
  if (!isValidFoodGroup(group)) return { kind: "unknown-group" };
  return writeTx(() => {
    db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
    ).run(profileId, date, group);
    const row = db
      .prepare(
        `SELECT servings FROM food_log
          WHERE profile_id = ? AND date = ? AND group_key = ?`
      )
      .get(profileId, date, group) as { servings: number } | undefined;
    return { kind: "logged", servings: row?.servings ?? 1 };
  });
}
