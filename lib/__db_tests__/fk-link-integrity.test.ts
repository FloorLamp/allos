// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Migration 006 (issue #95) converges every DB on the baseline's real FOREIGN KEY
// shape for the nullable link columns (provider_id / document_id / equipment_id /
// location_provider_id). Some of those columns are bare `INTEGER` in the baseline
// ITSELF (so a fresh DB is in the "unenforced" state too) and some are bare only on
// a pre-runner-upgraded DB — either way this migration rebuilds the table so the FK
// is enforced everywhere. This exercises:
//
//   (a) a legacy-shaped table (link columns as bare INTEGER) is rebuilt to the
//       enforced shape, and the FK is then live (a bad write is rejected);
//   (b) a dangling link value is NULLed, not crashed, by the pre-copy cleanup;
//   (c) replaying up() on an already-converged DB is a no-op (schema unchanged);
//   (d) rebuilding `intake_items` — the one affected table that is itself a FK
//       PARENT with ON DELETE CASCADE children — does NOT cascade-wipe those
//       children.
//
// Runs via `npm run test:db`. Uses an isolated in-memory handle (not the `db`
// singleton) so we can build known-legacy shapes; `:memory:` only, no network.

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { bootTasks } from "@/lib/migrations/boot-tasks";
import {
  up,
  migration as m006,
} from "@/lib/migrations/versions/006-fk-link-integrity";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

let db: Database.Database;

// Apply the migration the way the runner does: with foreign_keys disabled (so a
// FK-parent rebuild can't cascade-wipe children), then re-enable enforcement.
function applyUp(): void {
  db.pragma("foreign_keys = OFF");
  up(db);
  db.pragma("foreign_keys = ON");
}

function tableSql(table: string): string {
  return (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table) as { sql: string }
  ).sql;
}

function columnSet(table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

function count(sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  // Build the schema through migration 005 ONLY — the PRE-006 state, where the link
  // columns are still bare INTEGER — so this test drives up() itself and observes the
  // bare→enforced convergence (rather than migrate() applying 006 for us). Apply with
  // foreign_keys off, exactly as the runner does.
  db.pragma("foreign_keys = OFF");
  for (const m of MIGRATIONS) if (m.id < m006.id) m.up(db);
  db.pragma("foreign_keys = ON");
  bootTasks(db);
});

afterEach(() => {
  db.close();
});

// The bootstrap profile always exists after migrate(); a shared provider + document.
function seedParents(): { providerId: number; docId: number } {
  const providerId = Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key)
         VALUES ('Test Clinic', 'organization', 'test-clinic')`
      )
      .run().lastInsertRowid
  );
  const docId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path)
         VALUES (1, 'labs.pdf', 'data/uploads/medical/1/labs.pdf')`
      )
      .run().lastInsertRowid
  );
  return { providerId, docId };
}

describe("migration 006 — FK link integrity (issue #95)", () => {
  it("rebuilds bare provider_id/document_id links to enforced FKs, nulling danglers", () => {
    const { providerId, docId } = seedParents();

    // The baseline medical_records has BOTH provider_id and document_id as bare
    // INTEGER — the unenforced shape.
    expect(tableSql("medical_records")).not.toContain(
      "provider_id INTEGER REFERENCES providers(id)"
    );

    // A valid row, a row whose provider_id/document_id dangle (inserted with FK
    // enforcement off, mimicking the bare-column state on an upgraded DB).
    const goodId = Number(
      db
        .prepare(
          `INSERT INTO medical_records (profile_id, date, category, name, provider_id, document_id)
           VALUES (1, '2020-01-01', 'lab', 'Glucose', ?, ?)`
        )
        .run(providerId, docId).lastInsertRowid
    );
    db.pragma("foreign_keys = OFF");
    const danglingId = Number(
      db
        .prepare(
          `INSERT INTO medical_records (profile_id, date, category, name, provider_id, document_id)
           VALUES (1, '2020-01-02', 'lab', 'HDL', 999999, 888888)`
        )
        .run().lastInsertRowid
    );
    db.pragma("foreign_keys = ON");

    const colsBefore = columnSet("medical_records");
    const rowsBefore = count("SELECT COUNT(*) AS c FROM medical_records");

    applyUp();

    // (a) The FK clauses are now present…
    const sql = tableSql("medical_records");
    expect(sql).toContain("provider_id INTEGER REFERENCES providers(id)");
    expect(sql).toContain(
      "document_id INTEGER REFERENCES medical_documents(id)"
    );
    // …no column was dropped by the rebuild (medical_records.edited from 002 etc.)…
    expect(columnSet("medical_records")).toEqual(colsBefore);
    // …and no row was lost.
    expect(count("SELECT COUNT(*) AS c FROM medical_records")).toBe(rowsBefore);

    // (b) The valid links survive; the dangling ones were nulled, not crashed.
    const good = db
      .prepare(
        "SELECT provider_id AS p, document_id AS d FROM medical_records WHERE id = ?"
      )
      .get(goodId) as { p: number | null; d: number | null };
    expect(good.p).toBe(providerId);
    expect(good.d).toBe(docId);
    const dangling = db
      .prepare(
        "SELECT provider_id AS p, document_id AS d FROM medical_records WHERE id = ?"
      )
      .get(danglingId) as { p: number | null; d: number | null };
    expect(dangling.p).toBeNull();
    expect(dangling.d).toBeNull();

    // (a, cont.) The FK is now LIVE — a bad write is rejected under foreign_keys=ON.
    expect(() =>
      db
        .prepare(
          `INSERT INTO medical_records (profile_id, date, category, name, provider_id)
           VALUES (1, '2020-01-03', 'lab', 'LDL', 999999)`
        )
        .run()
    ).toThrow(/FOREIGN KEY/i);
  });

  it("replaying up() on an already-converged DB is a no-op", () => {
    applyUp();
    const before = (
      db
        .prepare(
          "SELECT group_concat(sql, ';') AS s FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
        )
        .get() as { s: string }
    ).s;

    expect(() => applyUp()).not.toThrow();

    const after = (
      db
        .prepare(
          "SELECT group_concat(sql, ';') AS s FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
        )
        .get() as { s: string }
    ).s;
    expect(after).toBe(before);
  });

  it("rebuilds intake_items (a FK parent) without cascade-wiping its dose children", () => {
    const { providerId, docId } = seedParents();

    // The baseline intake_items already has provider_id as a BARE INTEGER (the
    // unenforced shape) while document_id carries its FK — and its CASCADE child
    // tables (intake_item_doses, …) are properly linked. That is exactly the
    // legacy-parent scenario, so drive it directly rather than manufacturing one.
    expect(tableSql("intake_items")).not.toContain(
      "provider_id INTEGER REFERENCES providers(id)"
    );

    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, provider_id, document_id)
           VALUES (1, 'Vitamin D', ?, ?)`
        )
        .run(providerId, docId).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          // Pre-011 schema (only migrations 001–005 applied here), so the dose FK
          // column is still its baseline name supplement_id (011 renames it to item_id).
          `INSERT INTO intake_item_doses (supplement_id, amount) VALUES (?, '1 cap')`
        )
        .run(itemId).lastInsertRowid
    );
    // A dangling row: bare provider_id (any value) plus a document_id that points at
    // no document — both only insertable with enforcement off.
    db.pragma("foreign_keys = OFF");
    const danglingItemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, provider_id, document_id)
           VALUES (1, 'Mystery Pill', 777777, 666666)`
        )
        .run().lastInsertRowid
    );
    db.pragma("foreign_keys = ON");

    applyUp();

    // Converged: both links now carry real FKs.
    const sql = tableSql("intake_items");
    expect(sql).toContain("provider_id INTEGER REFERENCES providers(id)");
    expect(sql).toContain(
      "document_id INTEGER REFERENCES medical_documents(id)"
    );

    // (d) The dose child SURVIVED the parent rebuild (no cascade wipe) and still
    // resolves to the (id-preserved) item.
    expect(count("SELECT COUNT(*) AS c FROM intake_item_doses")).toBe(1);
    const dose = db
      .prepare("SELECT supplement_id AS s FROM intake_item_doses WHERE id = ?")
      .get(doseId) as { s: number };
    expect(dose.s).toBe(itemId);

    // Valid links kept; dangling ones nulled.
    const good = db
      .prepare(
        "SELECT provider_id AS p, document_id AS d FROM intake_items WHERE id = ?"
      )
      .get(itemId) as { p: number | null; d: number | null };
    expect(good.p).toBe(providerId);
    expect(good.d).toBe(docId);
    const bad = db
      .prepare(
        "SELECT provider_id AS p, document_id AS d FROM intake_items WHERE id = ?"
      )
      .get(danglingItemId) as { p: number | null; d: number | null };
    expect(bad.p).toBeNull();
    expect(bad.d).toBeNull();

    // The FK is live: a bad provider_id write is now rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, provider_id) VALUES (1, 'Bad', 999999)`
        )
        .run()
    ).toThrow(/FOREIGN KEY/i);
  });
});
