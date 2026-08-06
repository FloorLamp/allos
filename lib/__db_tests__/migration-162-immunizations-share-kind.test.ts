// DB INTEGRATION TIER (issue #1849).
//
// Migration 162 grows the profile_share_links `kind` CHECK to admit
// 'immunizations' — a table REBUILD (SQLite can't ALTER a CHECK), so the risk is
// not the new value but the copy: a rebuild that loses a row, a column, or an
// existing kind is a silent data loss. This exercises a pre-162 database carrying
// one link of each shipped kind through the migration and asserts every row and
// column survives, the new kind then inserts, and an unknown kind still refuses.
//
// Runs via `npm run test:db` (vitest.db.config.ts). :memory: only.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations, readVersion } from "@/lib/migrations/runner";
import { MIGRATIONS } from "@/lib/migrations/versions";

const V162 = 162;

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

// A DB with every migration BEFORE 162 applied and stamped at 161 — the exact shape
// a deployment running the previous release has on disk.
function preDb(): Database.Database {
  const db = newDb();
  for (const m of MIGRATIONS.filter((m) => m.id < V162)) m.up(db);
  db.pragma(`user_version = ${V162 - 1}`);
  return db;
}

function seedLinks(db: Database.Database): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Share Subject")
      .lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO profile_share_links
       (profile_id, token_hash, fields, expires_at, kind, episode_situation,
        episode_anchor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    profileId,
    "hash-passport",
    '["allergies","medications"]',
    "2026-12-31T00:00:00.000Z",
    "passport",
    null,
    null,
    "2026-01-01 00:00:00"
  );
  insert.run(
    profileId,
    "hash-episode",
    "[]",
    "2026-12-31T00:00:00.000Z",
    "episode",
    "Cold",
    "2026-01-05",
    "2026-01-02 00:00:00"
  );
  insert.run(
    profileId,
    "hash-medications",
    "[]",
    "2026-12-31T00:00:00.000Z",
    "medications",
    null,
    null,
    "2026-01-03 00:00:00"
  );
  return profileId;
}

function insertKind(
  db: Database.Database,
  profileId: number,
  kind: string,
  tokenHash: string
): void {
  db.prepare(
    `INSERT INTO profile_share_links
       (profile_id, token_hash, fields, expires_at, kind)
     VALUES (?, ?, '[]', '2026-12-31T00:00:00.000Z', ?)`
  ).run(profileId, tokenHash, kind);
}

describe("migration 162 — profile_share_links kind CHECK", () => {
  it("refuses 'immunizations' before the migration and admits it after", () => {
    const db = preDb();
    const profileId = seedLinks(db);
    expect(() =>
      insertKind(db, profileId, "immunizations", "hash-imm-early")
    ).toThrow(/CHECK constraint failed/);

    runMigrations(db);
    expect(readVersion(db)).toBe(MIGRATIONS.length);
    expect(() =>
      insertKind(db, profileId, "immunizations", "hash-imm")
    ).not.toThrow();
    db.close();
  });

  it("carries every existing row and column through the rebuild unchanged", () => {
    const db = preDb();
    seedLinks(db);
    const before = db
      .prepare("SELECT * FROM profile_share_links ORDER BY id")
      .all();
    const columnsBefore = columnNames(db, "profile_share_links");

    runMigrations(db);

    expect(columnNames(db, "profile_share_links")).toEqual(columnsBefore);
    expect(
      db.prepare("SELECT * FROM profile_share_links ORDER BY id").all()
    ).toEqual(before);
    db.close();
  });

  it("still refuses an unknown kind after the migration", () => {
    const db = newDb();
    runMigrations(db);
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Fresh")
        .lastInsertRowid
    );
    expect(() => insertKind(db, profileId, "labs", "hash-labs")).toThrow(
      /CHECK constraint failed/
    );
    db.close();
  });

  it("is a no-op on replay (guarded on the stored table SQL)", () => {
    const db = preDb();
    const profileId = seedLinks(db);
    runMigrations(db);
    insertKind(db, profileId, "immunizations", "hash-imm-replay");
    const before = db
      .prepare("SELECT * FROM profile_share_links ORDER BY id")
      .all();

    MIGRATIONS[V162 - 1].up(db);

    expect(
      db.prepare("SELECT * FROM profile_share_links ORDER BY id").all()
    ).toEqual(before);
    db.close();
  });
});
