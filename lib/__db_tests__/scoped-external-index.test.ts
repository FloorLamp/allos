// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Regression coverage for issue #90: the integration-dedup unique indexes on
// external_id must be PER-PROFILE ((profile_id, external_id)), not GLOBAL. Ingest
// upserts read/write scoped by (profile_id, external_id) and Health Connect
// external ids are content-derived, so a global index would make two profiles
// recording the same timestamp collide (profile B's sync fails with a UNIQUE
// violation). The baseline migration creates the scoped indexes directly; this
// test proves that shape and its behavior:
//   (a) the indexes on activities/medical_records/immunizations are scoped
//       on (profile_id, external_id);
//   (b) the same external_id is allowed across profiles but rejected within one.
//
// Runs via `npm run test:db` (vitest.db.config.ts); deterministic, :memory: only.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

// A fresh current-schema DB with two profiles, so cross-profile behavior can be
// exercised.
function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  migrate(db); // fresh boot → current schema, bootstraps profile 1
  db.prepare(
    `INSERT INTO profiles (id, name, created_at) VALUES (2, 'Test Profile Two', datetime('now'))`
  ).run();
  return db;
}

// The CREATE INDEX SQL for a given index name, or undefined if it doesn't exist.
function indexSql(db: Database.Database, name: string): string | undefined {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { sql: string | null } | undefined;
  return row?.sql ?? undefined;
}

const insActivity = (db: Database.Database, profileId: number, ext: string) =>
  db
    .prepare(
      `INSERT INTO activities (profile_id, date, type, title, source, external_id)
       VALUES (?, '2026-01-01', 'cardio', 'Morning walk', 'health-connect', ?)`
    )
    .run(profileId, ext);

const insVital = (db: Database.Database, profileId: number, ext: string) =>
  db
    .prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, source, external_id)
       VALUES (?, '2026-01-01', 'vitals', 'Blood pressure', 'health-connect', ?)`
    )
    .run(profileId, ext);

const insImm = (db: Database.Database, profileId: number, ext: string | null) =>
  db
    .prepare(
      `INSERT INTO immunizations (profile_id, date, vaccine, source, external_id)
       VALUES (?, '2026-01-01', 'Influenza', 'smart-health-card', ?)`
    )
    .run(profileId, ext);

describe("issue #90 — per-profile scoped external_id dedup indexes", () => {
  it("creates every external_id dedup index scoped on (profile_id, external_id)", () => {
    const db = newDb();
    expect(indexSql(db, "idx_activities_external")).toMatch(
      /activities\(profile_id, external_id\)/
    );
    expect(indexSql(db, "idx_medical_external")).toMatch(
      /medical_records\(profile_id, external_id\)/
    );
    expect(indexSql(db, "idx_immunizations_external")).toMatch(
      /immunizations\(profile_id, external_id\)/
    );
    db.close();
  });

  it("allows the same external_id across profiles but rejects it within one", () => {
    const db = newDb();
    const sharedAct = "health-connect:2026-01-01T07:00:00Z";
    const sharedVital = "health-connect:blood-pressure:2026-01-01T07:00:00Z";
    const sharedImm = "smart-health-card:flu:2026-01-01";

    insActivity(db, 1, sharedAct);
    insVital(db, 1, sharedVital);
    insImm(db, 1, sharedImm);

    // The core #90 property: profile 2 recording the SAME content-derived id
    // succeeds — the constraint is per-profile, not global.
    expect(() => insActivity(db, 2, sharedAct)).not.toThrow();
    expect(() => insVital(db, 2, sharedVital)).not.toThrow();
    expect(() => insImm(db, 2, sharedImm)).not.toThrow();

    // Within-profile dedup backstop: re-inserting the SAME profile+external_id
    // violates the unique constraint.
    expect(() => insActivity(db, 1, sharedAct)).toThrow(/UNIQUE/);
    expect(() => insVital(db, 1, sharedVital)).toThrow(/UNIQUE/);
    expect(() => insImm(db, 1, sharedImm)).toThrow(/UNIQUE/);

    // NULL external_id rows (manual entries) are outside the partial index —
    // multiple per profile are fine.
    expect(() => insImm(db, 1, null)).not.toThrow();
    expect(() => insImm(db, 1, null)).not.toThrow();

    db.close();
  });
});
