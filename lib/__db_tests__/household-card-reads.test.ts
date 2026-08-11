// DB INTEGRATION TIER — the /household member-card reads (#2116).
//
// The card loop runs ONCE PER ACCESSIBLE PROFILE, so a read that is merely wasteful on
// one page is multiplied here. Two of its reads paid for far more than they used:
//
//   • the weight trend arrow pulled a 365-row daily series to look at its last two
//     points — the cost #1367 already removed from the dashboard with
//     getLatestBodyMetricDailyPoints, which /household was never migrated to;
//   • the out-of-range badge ran the full DEDUP+LATEST pass and hydrated every matching
//     row, every column plus both provider sub-selects, to take `.length`.
//
// The bar for a read-path consolidation is that BEHAVIOUR IS UNCHANGED, so this pins
// the answers against the reads they replace — including the empty and single-row cases,
// where an off-by-one in a count or a tail is invisible on a well-stocked fixture.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getBodyMetricDailySeries,
  getLatestBodyMetricDailyPoints,
  getClinicalObservations,
  countClinicalObservations,
  type ClinicalObservationFilters,
} from "@/lib/queries";
import { weightTrend } from "@/lib/household";
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

function addWeight(
  profileId: number,
  date: string,
  kg: number,
  source: string | null = null
): void {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, ?)"
  ).run(profileId, date, kg, source);
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

// The arrow exactly as /household computed it before #2116 — off the full 365-row
// series. Kept verbatim so the swap is pinned against the behaviour it replaced.
function trendTheOldWay(profileId: number) {
  const full = getBodyMetricDailySeries(profileId, "weight");
  return weightTrend(
    full[full.length - 1]?.value,
    full[full.length - 2]?.value
  );
}

describe("the household weight arrow reads two points, not a year (#2116)", () => {
  it("agrees with the full series on a long, multi-source history", () => {
    const p = makeProfile("HH Weight Long");
    const d = (n: number) => shiftDateStr(today(p), n);
    for (let i = 400; i >= 3; i -= 1) addWeight(p, d(-i), 80 + (i % 7) * 0.1);
    // Two sources on the newest day — the #14 shape the daily fold collapses to ONE
    // point. A raw-row tail would read these as two days and invent a trend.
    addWeight(p, d(-2), 79.4);
    addWeight(p, d(-1), 78.8, "withings");
    addWeight(p, d(-1), 79.9, "manual-device");

    const tail = getLatestBodyMetricDailyPoints(p, "weight");
    expect(tail).toEqual(getBodyMetricDailySeries(p, "weight").slice(-2));
    expect(
      weightTrend(tail[tail.length - 1]?.value, tail[tail.length - 2]?.value)
    ).toEqual(trendTheOldWay(p));
  });

  it("agrees on a single reading and on no readings at all", () => {
    const one = makeProfile("HH Weight One");
    addWeight(one, shiftDateStr(today(one), -1), 71.2);
    const oneTail = getLatestBodyMetricDailyPoints(one, "weight");
    expect(oneTail).toHaveLength(1);
    expect(
      weightTrend(
        oneTail[oneTail.length - 1]?.value,
        oneTail[oneTail.length - 2]?.value
      )
    ).toEqual(trendTheOldWay(one));

    const none = makeProfile("HH Weight None");
    expect(getLatestBodyMetricDailyPoints(none, "weight")).toEqual([]);
    expect(weightTrend(undefined, undefined)).toEqual(trendTheOldWay(none));
  });
});

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
