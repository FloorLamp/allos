// DB INTEGRATION TIER — enum enforcement parity (issue #328, part 4).
//
// A state machine backed by a DB CHECK has THREE representations that must agree:
// the CHECK's `IN (...)` list, the TS union, and (where present) a runtime array
// used by option/accept lists. When they drift, the next added state ships silently
// broken — exactly how 'committing' shipped against a CHECK that forbade it (#323).
//
// This is the "one test, all enums" cheap guard: for each column below it reads the
// EFFECTIVE CHECK off the live schema (baseline + every migration applied, so a
// rebuild like #015/#016 is reflected) and asserts its value set EQUALS the runtime
// array that is the single source of truth for the matching TS union (each array is
// declared `(typeof ARR)[number]` → the union, so the union can't drift from the
// array). Add a state to a union ⇒ its array grows ⇒ this test fails until the CHECK
// migration lands too (and vice-versa).
//
// Deterministic: :memory: only, no network.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";
import { MEDICAL_CATEGORIES } from "@/lib/medical-categories";
import {
  ALLERGY_STATUSES,
  APPOINTMENT_STATUSES,
  CONDITION_STATUSES,
  GOAL_STATUSES,
  SUGGESTION_STATUSES,
} from "@/lib/types";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  migrate(db); // baseline + every numbered migration + boot tasks
  return db;
}

function tableSql(db: Database.Database, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`table ${table} not found`);
  return row.sql;
}

// Extract the value set from a `<column> ... CHECK (<column> IN ('a','b',...))`
// clause in a table's CREATE SQL. Returns the literals as a sorted array.
function checkInList(sql: string, column: string): string[] {
  const m = sql.match(new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`));
  if (!m) throw new Error(`no CHECK ... ${column} IN (...) found`);
  const literals = m[1].match(/'([^']*)'/g);
  if (!literals) throw new Error(`empty IN list for ${column}`);
  return literals.map((l) => l.slice(1, -1)).sort();
}

// (table, column) → the runtime array that is the union's single source of truth.
const REGISTRY: {
  table: string;
  column: string;
  expected: readonly string[];
}[] = [
  { table: "goals", column: "status", expected: GOAL_STATUSES },
  { table: "appointments", column: "status", expected: APPOINTMENT_STATUSES },
  { table: "allergies", column: "status", expected: ALLERGY_STATUSES },
  { table: "conditions", column: "status", expected: CONDITION_STATUSES },
  {
    table: "intake_item_suggestions",
    column: "status",
    expected: SUGGESTION_STATUSES,
  },
  {
    table: "medical_records",
    column: "category",
    expected: MEDICAL_CATEGORIES,
  },
];

describe("enum enforcement parity — DB CHECK ⇔ TS union/array", () => {
  it.each(REGISTRY)(
    "$table.$column CHECK matches its TS source array",
    ({ table, column, expected }) => {
      const db = newDb();
      const inList = checkInList(tableSql(db, table), column);
      expect(inList).toEqual([...expected].sort());
      db.close();
    }
  );

  it("goals.status specifically no longer admits 'archived' (migration 016)", () => {
    const db = newDb();
    expect(checkInList(tableSql(db, "goals"), "status")).not.toContain(
      "archived"
    );
    db.close();
  });
});
