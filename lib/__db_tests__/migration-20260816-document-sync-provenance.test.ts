// The rebuild's own safety properties, asserted by BEHAVIOUR rather than by review.
//
// Migration 119, whose DDL this copies, has exactly this test; 163 explicitly asserts the
// index survives its rebuild. This one shipped with neither, and two mutations passed the
// whole suite green: deleting `CREATE INDEX idx_integration_sync_rows_event` from the
// rebuild (the classic table-rebuild failure — a silently dropped index), and removing
// the `ADD COLUMN` replay guard (a re-run then throws "duplicate column name" and takes
// the boot with it).
//
// The seed here is a database in the shape the migration actually meets: the pre-#2999
// CHECK, a row at a non-1 id with a legacy bare `created_at`, both indexes present, and
// the parent tables the two FKs point at.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/20260816-document-sync-provenance";

// Migration 163's canonical stored-instant DEFAULT, which a rebuild re-declares and can
// therefore silently walk back to SQLite's bare `datetime('now')` shape.
const CANONICAL_DEFAULT = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

function seed(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE integration_sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
    INSERT INTO integration_sync_events DEFAULT VALUES;

    CREATE TABLE integration_sync_rows (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
      target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records','practice_logs')),
      target_id    INTEGER NOT NULL,
      disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
      created_at   TEXT NOT NULL DEFAULT (${CANONICAL_DEFAULT})
    );
    CREATE INDEX idx_integration_sync_rows_event
      ON integration_sync_rows(event_id);
    INSERT INTO integration_sync_rows
      (id, event_id, target_table, target_id, disposition, created_at)
    VALUES
      (7, 1, 'activities', 41, 'inserted', '2026-07-28 12:00:00');

    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO profiles DEFAULT VALUES;
    CREATE TABLE portals (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO portals DEFAULT VALUES;
    CREATE TABLE portal_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE
    );
    INSERT INTO portal_accounts (portal_id) VALUES (1);
    CREATE TABLE portal_identities (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id    INTEGER NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
      patient_label TEXT NOT NULL
    );
    INSERT INTO portal_identities (account_id, patient_label) VALUES (1, 'PATIENT ONE');

    CREATE TABLE medical_documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      filename   TEXT NOT NULL
    );
    INSERT INTO medical_documents (profile_id, filename) VALUES (1, 'bundle.xml');
  `);
  return mem;
}

function indexNames(mem: Database.Database, table: string): string[] {
  return (
    mem.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();
}

describe("20260816-document-sync-provenance — the sync-rows rebuild", () => {
  it("preserves existing rows byte-for-byte and admits medical_documents", () => {
    const mem = seed();
    up(mem);

    expect(
      mem
        .prepare(
          `SELECT id, event_id, target_table, target_id, disposition, created_at
             FROM integration_sync_rows ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 7,
        event_id: 1,
        target_table: "activities",
        target_id: 41,
        disposition: "inserted",
        created_at: "2026-07-28 12:00:00",
      },
    ]);

    expect(() =>
      mem
        .prepare(
          `INSERT INTO integration_sync_rows
             (event_id, target_table, target_id, disposition)
           VALUES (1, 'medical_documents', 52, 'inserted')`
        )
        .run()
    ).not.toThrow();
    expect(() =>
      mem
        .prepare(
          `INSERT INTO integration_sync_rows
             (event_id, target_table, target_id, disposition)
           VALUES (1, 'unknown', 53, 'inserted')`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);

    mem.close();
  });

  it("carries the table's index across the rebuild", () => {
    // The classic table-rebuild failure: create → copy → drop → rename takes the old
    // table's indexes with it, and nothing complains — the drill-in just gets slower
    // every year. `idx_integration_sync_rows_event` is what resolves a run's provenance.
    const mem = seed();
    up(mem);
    expect(indexNames(mem, "integration_sync_rows")).toContain(
      "idx_integration_sync_rows_event"
    );
    mem.close();
  });

  it("keeps migration 163's canonical created_at DEFAULT", () => {
    const mem = seed();
    up(mem);
    const sql = (
      mem
        .prepare(
          `SELECT sql FROM sqlite_master
            WHERE type = 'table' AND name = 'integration_sync_rows'`
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain(CANONICAL_DEFAULT);
    // Copying 119's DDL verbatim walks it back to this, which the next insert then
    // writes in the wrong shape.
    expect(sql).not.toContain("DEFAULT (datetime('now'))");
    mem.close();
  });
});

describe("20260816-document-sync-provenance — the acquired-identity column", () => {
  it("adds the column with an ON DELETE SET NULL reference to portal_identities", () => {
    const mem = seed();
    up(mem);
    mem.pragma("foreign_keys = ON");

    mem
      .prepare(
        "UPDATE medical_documents SET acquired_identity_id = 1 WHERE id = 1"
      )
      .run();
    mem.prepare("DELETE FROM portal_identities WHERE id = 1").run();

    // The DOCUMENT survives the binding that named it — provenance points AT the
    // registry row, so losing the row loses only the ability to name it.
    expect(
      mem
        .prepare(
          "SELECT filename, acquired_identity_id AS identity FROM medical_documents WHERE id = 1"
        )
        .get()
    ).toEqual({ filename: "bundle.xml", identity: null });
    mem.close();
  });

  it("adds the durable claim mark the guard reads", () => {
    // `delivered_at` is what makes the claim survive the #388 retention sweep: the
    // provenance rows cascade away with their event at 90 days, and a guard that asked
    // them "is this already claimed" would forget and re-claim a year of archives.
    const mem = seed();
    up(mem);
    expect(
      (
        mem.prepare("PRAGMA table_info(medical_documents)").all() as {
          name: string;
        }[]
      ).map((c) => c.name)
    ).toContain("delivered_at");
    mem.close();
  });

  it("indexes both reads the feature makes, in one index", () => {
    const mem = seed();
    up(mem);
    const idx = indexNames(mem, "medical_documents");
    expect(idx).toContain("idx_medical_documents_acquired_identity");
    expect(
      (
        mem
          .prepare("PRAGMA index_info(idx_medical_documents_acquired_identity)")
          .all() as { name: string }[]
      ).map((c) => c.name)
    ).toEqual(["acquired_identity_id", "delivered_at"]);
    mem.close();
  });
});

describe("20260816-document-sync-provenance — replay", () => {
  it("is a pure no-op on every half when run again", () => {
    // The runner replays a migration on any database whose ledger does not name it, and
    // an unguarded ADD COLUMN throws "duplicate column name" — taking the boot with it.
    const mem = seed();
    up(mem);
    const after = (): unknown => ({
      rows: mem
        .prepare(
          `SELECT id, event_id, target_table, target_id, disposition, created_at
             FROM integration_sync_rows ORDER BY id`
        )
        .all(),
      table: mem
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'integration_sync_rows'`
        )
        .get(),
      documents: mem.prepare("PRAGMA table_info(medical_documents)").all(),
      indexes: [
        ...indexNames(mem, "integration_sync_rows"),
        ...indexNames(mem, "medical_documents"),
      ],
    });
    const before = JSON.stringify(after());

    expect(() => {
      up(mem);
      up(mem);
    }).not.toThrow();

    expect(JSON.stringify(after())).toEqual(before);
    mem.close();
  });

  it("resumes from a half-applied state — the rebuild done, the column not", () => {
    const mem = seed();
    // Only the CHECK half applied, then the process died.
    mem.exec(`
      CREATE TABLE rows2 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
        target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records','practice_logs','medical_documents')),
        target_id    INTEGER NOT NULL,
        disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
        created_at   TEXT NOT NULL DEFAULT (${CANONICAL_DEFAULT})
      );
      INSERT INTO rows2 SELECT * FROM integration_sync_rows;
      DROP TABLE integration_sync_rows;
      ALTER TABLE rows2 RENAME TO integration_sync_rows;
      CREATE INDEX idx_integration_sync_rows_event ON integration_sync_rows(event_id);
    `);

    up(mem);

    expect(
      (
        mem.prepare("PRAGMA table_info(medical_documents)").all() as {
          name: string;
        }[]
      ).map((c) => c.name)
    ).toContain("acquired_identity_id");
    expect(
      mem.prepare("SELECT COUNT(*) AS n FROM integration_sync_rows").get()
    ).toEqual({ n: 1 });
    mem.close();
  });
});
