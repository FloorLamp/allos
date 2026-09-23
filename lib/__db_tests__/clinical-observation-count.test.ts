// DB INTEGRATION TIER — countClinicalObservations against the row read it replaced
// (#2116). The bar for a read-path consolidation is that BEHAVIOUR IS UNCHANGED, so
// this pins the count against the list — including the empty and single-row cases,
// where an off-by-one is invisible on a well-stocked fixture.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getClinicalObservations,
  countClinicalObservations,
  type ClinicalObservationFilters,
} from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";

function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(id);
  return id;
}

function addObservation(
  profileId: number,
  name: string,
  flag: string | null,
  opts: { date?: string; category?: string } = {}
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, flag)
     VALUES (?, ?, ?, ?, ?, ?, 'mg/dL', ?, ?)`
  ).run(
    profileId,
    opts.date ?? today(profileId),
    opts.category ?? "lab",
    name,
    "1",
    1,
    name,
    flag
  );
}

describe("countClinicalObservations counts what the list would list (#2116)", () => {
  function seedMixed(name: string): number {
    const p = makeProfile(name);
    const d = (n: number) => shiftDateStr(today(p), n);
    // One analyte whose CURRENT reading is normal but whose history is flagged — the
    // superseded case a count over the wrong set would get wrong.
    addObservation(p, "Ferritin", "low", { date: d(-200) });
    addObservation(p, "Ferritin", "normal", { date: d(-10) });
    // Two analytes currently out of range, and one currently non-optimal (out of the
    // 'oor' flag set but inside 'nonoptimal').
    addObservation(p, "LDL Cholesterol", "high", { date: d(-5) });
    addObservation(p, "Vitamin D", "low", { date: d(-5) });
    addObservation(p, "Fasting Insulin", "non-optimal-high", { date: d(-5) });
    // A flagged reading in another category, so a category filter has something to bite.
    addObservation(p, "Body Temperature", "high", {
      date: d(-3),
      category: "vitals",
    });
    return p;
  }

  const FILTERS: ClinicalObservationFilters[] = [
    {},
    { current: true },
    { current: true, range: "oor" },
    { current: true, range: "nonoptimal" },
    { range: "oor" },
    { category: "lab", current: true, range: "oor" },
    { category: "vitals", current: true, range: "oor" },
    { excludeCategories: ["vitals"], current: true, range: "oor" },
    { q: "cholesterol" },
    // Selects nothing — the case a COUNT can get wrong most quietly.
    { category: "imaging", current: true, range: "oor" },
  ];

  it("equals the row read's length on every filter shape the badge and browser use", () => {
    const p = seedMixed("HH OOR Mixed");
    for (const filters of FILTERS) {
      expect(
        countClinicalObservations(p, filters),
        `filters: ${JSON.stringify(filters)}`
      ).toBe(getClinicalObservations(p, filters).length);
    }
    // The fixture is real: the badge's own filter finds the two currently-flagged
    // labs and NOT the superseded Ferritin low.
    const badge = getClinicalObservations(p, { current: true, range: "oor" });
    expect(badge.map((r) => r.name).sort()).toEqual([
      "Body Temperature",
      "LDL Cholesterol",
      "Vitamin D",
    ]);
    expect(countClinicalObservations(p, { current: true, range: "oor" })).toBe(
      3
    );
  });

  it("counts zero for a profile with no records, and one for exactly one", () => {
    const empty = makeProfile("HH OOR Empty");
    for (const filters of FILTERS) {
      expect(countClinicalObservations(empty, filters)).toBe(0);
    }
    const single = makeProfile("HH OOR Single");
    addObservation(single, "Vitamin D", "low");
    expect(
      countClinicalObservations(single, { current: true, range: "oor" })
    ).toBe(1);
    expect(
      countClinicalObservations(single, { current: true, range: "oor" })
    ).toBe(
      getClinicalObservations(single, { current: true, range: "oor" }).length
    );
  });

  it("stays scoped to its own profile", () => {
    const mine = seedMixed("HH OOR Mine");
    const theirs = seedMixed("HH OOR Theirs");
    addObservation(theirs, "Magnesium", "low");
    expect(
      countClinicalObservations(mine, { current: true, range: "oor" })
    ).toBe(
      getClinicalObservations(mine, { current: true, range: "oor" }).length
    );
    expect(
      countClinicalObservations(theirs, { current: true, range: "oor" })
    ).toBe(
      countClinicalObservations(mine, { current: true, range: "oor" }) + 1
    );
  });
});
