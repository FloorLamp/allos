import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { up } from "@/lib/migrations/versions/165-observation-occurred-at";
import { eventInstant, recordInstant } from "@/lib/row-instants";
import { utcInstant } from "@/lib/date";

// Migration 165 (#2237 — #2205 phase 2 wave 1): `occurred_at TEXT` NULL on the three
// observation stores.
//
// Two halves, and both matter:
//
//   • Against a MINIMAL pre-migration schema, so the claim is about the migration and
//     not about whatever else the baseline happens to provide: the column arrives on
//     all three tables, it is nullable with no DEFAULT, existing rows are untouched
//     and read back NULL, and a replay is a pure no-op.
//   • Against the REAL migrated schema, so the claim is about what ships: the same
//     three columns exist with the same nullability, and the row readers now answer
//     `not-recorded` for a row with no stated time instead of `not-declared`. That
//     flip is the user-visible half of this migration — the app can finally say
//     "nobody stated when" rather than "this table cannot answer".
//
// What is NOT asserted, because it is not in this change: nothing writes the column.
// Manual capture, importer writes and the reading-model mapping follow in #2154/#2235.

const TABLES = ["medical_records", "body_metrics", "intake_item_logs"] as const;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columnInfo(
  mem: Database.Database,
  table: string,
  column: string
): ColumnInfo | undefined {
  return (
    mem.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
  ).find((c) => c.name === column);
}

// The three tables as they stood BEFORE 165, reduced to what an ADD COLUMN needs to
// see: a primary key, the profile scope, the day, and one value to prove untouched.
function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT
    );
    CREATE TABLE body_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      weight_kg REAL
    );
    CREATE TABLE intake_item_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dose_id INTEGER,
      item_id INTEGER,
      date TEXT NOT NULL,
      given_at TEXT
    );
    INSERT INTO medical_records (id, profile_id, date, category, name, value)
      VALUES (5, 1, '2026-01-09', 'vital', 'Blood Pressure', '118/74');
    INSERT INTO body_metrics (id, profile_id, date, weight_kg)
      VALUES (7, 1, '2026-01-09', 71.4);
    INSERT INTO intake_item_logs (id, dose_id, item_id, date, given_at)
      VALUES (9, 3, 2, '2026-01-09', '2026-01-09 07:02:11');
  `);
  return mem;
}

describe("migration 165 — occurred_at on the three observation stores", () => {
  it("adds a nullable, default-free TEXT column to all three tables", () => {
    const mem = preMigrationDb();
    up(mem);
    try {
      for (const table of TABLES) {
        const col = columnInfo(mem, table, "occurred_at");
        expect(col, `${table}.occurred_at is missing`).toBeDefined();
        expect(col!.type, `${table}.occurred_at type`).toBe("TEXT");
        // Nullable, because NULL is the whole point: it means "day-grain reading",
        // absence rather than empty apparatus.
        expect(col!.notnull, `${table}.occurred_at must be nullable`).toBe(0);
        // No DEFAULT, deliberately. A clock default would stamp the moment the row was
        // written into an EVENT column — the record-for-event substitution #2205
        // exists to close — and would silently claim a time nobody stated.
        expect(
          col!.dflt_value,
          `${table}.occurred_at must have no DEFAULT`
        ).toBe(null);
      }
    } finally {
      mem.close();
    }
  });

  it("leaves existing rows untouched, reading back NULL", () => {
    const mem = preMigrationDb();
    up(mem);
    try {
      const record = mem
        .prepare(
          `SELECT value, occurred_at FROM medical_records WHERE id = 5 AND profile_id = 1`
        )
        .get() as { value: string; occurred_at: string | null };
      expect(record.value).toBe("118/74");
      expect(record.occurred_at).toBe(null);

      const body = mem
        .prepare(
          `SELECT weight_kg, occurred_at FROM body_metrics WHERE id = 7 AND profile_id = 1`
        )
        .get() as { weight_kg: number; occurred_at: string | null };
      expect(body.weight_kg).toBe(71.4);
      expect(body.occurred_at).toBe(null);

      // The record chain is NOT copied into the new event column. `given_at` is the
      // tap, and seeding an event instant from it would be exactly the inference the
      // column exists to stop making.
      const log = mem
        .prepare(
          `SELECT given_at, occurred_at FROM intake_item_logs WHERE id = 9`
        )
        .get() as { given_at: string; occurred_at: string | null };
      expect(log.given_at).toBe("2026-01-09 07:02:11");
      expect(log.occurred_at).toBe(null);
    } finally {
      mem.close();
    }
  });

  it("accepts a stated instant and is replay-safe", () => {
    const mem = preMigrationDb();
    up(mem);
    const at = utcInstant(new Date("2026-01-09T18:41:00Z"));
    mem.prepare(`UPDATE body_metrics SET occurred_at = ? WHERE id = 7`).run(at);
    // The non-version-gated migrate() wrapper replays every migration over an at-rest
    // database, and SQLite has no ADD COLUMN IF NOT EXISTS — so the guard is load
    // bearing, and a replay must not throw OR clobber a stated value.
    expect(() => up(mem)).not.toThrow();
    try {
      expect(
        (
          mem
            .prepare(`SELECT occurred_at FROM body_metrics WHERE id = 7`)
            .get() as { occurred_at: string | null }
        ).occurred_at
      ).toBe("2026-01-09T18:41:00Z");
    } finally {
      mem.close();
    }
  });
});

describe("migration 165 against the full migrated schema", () => {
  const mem = new Database(":memory:");
  runMigrations(mem);

  it("ships the column on all three tables, nullable and default-free", () => {
    for (const table of TABLES) {
      const col = columnInfo(mem, table, "occurred_at");
      expect(
        col,
        `${table}.occurred_at is missing from the shipped schema`
      ).toBeDefined();
      expect(col!.type).toBe("TEXT");
      expect(col!.notnull).toBe(0);
      expect(col!.dflt_value).toBe(null);
    }
  });

  it("turns `not-declared` into `not-recorded` for a row with no stated time", () => {
    // Before this migration, `body_metrics` and `intake_item_logs` declared no event
    // column at all, so "when did this happen" was unanswerable BY THE SCHEMA for
    // every row, forever. Now it is answerable and the answer for an untimed row is
    // "nobody said" — a different fact, and the one the app can act on.
    for (const table of TABLES) {
      expect(eventInstant(table, { occurred_at: null }).known).toBe(false);
      expect(eventInstant(table, { occurred_at: null })).toMatchObject({
        why: "not-recorded",
        column: "occurred_at",
      });
    }

    expect(
      eventInstant("body_metrics", { occurred_at: "2026-01-09T18:41:00Z" })
    ).toMatchObject({
      known: true,
      at: "2026-01-09T18:41:00Z",
      column: "occurred_at",
      derived: false,
    });
  });

  it("does not disturb the record chain it sits beside", () => {
    // `given_at` → `taken_at` still answers "when did this enter the app". The new
    // column answers a different question and takes nothing from that one.
    expect(
      recordInstant("intake_item_logs", {
        occurred_at: null,
        given_at: "2026-01-09 07:02:11",
        taken_at: "2026-01-09 07:02:14",
      })
    ).toMatchObject({ known: true, column: "given_at" });
  });
});
