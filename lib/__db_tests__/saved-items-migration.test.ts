// DB INTEGRATION TIER — the migration 113 FOLD (issue #1456): two stores
// (`starred_biomarkers` + the `trend_pins` settings KV) become one `saved_items`
// table behind the ★ star gesture.
//
// This is the only tier that can see the fold: it builds a genuine PRE-113 database
// (migrations 1…112 on a fresh in-memory handle), writes a both-stores fixture into
// the OLD shape, runs 113's up() and asserts the merged result — rows merged, the
// starred/pinned overlap DEDUPED to one row, pin order preserved as `position`, and
// BOTH old stores gone (a leftover name-keyed row is the #203 wrong-suppression bug).
//
// All fixture values are SYNTHETIC (no PHI).

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
import { up as up113 } from "@/lib/migrations/versions/113-saved-items";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

const SAVED_ITEMS_MIGRATION = 113;

interface SavedRow {
  profile_id: number;
  kind: string;
  key: string;
  position: number | null;
  created_at: string;
}

// A database at exactly user_version 112 — every migration BEFORE the fold. FKs stay
// off, mirroring how the runner applies migrations.
function preFoldDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  for (const m of NUMBERED_MIGRATIONS) {
    if (m.id >= SAVED_ITEMS_MIGRATION) break;
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

function star(
  db: Database.Database,
  profileId: number,
  name: string,
  createdAt = "2026-01-01 00:00:00"
): void {
  db.prepare(
    `INSERT INTO starred_biomarkers (profile_id, canonical_name, created_at)
       VALUES (?, ?, ?)`
  ).run(profileId, name, createdAt);
}

function pins(db: Database.Database, profileId: number, list: unknown): void {
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'trend_pins', ?)`
  ).run(profileId, JSON.stringify(list));
}

function savedRows(db: Database.Database, profileId: number): SavedRow[] {
  return db
    .prepare(
      `SELECT profile_id, kind, key, position, created_at FROM saved_items
        WHERE profile_id = ?
        ORDER BY (position IS NULL), position, created_at DESC, key`
    )
    .all(profileId) as SavedRow[];
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

describe("migration 113 — folding both stores into saved_items", () => {
  it("folds the complete pre-113 fixture matrix without cross-profile or cleanup loss", () => {
    const db = preFoldDb();
    const fold = newProfile(db, "Fold Fixture");
    star(db, fold, "ApoB", "2026-01-01 00:00:00");
    star(db, fold, "hs-CRP", "2026-02-01 00:00:00");
    star(db, fold, "Lipoprotein(a)", "2026-03-01 00:00:00");
    pins(db, fold, [
      "metric:weight",
      "bio:ApoB",
      "bio:Ferritin",
      "metric:bodyfat",
    ]);
    const caseFold = newProfile(db, "Case Fixture");
    star(db, caseFold, "ApoB");
    pins(db, caseFold, ["bio:apob"]);
    const a = newProfile(db, "Profile A");
    const b = newProfile(db, "Profile B");
    star(db, a, "ApoB");
    star(db, b, "Ferritin");
    pins(db, a, ["metric:weight"]);
    pins(db, b, ["metric:bodyfat", "bio:ApoB"]);
    const cleanup = newProfile(db, "Cleanup Fixture");
    star(db, cleanup, "ApoB");
    pins(db, cleanup, ["metric:weight"]);
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')`
    ).run(cleanup);
    const garbage = newProfile(db, "Garbage Fixture");
    star(db, garbage, "ApoB");
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'trend_pins', 'not json')`
    ).run(garbage);
    const junk = newProfile(db, "Junk Entries Fixture");
    pins(db, junk, ["", "   ", 7, null, "provider:12", "bio:Ferritin"]);
    const check = newProfile(db, "Check Fixture");

    expect(() => up113(db)).not.toThrow();

    const rows = savedRows(db, fold);
    expect(rows.map((r) => `${r.kind}:${r.key}`)).toEqual([
      "trend-metric:weight",
      "biomarker:ApoB",
      "biomarker:Ferritin",
      "trend-metric:bodyfat",
      "biomarker:Lipoprotein(a)",
      "biomarker:hs-CRP",
    ]);
    expect(rows.slice(0, 4).map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(rows.slice(4).map((r) => r.position)).toEqual([null, null]);
    expect(rows.find((r) => r.key === "ApoB")?.created_at).toBe(
      "2026-01-01 00:00:00"
    );
    expect(
      rows.filter((r) => r.kind === "trend-metric").map((r) => r.key)
    ).toEqual(["weight", "bodyfat"]);
    expect(savedRows(db, caseFold)).toMatchObject([
      { key: "ApoB", position: 0 },
    ]);
    expect(savedRows(db, a).map((r) => `${r.kind}:${r.key}`)).toEqual([
      "trend-metric:weight",
      "biomarker:ApoB",
    ]);
    expect(savedRows(db, b).map((r) => `${r.kind}:${r.key}`)).toEqual([
      "trend-metric:bodyfat",
      "biomarker:ApoB",
      "biomarker:Ferritin",
    ]);
    expect(tableExists(db, "starred_biomarkers")).toBe(false);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM profile_settings WHERE key = 'trend_pins'"
        )
        .get()
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
        )
        .get(cleanup)
    ).toEqual({ value: "UTC" });
    expect(savedRows(db, garbage).map((r) => r.key)).toEqual(["ApoB"]);
    expect(savedRows(db, junk)).toMatchObject([
      { kind: "biomarker", key: "Ferritin", position: 0 },
    ]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'provider', '12')`
        )
        .run(check)
    ).toThrow();
    db.close();
  });
});
