// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Regression coverage for issue #90: the integration-dedup unique indexes on
// external_id must be PER-PROFILE ((profile_id, external_id)), not GLOBAL. Ingest
// upserts read/write scoped by (profile_id, external_id) and Health Connect
// external ids are content-derived, so a global index would make two profiles
// recording the same timestamp collide (profile B's sync fails with a UNIQUE
// violation). migrate() creates an INTERIM global external_id-only index (in
// db.ts, before profile_id exists on a pre-#67 upgrade) and then, in
// swapProfileScopedIndexes() — after profile_id is backfilled — DROPs it and
// creates the per-profile scoped index. This test proves that end state:
//   (a) the boot doesn't crash on an "old release" DB;
//   (b) the final indexes on activities/medical_records/immunizations are scoped
//       on (profile_id, external_id);
//   (c) the same external_id is allowed across profiles but rejected within one.
//
// immunizations is the extra case: it never carried a global unique index, so an
// old DB CAN hold per-profile duplicate external_ids (import-persist's INSERT OR
// IGNORE had no constraint to fire on). swapProfileScopedIndexes() dedupes
// (oldest wins) before creating the unique index, so the upgrade can't crash.
//
// Runs via `npm run test:db` (vitest.db.config.ts); deterministic, :memory: only.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

// The CREATE INDEX SQL for a given index name, or undefined if it doesn't exist.
function indexSql(db: Database.Database, name: string): string | undefined {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { sql: string | null } | undefined;
  return row?.sql ?? undefined;
}

// Turn a freshly-migrated DB into what an OLD release looked like: swap the
// per-profile scoped external_id indexes back for the pre-#90 GLOBAL ones, and
// drop the immunizations index entirely (it never existed as a constraint before
// #90). A second profile is added so cross-profile behavior can be exercised.
function makeOldReleaseDb(): Database.Database {
  const db = newDb();
  migrate(db); // fresh boot → current schema, bootstraps profile 1
  db.prepare(
    `INSERT INTO profiles (id, name, created_at) VALUES (2, 'Test Profile Two', datetime('now'))`
  ).run();

  db.exec("DROP INDEX IF EXISTS idx_activities_external;");
  db.exec(
    "CREATE UNIQUE INDEX idx_activities_external ON activities(external_id) WHERE external_id IS NOT NULL;"
  );
  db.exec("DROP INDEX IF EXISTS idx_medical_external;");
  db.exec(
    "CREATE UNIQUE INDEX idx_medical_external ON medical_records(external_id) WHERE external_id IS NOT NULL;"
  );
  db.exec("DROP INDEX IF EXISTS idx_immunizations_external;");
  return db;
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
  it("upgrade boot re-scopes the global indexes without crashing", () => {
    const db = makeOldReleaseDb();

    // Old-release data: under the GLOBAL index only ONE profile can hold a given
    // external_id (profile 2's sync had failed), so profile 1 owns the shared ids.
    insActivity(db, 1, "health-connect:2026-01-01T07:00:00Z");
    insVital(db, 1, "health-connect:blood-pressure:2026-01-01T07:00:00Z");

    // Pre-upgrade the indexes are global (no profile_id in their definition).
    expect(indexSql(db, "idx_activities_external")).not.toMatch(/profile_id/);
    expect(indexSql(db, "idx_medical_external")).not.toMatch(/profile_id/);

    // THE UPGRADE: re-run migrate() exactly as an existing deployment's boot does.
    expect(() => migrate(db)).not.toThrow();

    // Every external_id dedup index is now per-profile scoped.
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
    const db = makeOldReleaseDb();
    insActivity(db, 1, "health-connect:2026-01-01T07:00:00Z");
    insVital(db, 1, "health-connect:blood-pressure:2026-01-01T07:00:00Z");
    migrate(db);

    const sharedAct = "health-connect:2026-01-01T07:00:00Z";
    const sharedVital = "health-connect:blood-pressure:2026-01-01T07:00:00Z";

    // The core fix: profile 2 recording the SAME content-derived id now succeeds.
    expect(() => insActivity(db, 2, sharedAct)).not.toThrow();
    expect(() => insVital(db, 2, sharedVital)).not.toThrow();

    // Within-profile dedup backstop preserved: re-inserting the SAME
    // profile+external_id still violates the unique constraint.
    expect(() => insActivity(db, 1, sharedAct)).toThrow(/UNIQUE/);
    expect(() => insVital(db, 1, sharedVital)).toThrow(/UNIQUE/);

    db.close();
  });

  it("dedupes pre-existing per-profile immunization duplicates before indexing (oldest wins)", () => {
    const db = makeOldReleaseDb();

    // Only the un-indexed immunizations table could accumulate a per-profile
    // duplicate external_id. Seed two rows for the SAME (profile, external_id) —
    // an upgrade-DB state — plus a NULL-external_id manual row that must survive.
    const shared = "smart-health-card:flu:2026-01-01";
    const first = insImm(db, 1, shared);
    insImm(db, 1, shared);
    const manual = insImm(db, 1, null);
    // Same external_id under a different profile must also survive the dedupe.
    insImm(db, 2, shared);

    // THE UPGRADE: dedupe (keep MIN(id)) then create the unique index — no crash.
    expect(() => migrate(db)).not.toThrow();

    const p1 = db
      .prepare(
        `SELECT id FROM immunizations WHERE profile_id = 1 AND external_id = ?`
      )
      .all(shared) as { id: number }[];
    expect(p1.length).toBe(1);
    expect(p1[0].id).toBe(Number(first.lastInsertRowid)); // oldest survivor

    // Profile 2's same-external_id row was untouched by the dedupe.
    const p2 = db
      .prepare(
        `SELECT id FROM immunizations WHERE profile_id = 2 AND external_id = ?`
      )
      .all(shared) as { id: number }[];
    expect(p2.length).toBe(1);

    // The NULL-external_id manual row survives (partial index skips NULLs).
    expect(
      db
        .prepare(`SELECT id FROM immunizations WHERE id = ?`)
        .get(Number(manual.lastInsertRowid))
    ).toBeTruthy();

    // Constraint now active: cross-profile sharing works, within-profile rejected.
    expect(() =>
      insImm(db, 2, "smart-health-card:mmr:2026-01-01")
    ).not.toThrow();
    expect(() => insImm(db, 1, shared)).toThrow(/UNIQUE/);

    db.close();
  });
});
