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
import { MIGRATIONS, NUMBERED_MIGRATIONS } from "@/lib/migrations/versions";
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
  it("merges stars and pins, dedupes the overlap, and preserves pin order", () => {
    const db = preFoldDb();
    const p = newProfile(db, "Fold Fixture");

    // The pre-fold reality this issue describes: three starred analytes, and a pin
    // list that overlaps ONE of them (ApoB is both starred AND pinned) plus a metric
    // tile and a biomarker that was ONLY ever pinned.
    star(db, p, "ApoB", "2026-01-01 00:00:00");
    star(db, p, "hs-CRP", "2026-02-01 00:00:00");
    star(db, p, "Lipoprotein(a)", "2026-03-01 00:00:00");
    pins(db, p, [
      "metric:weight",
      "bio:ApoB",
      "bio:Ferritin",
      "metric:bodyfat",
    ]);

    up113(db);

    const rows = savedRows(db, p);
    // 3 stars + 2 metric pins + 1 pin-only biomarker = 6 (ApoB counted ONCE).
    expect(rows.length).toBe(6);
    expect(rows.filter((r) => r.key === "ApoB").length).toBe(1);

    // The pinned four keep their list order as position 0..3; the star-only rows
    // stay unpositioned and sort newest-first behind them.
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

    // The de-duped ApoB row is the STAR row (its created_at is the real save date),
    // not a fresh insert — the pin only contributed its ordering.
    const apob = rows.find((r) => r.key === "ApoB")!;
    expect(apob.created_at).toBe("2026-01-01 00:00:00");

    // Metric pins drop the namespace prefix: `kind` is the namespace now.
    expect(
      rows.filter((r) => r.kind === "trend-metric").map((r) => r.key)
    ).toEqual(["weight", "bodyfat"]);
    db.close();
  });

  it("dedupes the star/pin overlap case-insensitively", () => {
    // The star store was NOCASE, so "apob" and "ApoB" were always ONE star; the fold
    // must not resurrect them as two saves (a case-sensitive UNIQUE would).
    const db = preFoldDb();
    const p = newProfile(db, "Case Fixture");
    star(db, p, "ApoB");
    pins(db, p, ["bio:apob"]);

    up113(db);

    const rows = savedRows(db, p);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe("ApoB"); // the star's spelling survives
    expect(rows[0].position).toBe(0); // …and inherits the pin's ordering
    db.close();
  });

  it("keeps each profile's saves under its own profile_id", () => {
    const db = preFoldDb();
    const a = newProfile(db, "Profile A");
    const b = newProfile(db, "Profile B");
    star(db, a, "ApoB");
    star(db, b, "Ferritin");
    pins(db, a, ["metric:weight"]);
    pins(db, b, ["metric:bodyfat", "bio:ApoB"]);

    up113(db);

    expect(savedRows(db, a).map((r) => `${r.kind}:${r.key}`)).toEqual([
      "trend-metric:weight",
      "biomarker:ApoB",
    ]);
    expect(savedRows(db, b).map((r) => `${r.kind}:${r.key}`)).toEqual([
      "trend-metric:bodyfat",
      "biomarker:ApoB",
      "biomarker:Ferritin",
    ]);
    db.close();
  });

  it("drops the old table and DELETES the trend_pins settings rows (#203)", () => {
    const db = preFoldDb();
    const p = newProfile(db, "Cleanup Fixture");
    star(db, p, "ApoB");
    pins(db, p, ["metric:weight"]);
    // A neighbouring profile setting must survive untouched.
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')`
    ).run(p);

    up113(db);

    expect(tableExists(db, "starred_biomarkers")).toBe(false);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM profile_settings WHERE key = 'trend_pins'"
        )
        .get() as { n: number }
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
        )
        .get(p) as { value: string }
    ).toEqual({ value: "UTC" });
    db.close();
  });

  it("survives a malformed / legacy pin blob instead of failing the boot", () => {
    const db = preFoldDb();
    const p = newProfile(db, "Garbage Fixture");
    star(db, p, "ApoB");
    // Not JSON at all — an older shape, or a corrupt write.
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'trend_pins', 'not json')`
    ).run(p);
    const q = newProfile(db, "Junk Entries Fixture");
    pins(db, q, ["", "   ", 7, null, "provider:12", "bio:Ferritin"]);

    expect(() => up113(db)).not.toThrow();

    expect(savedRows(db, p).map((r) => r.key)).toEqual(["ApoB"]);
    // Only the one resolvable entry became a save, and it starts the ordering.
    const junk = savedRows(db, q);
    expect(junk.map((r) => `${r.kind}:${r.key}`)).toEqual([
      "biomarker:Ferritin",
    ]);
    expect(junk[0].position).toBe(0);
    db.close();
  });

  it("is a no-op on replay (the non-version-gated migrate() wrapper)", () => {
    const db = preFoldDb();
    const p = newProfile(db, "Replay Fixture");
    star(db, p, "ApoB");
    pins(db, p, ["metric:weight", "bio:ApoB"]);

    up113(db);

    // Bring the fixture to the CURRENT head first: 113's fold ran above, and the
    // later migrations that also write saved_items get their one legitimate pass —
    // 114 (#1487) seeds the standard metric tiles as saved rows here. The replay
    // assertion is about what a SECOND pass does, so the baseline has to be the
    // settled head rather than 113's output.
    for (const m of MIGRATIONS) m.up(db);
    const first = savedRows(db, p);

    // Replay of the WHOLE list: baseline recreates an empty starred_biomarkers, the
    // later migrations re-run, 113 folds nothing new before dropping it again, and
    // 114's seeding is a fixed point (OR IGNORE against the UNIQUE, and a dense
    // position rewrite that is already dense).
    for (const m of MIGRATIONS) m.up(db);

    expect(savedRows(db, p)).toEqual(first);
    expect(tableExists(db, "starred_biomarkers")).toBe(false);
    db.close();
  });

  it("rejects an unknown kind (the CHECK is the gate for future kinds)", () => {
    const db = preFoldDb();
    const p = newProfile(db, "Check Fixture");
    up113(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'provider', '12')`
        )
        .run(p)
    ).toThrow();
    db.close();
  });
});
