import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { up } from "@/lib/migrations/versions/167-appointment-day-time-split";

// Migration 167 (#2234): the appointments.scheduled_at split, rebuilt as
// `date TEXT NOT NULL` + `time_of_day TEXT NULL`.
//
// The column held THREE shapes — a bare day, the form's space-separated local
// datetime, and the importer's T-separated one (occasionally with seconds) — so
// the migration test's whole job is proving every shape moves correctly:
//
//   bare day             → date, time_of_day NULL
//   "YYYY-MM-DD HH:MM"   → date + "HH:MM"
//   "YYYY-MM-DDTHH:MM"   → date + "HH:MM"
//   a seconds-bearing value → still "HH:MM" (minute grain)
//
// Plus the #2234 decision-4 pin at the migration boundary: the relative order of
// a day-only and a timed row on one date is IDENTICAL before (lexical
// scheduled_at) and after (date, time_of_day with NULL first ASC / last DESC),
// in both directions. And the house rebuild guarantees: ids preserved, dangling
// links nulled rather than failing the FK'd copy, replay a no-op.

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

// The version-166 appointments shape (024's rebuild + 026's encounter_id), with
// minimal referenced tables so the dangling-link nulling has something to probe.
function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  // The runner applies every migration with foreign_keys DISABLED (issue #95);
  // mirror that here so the fixture can hold the dangling link the migration
  // must null (row 5), exactly as a production database could.
  mem.pragma("foreign_keys = OFF");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE medical_documents (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE encounters (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      scheduled_at TEXT NOT NULL,
      provider_id INTEGER REFERENCES providers(id),
      title TEXT,
      location TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled','completed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT,
      document_id INTEGER REFERENCES medical_documents(id),
      source TEXT,
      external_id TEXT,
      encounter_id INTEGER REFERENCES encounters(id)
    );
    CREATE INDEX idx_appointments_profile
      ON appointments(profile_id, scheduled_at);
    CREATE UNIQUE INDEX idx_appointments_external
      ON appointments(profile_id, external_id) WHERE external_id IS NOT NULL;
    INSERT INTO profiles (id, name) VALUES (1, 'P');
    INSERT INTO providers (id, name) VALUES (4, 'Dr. Kept');
    INSERT INTO appointments (id, profile_id, scheduled_at, title, provider_id)
      VALUES (1, 1, '2026-08-07', 'day only', 4);
    INSERT INTO appointments (id, profile_id, scheduled_at, title)
      VALUES (2, 1, '2026-08-07 09:00', 'space form');
    INSERT INTO appointments (id, profile_id, scheduled_at, title)
      VALUES (3, 1, '2026-08-07T14:30', 'T form');
    INSERT INTO appointments (id, profile_id, scheduled_at, title)
      VALUES (4, 1, '2026-06-10 09:30:00', 'space form with seconds');
    -- A dangling provider link, to prove it is NULLED, not a commit failure.
    INSERT INTO appointments (id, profile_id, scheduled_at, title, provider_id)
      VALUES (5, 1, '2026-09-01', 'dangling provider', 999);
  `);
  return mem;
}

describe("migration 167 — appointments.scheduled_at → date + time_of_day", () => {
  it("moves every stored shape to the right halves, preserving ids", () => {
    const mem = preMigrationDb();
    up(mem);
    const rows = mem
      .prepare(
        `SELECT id, date, time_of_day AS t, title FROM appointments ORDER BY id`
      )
      .all() as { id: number; date: string; t: string | null; title: string }[];
    expect(rows).toEqual([
      { id: 1, date: "2026-08-07", t: null, title: "day only" },
      { id: 2, date: "2026-08-07", t: "09:00", title: "space form" },
      { id: 3, date: "2026-08-07", t: "14:30", title: "T form" },
      {
        id: 4,
        date: "2026-06-10",
        t: "09:30",
        title: "space form with seconds",
      },
      { id: 5, date: "2026-09-01", t: null, title: "dangling provider" },
    ]);
  });

  it("replaces the column pair with the declared nullability, dropping scheduled_at", () => {
    const mem = preMigrationDb();
    up(mem);
    expect(columnInfo(mem, "appointments", "scheduled_at")).toBeUndefined();
    const date = columnInfo(mem, "appointments", "date")!;
    expect(date.type).toBe("TEXT");
    expect(date.notnull).toBe(1);
    const tod = columnInfo(mem, "appointments", "time_of_day")!;
    expect(tod.type).toBe("TEXT");
    // Nullable, because NULL IS the day-only grain — a real product state.
    expect(tod.notnull).toBe(0);
    expect(tod.dflt_value).toBe(null);
  });

  it("keeps the pre-split relative order of day-only vs timed rows, both directions (decision 4)", () => {
    const mem = preMigrationDb();
    const before = (dir: "ASC" | "DESC") =>
      mem
        .prepare(
          `SELECT id FROM appointments WHERE date(scheduled_at) = '2026-08-07'
            ORDER BY scheduled_at ${dir}, id ${dir}`
        )
        .all()
        .map((r) => (r as { id: number }).id);
    const beforeAsc = before("ASC");
    const beforeDesc = before("DESC");
    up(mem);
    const after = (dir: "ASC" | "DESC") =>
      mem
        .prepare(
          `SELECT id FROM appointments WHERE date = '2026-08-07'
            ORDER BY date ${dir}, time_of_day ${dir}, id ${dir}`
        )
        .all()
        .map((r) => (r as { id: number }).id);
    // Day-only first ASC (NULL sorts first), last DESC — the lexical order the
    // one-column sort produced.
    expect(after("ASC")).toEqual(beforeAsc);
    expect(after("DESC")).toEqual(beforeDesc);
    expect(after("ASC")).toEqual([1, 2, 3]);
    expect(after("DESC")).toEqual([3, 2, 1]);
  });

  it("nulls a dangling provider link and keeps a valid one", () => {
    const mem = preMigrationDb();
    up(mem);
    const links = mem
      .prepare(`SELECT id, provider_id FROM appointments WHERE id IN (1, 5)`)
      .all() as { id: number; provider_id: number | null }[];
    expect(links).toEqual([
      { id: 1, provider_id: 4 },
      { id: 5, provider_id: null },
    ]);
  });

  it("recreates the profile listing index over the new pair, and replays as a no-op", () => {
    const mem = preMigrationDb();
    up(mem);
    up(mem); // replay guard: the `date` column already exists → no-op
    const indexes = mem
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index'
           AND tbl_name = 'appointments' AND sql IS NOT NULL`
      )
      .all()
      .map((r) => (r as { sql: string }).sql)
      .join("\n");
    expect(indexes).toContain("profile_id, date, time_of_day");
    expect(indexes).toContain("external_id");
    expect(mem.prepare(`SELECT COUNT(*) AS n FROM appointments`).get()).toEqual(
      { n: 5 }
    );
  });

  it("ships in the real migrated schema", () => {
    const mem = new Database(":memory:");
    runMigrations(mem);
    expect(columnInfo(mem, "appointments", "scheduled_at")).toBeUndefined();
    expect(columnInfo(mem, "appointments", "date")!.notnull).toBe(1);
    expect(columnInfo(mem, "appointments", "time_of_day")!.notnull).toBe(0);
  });
});
