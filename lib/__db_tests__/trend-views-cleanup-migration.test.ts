// DB INTEGRATION TIER — migration 142 (issue #1869 item 4): the one-shot sweep of
// the inert `trend_views` profile_settings rows (#1653 deleted every reader and
// writer; the rows stayed) plus the `trend_pins` belt (113 already deleted those).
//
// Built like the 113 fold test: a genuine pre-142 database (every earlier migration on a
// fresh in-memory handle), fixture rows in the old shape, run 142's up(), assert
// the swept keys are gone while NEIGHBOR profile_settings rows survive untouched.
//
// All fixture values are SYNTHETIC (no PHI).

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { up as up142 } from "@/lib/migrations/versions/142-trend-views-cleanup";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

const CLEANUP_MIGRATION = 142;

// A database holding every migration BEFORE the sweep. FKs
// stay off, mirroring how the runner applies migrations.
function preCleanupDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  for (const m of MIGRATIONS) {
    if (m.id >= CLEANUP_MIGRATION) break;
    m.up(db);
  }
  return db;
}

function newProfile(db: Database.Database, name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function setKV(
  db: Database.Database,
  profileId: number,
  key: string,
  value: string
): void {
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)`
  ).run(profileId, key, value);
}

function keysFor(db: Database.Database, profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT key FROM profile_settings WHERE profile_id = ? ORDER BY key`
      )
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);
}

describe("migration 142 — trend_views cleanup (#1869)", () => {
  it("deletes trend_views and trend_pins rows for every profile, nothing else", () => {
    const db = preCleanupDb();
    const a = newProfile(db, "Sweep A");
    const b = newProfile(db, "Sweep B");
    setKV(db, a, "trend_views", JSON.stringify([{ name: "old view" }]));
    setKV(db, a, "timezone", "UTC");
    setKV(db, b, "trend_views", "not even json");
    // A hypothetical straggler under the 113-retired key — same family, same sweep.
    setKV(db, b, "trend_pins", JSON.stringify(["metric:weight"]));
    setKV(db, b, "free_days", "0,6");

    up142(db);

    expect(keysFor(db, a)).toEqual(["timezone"]);
    expect(keysFor(db, b)).toEqual(["free_days"]);
    db.close();
  });

  it("is idempotent (a replay deletes zero rows and keeps neighbors)", () => {
    const db = preCleanupDb();
    const p = newProfile(db, "Sweep Replay");
    setKV(db, p, "trend_views", "[]");
    setKV(db, p, "birthdate", "1990-01-01");

    up142(db);
    up142(db);

    expect(keysFor(db, p)).toEqual(["birthdate"]);
    db.close();
  });
});
