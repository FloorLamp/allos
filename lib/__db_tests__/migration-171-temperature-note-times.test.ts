// DB INTEGRATION TIER — migration 171 (#2154): the temperature notes-hack data move.
//
// Driven against a MINIMAL pre-migration schema (the migration-165 test's pattern),
// so every claim is about the migration and not about whatever else the baseline
// provides:
//
//   • a purely-time "HH:MM" note on a Body Temperature row moves into occurred_at —
//     resolved against the row's own profile's timezone — and the note is cleared;
//   • a non-time note survives byte-for-byte (a lossy free-text parse touches only
//     what it can prove is the retired convention);
//   • a GLOB-passing but invalid "29:30" is left entirely untouched;
//   • another analyte's coincidental "HH:MM" note is somebody's note, not a clock;
//   • a row that already states an instant keeps it (never clobbered) while its
//     purely-time note still clears;
//   • replay-safe: a second up() finds nothing to move and changes nothing;
//   • the accounting balances (the migration throws otherwise — exercised by the
//     rows above covering every disposition).
//
// SYNTHETIC ONLY: fictional values, deep-past dates, no PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/171-temperature-note-times";

interface Row {
  id: number;
  notes: string | null;
  occurred_at: string | null;
}

function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      canonical_name TEXT,
      value_num REAL,
      source TEXT,
      notes TEXT,
      occurred_at TEXT
    );
    CREATE TABLE profile_settings (
      profile_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Profile 1 states a real zone; profile 2 has none and falls back to the
  // instance default (UTC here — the same resolution order getTimezone runs).
  mem
    .prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (1, 'timezone', 'America/New_York')"
    )
    .run();
  mem
    .prepare("INSERT INTO settings (key, value) VALUES ('timezone', 'UTC')")
    .run();

  const ins = mem.prepare(
    `INSERT INTO medical_records (id, profile_id, date, canonical_name, value_num, source, notes, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 1: the convention — a winter "07:30" in New York is 12:30Z.
  ins.run(
    1,
    1,
    "2026-01-05",
    "Body Temperature",
    100.4,
    "manual",
    "07:30",
    null
  );
  // 2: same profile, a summer reading — DST-aware: "19:40" EDT is 23:40Z.
  ins.run(
    2,
    1,
    "2025-07-10",
    "Body Temperature",
    99.1,
    "manual",
    "19:40",
    null
  );
  // 3: the fallback-zone profile — "08:05" resolves as UTC.
  ins.run(
    3,
    2,
    "2026-02-01",
    "Body Temperature",
    98.6,
    "manual",
    "08:05",
    null
  );
  // 4: a genuine free-text note — untouched.
  ins.run(
    4,
    1,
    "2026-01-06",
    "Body Temperature",
    99.5,
    "manual",
    "after ibuprofen",
    null
  );
  // 5: GLOB-passing garbage the JS re-validation must refuse.
  ins.run(
    5,
    1,
    "2026-01-07",
    "Body Temperature",
    98.9,
    "manual",
    "29:30",
    null
  );
  // 6: another analyte wearing a time-shaped note — somebody's note, not a clock.
  ins.run(6, 1, "2026-01-08", "Glucose", 94, "manual", "07:30", null);
  // 7: an instant already stands (an edit made between deploy and boot): kept,
  //    and the purely-time note still clears with the convention it rode.
  ins.run(
    7,
    1,
    "2026-01-09",
    "Body Temperature",
    100.9,
    "manual",
    "06:15",
    "2026-01-09T11:20:00Z"
  );
  // 8: an IMPORTED temperature wearing a time-shaped note — a lab's own comment
  //    on an unknown clock, never the app's convention ('manual' rows only).
  ins.run(8, 1, "2026-01-10", "Body Temperature", 100.1, "ccd", "09:00", null);
  return mem;
}

function rows(mem: Database.Database): Row[] {
  return mem
    .prepare("SELECT id, notes, occurred_at FROM medical_records ORDER BY id")
    .all() as Row[];
}

describe("migration 171 — temperature note-times move into occurred_at", () => {
  it("moves purely-time notes per the profile's own timezone and clears them", () => {
    const mem = preMigrationDb();
    up(mem);
    try {
      const byId = new Map(rows(mem).map((r) => [r.id, r]));
      expect(byId.get(1)).toEqual({
        id: 1,
        notes: null,
        occurred_at: "2026-01-05T12:30:00Z", // EST, UTC-5
      });
      expect(byId.get(2)).toEqual({
        id: 2,
        notes: null,
        occurred_at: "2025-07-10T23:40:00Z", // EDT, UTC-4 — DST honored
      });
      expect(byId.get(3)).toEqual({
        id: 3,
        notes: null,
        occurred_at: "2026-02-01T08:05:00Z", // instance-default zone
      });
    } finally {
      mem.close();
    }
  });

  it("leaves a non-time note, a malformed value, and another analyte untouched", () => {
    const mem = preMigrationDb();
    up(mem);
    try {
      const byId = new Map(rows(mem).map((r) => [r.id, r]));
      expect(byId.get(4)).toEqual({
        id: 4,
        notes: "after ibuprofen",
        occurred_at: null,
      });
      expect(byId.get(5)).toEqual({ id: 5, notes: "29:30", occurred_at: null });
      expect(byId.get(6)).toEqual({ id: 6, notes: "07:30", occurred_at: null });
      // The imported temperature keeps its note too: only 'manual' rows ever
      // carried the app's convention.
      expect(byId.get(8)).toEqual({ id: 8, notes: "09:00", occurred_at: null });
    } finally {
      mem.close();
    }
  });

  it("never clobbers a standing instant, but still clears its purely-time note", () => {
    const mem = preMigrationDb();
    up(mem);
    try {
      const row = rows(mem).find((r) => r.id === 7);
      expect(row).toEqual({
        id: 7,
        notes: null,
        occurred_at: "2026-01-09T11:20:00Z",
      });
    } finally {
      mem.close();
    }
  });

  it("is replay-safe: a second run changes nothing", () => {
    const mem = preMigrationDb();
    up(mem);
    const after = rows(mem);
    expect(() => up(mem)).not.toThrow();
    try {
      expect(rows(mem)).toEqual(after);
    } finally {
      mem.close();
    }
  });
});
