// DB INTEGRATION TIER — issue #2673: the `backed` backfill counted a row that
// carries no result identity, and 20260813-saved-backed-identity-repair undoes it.
//
// Driven against a MINIMAL pre-migration schema (the migration-165/171/174/177
// pattern) so every claim is about these two migrations and not about whatever else
// the baseline supplies. The fixture is the database the issue describes and the one
// CI never had: `saved_items` rows that ALREADY EXIST when the backfill runs. Every
// other DB-tier test builds a fresh schema before any star is saved, so the backfill
// only ever reached its `stars.length === 0` early return — which is exactly why the
// family-matching body was never exercised.
//
// The sequence under test is the real one: run the shipped backfill (which is
// hash-locked and cannot be corrected in place), then the repair, and assert the END
// STATE the issue asks for — a watch-star backed only by an `assessment` row comes
// out at `backed = 0`.
//
// SYNTHETIC ONLY: fictional profiles, deep-past dates, invented values. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up as upBackfill } from "@/lib/migrations/versions/20260812-saved-biomarker-backed";
import { up as upRepair } from "@/lib/migrations/versions/20260813-saved-backed-identity-repair";

const DATE = "2017-03-09";

// A star whose ONLY family member in medical_records is an `assessment` row: the
// watch the defect breaks.
const WATCHED = "Ferritin";
// A star with a real lab reading behind it: backed, and it must STAY backed.
const MEASURED = "Serum Sodium";
// A star nobody has any record for at all. Outside the defect's blast radius —
// the buggy query never matched it — and it must stay at 0.
const UNMEASURED = "Lipoprotein(a)";
// A star whose #482 FAMILY has both an assessment row and a real reading, under two
// different member spellings. The real one wins: identity is a property of the
// family, not of the row that happens to share the star's exact name. (Both of these
// resolve to `family:vitamin-d-25-hydroxy`; the D2/D3 isoforms deliberately do NOT
// join that family, so they would not have made this case.)
const MIXED = "Vitamin D, 25-Hydroxy";
const MIXED_SIBLING = "25-OH Vitamin D";

function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT,
      value_num REAL,
      unit TEXT,
      canonical_name TEXT
    );
    CREATE TABLE saved_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL COLLATE NOCASE,
      UNIQUE(profile_id, kind, key)
    );
  `);
  return mem;
}

interface RecordSeed {
  profileId?: number;
  name: string;
  category: string;
  canonicalName?: string | null;
  value?: string | null;
  valueNum?: number | null;
  unit?: string | null;
}

function addRecord(mem: Database.Database, s: RecordSeed): void {
  mem
    .prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.profileId ?? 1,
      DATE,
      s.category,
      s.name,
      s.canonicalName === undefined ? s.name : s.canonicalName,
      s.value ?? null,
      s.valueNum ?? null,
      s.unit ?? null
    );
}

function star(mem: Database.Database, key: string, profileId = 1): void {
  mem
    .prepare(
      "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
    )
    .run(profileId, key);
}

function backedOf(
  mem: Database.Database,
  key: string,
  profileId = 1
): number | undefined {
  return (
    mem
      .prepare(
        "SELECT backed FROM saved_items WHERE profile_id = ? AND kind = 'biomarker' AND key = ?"
      )
      .get(profileId, key) as { backed: number } | undefined
  )?.backed;
}

function allBacked(mem: Database.Database): Record<string, number> {
  const rows = mem
    .prepare(
      "SELECT profile_id, key, backed FROM saved_items WHERE kind = 'biomarker' ORDER BY profile_id, key"
    )
    .all() as { profile_id: number; key: string; backed: number }[];
  return Object.fromEntries(
    rows.map((r) => [`${r.profile_id} ${r.key}`, r.backed])
  );
}

// The database the issue found: stars saved BEFORE the column existed, one of them
// a watch whose only family member is a re-homed `assessment` row (migration 177
// keeps `canonical_name` on those as provenance — lib/assessment-reclass-db.ts).
function seeded(): Database.Database {
  const mem = preMigrationDb();
  for (const key of [WATCHED, MEASURED, UNMEASURED, MIXED]) star(mem, key);

  addRecord(mem, { name: WATCHED, category: "assessment", value: "Deferred" });
  addRecord(mem, {
    name: MEASURED,
    category: "lab",
    value: "140",
    valueNum: 140,
    unit: "mmol/L",
  });
  addRecord(mem, { name: MIXED, category: "assessment", value: "Not done" });
  addRecord(mem, {
    name: MIXED_SIBLING,
    category: "lab",
    value: "44",
    valueNum: 44,
    unit: "ng/mL",
  });
  return mem;
}

describe("the shipped backfill marks a watch-star from an assessment row (#2673)", () => {
  it("is the defect: an assessment-only family comes out backed", () => {
    const mem = seeded();
    upBackfill(mem);
    // Pinned as the STATE THE REPAIR INHERITS, not as desired behaviour. The file
    // is hash-locked; this is what every already-upgraded database carries.
    expect(backedOf(mem, WATCHED)).toBe(1);
    expect(backedOf(mem, MIXED)).toBe(1);
    // The two it got right.
    expect(backedOf(mem, MEASURED)).toBe(1);
    expect(backedOf(mem, UNMEASURED)).toBe(0);
  });
});

describe("20260813-saved-backed-identity-repair (#2673)", () => {
  it("resets a star whose only backing record carries no result identity", () => {
    const mem = seeded();
    upBackfill(mem);
    upRepair(mem);
    expect(backedOf(mem, WATCHED)).toBe(0);
  });

  it("leaves a star with a real reading backed", () => {
    const mem = seeded();
    upBackfill(mem);
    upRepair(mem);
    expect(backedOf(mem, MEASURED)).toBe(1);
  });

  it("keeps a star backed when ANY family member carries identity", () => {
    const mem = seeded();
    upBackfill(mem);
    upRepair(mem);
    // The #482 family collapse: the assessment row on "Vitamin D, 25-Hydroxy" does
    // not un-back a star its D3 sibling's lab reading legitimately stands behind.
    expect(backedOf(mem, MIXED)).toBe(1);
  });

  it("never touches a star with no family record at all", () => {
    const mem = seeded();
    upBackfill(mem);
    upRepair(mem);
    expect(backedOf(mem, UNMEASURED)).toBe(0);
  });

  it("leaves a GENUINE orphan backed — its readings existed and were deleted", () => {
    const mem = seeded();
    upBackfill(mem);
    // The lab reading goes, and nothing non-identity replaces it. The star is now
    // an orphan the sweep should still take; amnesty here would be unearned.
    mem
      .prepare("DELETE FROM medical_records WHERE canonical_name = ?")
      .run(MEASURED);
    upRepair(mem);
    expect(backedOf(mem, MEASURED)).toBe(1);
  });

  it("is profile-scoped: another profile's readings decide nothing", () => {
    const mem = preMigrationDb();
    star(mem, WATCHED, 1);
    star(mem, WATCHED, 2);
    // Profile 1 has only the assessment; profile 2 has the real lab reading.
    addRecord(mem, { profileId: 1, name: WATCHED, category: "assessment" });
    addRecord(mem, {
      profileId: 2,
      name: WATCHED,
      category: "lab",
      value: "80",
      valueNum: 80,
      unit: "ng/mL",
    });

    upBackfill(mem);
    upRepair(mem);

    expect(backedOf(mem, WATCHED, 1)).toBe(0);
    expect(backedOf(mem, WATCHED, 2)).toBe(1);
  });

  it("ignores a non-biomarker save entirely", () => {
    const mem = seeded();
    mem
      .prepare(
        "INSERT INTO saved_items (profile_id, kind, key) VALUES (1, 'trend-metric', ?)"
      )
      .run("weight");
    upBackfill(mem);
    const before = mem
      .prepare(
        "SELECT backed FROM saved_items WHERE kind = 'trend-metric' AND key = 'weight'"
      )
      .get();
    upRepair(mem);
    expect(
      mem
        .prepare(
          "SELECT backed FROM saved_items WHERE kind = 'trend-metric' AND key = 'weight'"
        )
        .get()
    ).toEqual(before);
  });

  it("is idempotent — a second run changes nothing", () => {
    const mem = seeded();
    upBackfill(mem);
    upRepair(mem);
    const snapshot = allBacked(mem);
    upRepair(mem);
    expect(allBacked(mem)).toEqual(snapshot);
  });

  it("runs on a database with no stars, and on one with no `backed` column", () => {
    const empty = preMigrationDb();
    upBackfill(empty);
    expect(() => upRepair(empty)).not.toThrow();

    // An out-of-order dev database that has not applied the backfill yet: no
    // column, so no wrong mark to undo.
    const columnless = preMigrationDb();
    star(columnless, WATCHED);
    expect(() => upRepair(columnless)).not.toThrow();
    expect(
      columnless.prepare("PRAGMA table_info(saved_items)").all()
    ).not.toContainEqual(expect.objectContaining({ name: "backed" }));
  });
});
