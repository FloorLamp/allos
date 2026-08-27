// DB INTEGRATION TIER — #3282's fix for a recycled `notify_offers.id`.
//
// The id IS the callback token. `20260819-notify-offers` declared it `INTEGER PRIMARY
// KEY` with no `AUTOINCREMENT`, so a freed rowid went to the next offer — and because
// the offer prune and the message-pointer prune share a 3-day horizon, that happened on
// exactly the day the sweep could no longer retire the stale button. The end-to-end
// mis-write is pinned in telegram-callbacks.test.ts; this file is about the chain: what
// the migration does to a database that already has the recycling shape.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { migration } from "@/lib/migrations/versions/20260827-notify-offers-autoincrement";

const MIGRATION = "20260827-notify-offers-autoincrement";

function seeded(count: number): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(MIGRATION));
  db.prepare("INSERT INTO profiles (id, name) VALUES (1, 'OFFERS')").run();
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO notify_offers (profile_id, family, date, payload, created_at)
       VALUES (1, 'stack-take', '2026-08-27', '{"doseIds":[1]}', '2026-08-27 09:00:00')`
    ).run();
  }
  return db;
}

const mint = (db: Database.Database) =>
  Number(
    db
      .prepare(
        `INSERT INTO notify_offers (profile_id, family, date, payload, created_at)
         VALUES (1, 'stack-take', '2026-08-27', '{"doseIds":[2]}', '2026-08-27 09:00:00')`
      )
      .run().lastInsertRowid
  );

describe(`${MIGRATION} — an offer id is never reissued`, () => {
  // The two histories that reach the defect. Rows PRESENT is the ordinary case, where
  // AUTOINCREMENT alone continues past the highest id. EMPTY is the one AUTOINCREMENT
  // does NOT cover on its own — with no row to count from, the counter would restart at
  // 1 and hand the next offer an id a pruned one already spent — which is what the
  // migration's id floor is for. Both assert the same property: nothing minted after the
  // migration may collide with an id minted before it.
  it.each([
    ["rows still present", 2],
    ["every row already pruned", 0],
  ])("does not reissue an id after %s", (_why, surviving) => {
    const db = seeded(3);
    const spent = db
      .prepare(`SELECT id FROM notify_offers ORDER BY id`)
      .all()
      .map((r) => (r as { id: number }).id);
    if (surviving === 0) db.exec(`DELETE FROM notify_offers`);
    else db.exec(`DELETE FROM notify_offers WHERE id > ${surviving}`);

    runMigrations(db);

    expect(spent).toHaveLength(3);
    expect(spent).not.toContain(mint(db));
    db.close();
  });

  it("preserves the surviving rows, their ids and the profile index", () => {
    const db = seeded(2);
    runMigrations(db);
    expect(
      db.prepare(`SELECT id, family FROM notify_offers ORDER BY id`).all()
    ).toEqual([
      { id: 1, family: "stack-take" },
      { id: 2, family: "stack-take" },
    ]);
    // The rebuild drops the table, so the index and the FK have to come back with it —
    // and the scratch may not survive as a table of its own (it carries `profile_id`,
    // and an unswept profile-owned table is orphaned PHI).
    const schema = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE tbl_name = ?`)
      .all(`notify_offers`) as { name: string; sql: string | null }[];
    expect(schema.map((r) => r.name)).toContain("idx_notify_offers_profile");
    expect(schema[0].sql).toMatch(
      /REFERENCES profiles\(id\) ON DELETE CASCADE/
    );
    expect(
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE name LIKE '%__rebuild'`)
        .get()
    ).toBeUndefined();
    db.close();
  });

  // The non-version-gated `migrate()` wrapper replays `up()` on an already-converged
  // database, so the sentinel is called directly here — the ledger would otherwise skip
  // the second run and prove nothing.
  it("is a no-op when up() is replayed on a converged DB", () => {
    const db = seeded(2);
    runMigrations(db);
    const after = db.prepare(`SELECT id FROM notify_offers ORDER BY id`).all();
    const next = mint(db);
    migration.up(db);
    migration.up(db);
    expect(
      db.prepare(`SELECT id FROM notify_offers ORDER BY id`).all()
    ).toEqual([...after, { id: next }]);
    // And the counter did not rewind under the replays.
    expect(mint(db)).toBeGreaterThan(next);
    db.close();
  });
});
