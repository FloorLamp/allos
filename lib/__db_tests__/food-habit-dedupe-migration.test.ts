// DB INTEGRATION TIER — migration 038 de-dupe path (issue #748 item 4).
//
// Before the partial unique index, trackFoodHabit's SELECT-then-INSERT could land TWO
// food_group targets for one group. An existing DB may already carry such duplicates, so
// migration 038 must collapse them to the oldest row (re-pointing any protocol that
// referenced a losing duplicate) BEFORE creating the unique index — otherwise the index
// creation throws. This applies migrations 001–037 to a fresh handle, seeds a duplicate
// and a protocol pointing at the loser, runs 038, and asserts the collapse + re-point +
// index. Runs via `npm run test:db`; :memory: only, deterministic.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { up as up038 } from "@/lib/migrations/versions/038-food-habit-unique";

function applyThrough(maxId: number): Database.Database {
  const db = new Database(":memory:");
  // The runner applies migrations with foreign_keys OFF (so a FK-parent rebuild can't
  // cascade-wipe) — mirror that so a duplicate + a dangling re-point behave as in prod.
  db.pragma("foreign_keys = OFF");
  db.pragma("busy_timeout = 10000");
  for (const m of MIGRATIONS) {
    if (m.id > maxId) break;
    m.up(db);
  }
  return db;
}

describe("migration 038 collapses pre-existing food-habit duplicates", () => {
  it("keeps the oldest row, re-points its protocol, and then unique-indexes", () => {
    const db = applyThrough(37);
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('dupes')").run()
        .lastInsertRowid
    );

    // Two food_group targets for ONE group (the race artifact) + one for another group.
    const keeper = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'fatty_fish', 2)`
        )
        .run(profileId).lastInsertRowid
    );
    const loser = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'fatty_fish', 3)`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'food_group', 'legumes', 2)`
    ).run(profileId);

    // A protocol adopted the LOSER as its intervention.
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, outcome_keys, frequency_target_id, owns_frequency_target)
           VALUES (?, 'Fatty fish', '2026-05-01', '[]', ?, 1)`
        )
        .run(profileId, loser).lastInsertRowid
    );

    up038(db);

    // The loser is gone; the keeper (oldest id) survives.
    const fishRows = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'food_group' AND scope_value = 'fatty_fish'`
      )
      .all(profileId) as { id: number }[];
    expect(fishRows.map((r) => r.id)).toEqual([keeper]);

    // The protocol was re-pointed to the keeper — never left dangling.
    const proto = db
      .prepare("SELECT frequency_target_id FROM protocols WHERE id = ?")
      .get(protocolId) as { frequency_target_id: number };
    expect(proto.frequency_target_id).toBe(keeper);

    // The unique index now exists and forbids a fresh duplicate.
    expect(() =>
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'fatty_fish', 4)`
        )
        .run(profileId)
    ).toThrow(/UNIQUE/i);

    db.close();
  });
});
