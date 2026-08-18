// DB INTEGRATION TIER — the two flag-truth rulings, over the REAL canonical table
// (#2794 pediatric BP, #2799 the lab's own printed range).
//
// WHY THIS TIER. Both decisions are pure and unit-tested next door. What only this tier
// can prove is the JOIN: that the catalog seeded into `canonical_result_definitions`
// really does leave these analytes band-less, that `reconcileFlags` resolves the
// frame-unstated set from that same catalog, and that the flags it WRITES are the ones
// the surfaces then read. The #2337 non-regression in particular is a claim about the
// real Glucose entry beside the real `Glucose, Fasting` one — a fixture entry could not
// make it.
//
// SYNTHETIC ONLY: an invented profile, invented values, invented printed ranges. No PHI.

import { describe, expect, it, beforeAll } from "vitest";

import { db } from "@/lib/db";
import {
  getCanonicalResultDefinition,
  getCurrentFlaggedBiomarkers,
  getCurrentFlaggedVitals,
  reconcileFlags,
} from "@/lib/queries";
import { rangeFilterClause } from "@/lib/queries/medical";
import {
  flagInSql,
  flagLabel,
  flagTone,
  isLabStated,
  isNonOptimal,
  isNotableFlag,
  isOutOfRange,
  LAB_STATED_FLAGS,
  NON_OPTIMAL_FLAGS,
  OUT_OF_RANGE_FLAGS,
} from "@/lib/reference-range";
import { getTimelineEvents } from "@/lib/timeline";
import type { MedicalFlag } from "@/lib/types";

const DRAW = "2026-02-17";
// The adult subject was born far enough back that every DRAW-dated reading is judged in
// the adult regime; the child is 22 months on the draw date, the walkthrough's persona.
const ADULT_BIRTHDATE = "1971-04-02";
const CHILD_BIRTHDATE = "2024-04-02";

let adultId: number;
let childId: number;

function insert(
  profileId: number,
  r: {
    canonical: string;
    category: string;
    value: number;
    unit: string;
    printed: string | null;
    flag?: string | null;
    date?: string;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num, unit,
            reference_range, flag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        r.date ?? DRAW,
        r.category,
        r.canonical,
        r.canonical,
        String(r.value),
        r.value,
        r.unit,
        r.printed,
        r.flag ?? null
      ).lastInsertRowid
  );
}

function flagOf(id: number): string | null {
  return (
    (
      db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as {
        flag: string | null;
      }
    ).flag ?? null
  );
}

function makeProfile(name: string, birthdate: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', ?)`
  ).run(id, birthdate);
  return id;
}

// The rows every assertion below reads back.
const ids: Record<string, number> = {};

beforeAll(() => {
  adultId = makeProfile("flagtruth_adult", ADULT_BIRTHDATE);
  childId = makeProfile("flagtruth_child", CHILD_BIRTHDATE);

  // ── #2799 — the issue's own reading, and its in-range predecessor ──────────────
  ids.uacrRising = insert(adultId, {
    canonical: "Microalbumin/Creatinine Ratio, Urine",
    category: "lab",
    value: 44,
    unit: "mg/g",
    printed: "<30",
  });
  ids.uacrNormal = insert(adultId, {
    canonical: "Microalbumin/Creatinine Ratio, Urine",
    category: "lab",
    value: 22,
    unit: "mg/g",
    printed: "<30",
    date: "2025-02-17",
  });
  // The same band-less analyte with NO printed range: still nothing to judge by.
  ids.uacrBare = insert(adultId, {
    canonical: "Microalbumin/Creatinine Ratio, Urine",
    category: "lab",
    value: 44,
    unit: "mg/g",
    printed: null,
    date: "2024-02-17",
  });

  // ── #2337 non-regression — the reading migration 176 unflagged ─────────────────
  // A post-meal 120 mg/dL beside the CMP's own printed fasting interval, filed under
  // the UNQUALIFIED entry because the document never stated a fasting state.
  ids.glucosePostMeal = insert(adultId, {
    canonical: "Glucose",
    category: "lab",
    value: 120,
    unit: "mg/dL",
    printed: "65-99",
  });
  // The CGM-shaped row the diabetic-cgm persona seeds by the hundred (a vitals-category
  // glucose carrying the same printed interval).
  ids.glucoseCgm = insert(adultId, {
    canonical: "Glucose",
    category: "vitals",
    value: 168,
    unit: "mg/dL",
    printed: "65-99",
  });
  // The frame-STATED sibling, at the same number, must still flag against 70–99.
  ids.glucoseFasting = insert(adultId, {
    canonical: "Glucose, Fasting",
    category: "lab",
    value: 120,
    unit: "mg/dL",
    printed: "65-99",
  });
  // The other two frame-unstated entries, for the same reason.
  ids.insulin = insert(adultId, {
    canonical: "Insulin",
    category: "lab",
    value: 40,
    unit: "uIU/mL",
    printed: "2.6-24.9",
  });
  ids.cortisol = insert(adultId, {
    canonical: "Cortisol",
    category: "lab",
    value: 3,
    unit: "ug/dL",
    printed: "6-18",
  });

  // ── #2799 defect A — band-less HIGHER-BETTER vitals beating a printed range ───
  // A PFT or CPET report always prints a predicted range, and a healthy person above
  // predicted is the common case. All of these are `category: vitals`, so a flag here
  // reaches getCurrentFlaggedVitals → recent-changes → the digest.
  ids.fev1 = insert(adultId, {
    canonical: "Forced Expiratory Volume in 1 Second (FEV1)",
    category: "vitals",
    value: 4.6,
    unit: "L",
    printed: "3.1-4.2",
  });
  ids.fvc = insert(adultId, {
    canonical: "Forced Vital Capacity (FVC)",
    category: "vitals",
    value: 5.9,
    unit: "L",
    printed: "4.0-5.4",
  });
  ids.peakFlow = insert(adultId, {
    canonical: "Peak Expiratory Flow",
    category: "vitals",
    value: 680,
    unit: "L/min",
    printed: "480-620",
  });
  ids.grip = insert(adultId, {
    canonical: "Grip Strength",
    category: "vitals",
    value: 58,
    unit: "kg",
    printed: "35-50",
  });
  ids.chairStand = insert(adultId, {
    canonical: "30-Second Chair Stand",
    category: "vitals",
    value: 24,
    unit: "reps",
    printed: "14-19",
  });
  // …and the same analyte BELOW its predicted range, which is the direction that means
  // something and must still speak.
  ids.fev1Low = insert(adultId, {
    canonical: "Forced Expiratory Volume in 1 Second (FEV1)",
    category: "vitals",
    value: 2.0,
    unit: "L",
    printed: "3.1-4.2",
    date: "2025-02-17",
  });

  // ── #2794 — a toddler's blood pressure, already carrying the adult-band flags ──
  ids.childDiastolic = insert(childId, {
    canonical: "Blood Pressure Diastolic",
    category: "vitals",
    value: 54,
    unit: "mmHg",
    printed: "60-80",
    flag: "low",
  });
  ids.childSystolic = insert(childId, {
    canonical: "Blood Pressure Systolic",
    category: "vitals",
    value: 98,
    unit: "mmHg",
    printed: "90-120",
    flag: null,
  });
  // A pediatric lab that IS age-banded stays judged — the carve-out is BP-only.
  ids.childAlp = insert(childId, {
    canonical: "Alkaline Phosphatase",
    category: "lab",
    value: 300,
    unit: "U/L",
    printed: "40-129",
    flag: "high",
  });
  ids.adultDiastolic = insert(adultId, {
    canonical: "Blood Pressure Diastolic",
    category: "vitals",
    value: 54,
    unit: "mmHg",
    printed: "60-80",
  });

  reconcileFlags(adultId);
  reconcileFlags(childId);
});

describe("the catalog these rulings are premised on", () => {
  it("really does leave the four analytes band-less", () => {
    for (const name of [
      "Microalbumin/Creatinine Ratio, Urine",
      "Glucose",
      "Insulin",
      "Cortisol",
    ]) {
      const cb = getCanonicalResultDefinition(name);
      expect(cb, name).toBeTruthy();
      expect(cb?.ref_low ?? null, name).toBeNull();
      expect(cb?.ref_high ?? null, name).toBeNull();
    }
    // …and that the BP entries carry ONLY the adult interval, with no age bands —
    // which is the whole of #2794's mechanism.
    const dia = getCanonicalResultDefinition("Blood Pressure Diastolic");
    expect(dia?.ref_low).toBe(60);
    expect(dia?.ref_high).toBe(80);
    expect(dia?.ranges_by_age ?? null).toBeNull();
  });
});

describe("a value outside the lab's printed range gets a lab-stated flag (#2799)", () => {
  it("flags the rising microalbumin the app used to render unmarked", () => {
    expect(flagOf(ids.uacrRising)).toBe("reported-high");
  });

  it("leaves the in-range draw and the range-less draw unflagged", () => {
    expect(flagOf(ids.uacrNormal)).toBeNull();
    expect(flagOf(ids.uacrBare)).toBeNull();
  });

  it("re-running the reconcile is a no-op, not a churn", () => {
    const before = reconcileFlags(adultId);
    expect(before).toBe(0);
    expect(flagOf(ids.uacrRising)).toBe("reported-high");
  });

  it("clears the flag once the value is corrected back inside the printed range", () => {
    db.prepare(
      "UPDATE medical_records SET value = '22', value_num = 22 WHERE id = ?"
    ).run(ids.uacrRising);
    reconcileFlags(adultId, [ids.uacrRising]);
    expect(flagOf(ids.uacrRising)).toBeNull();
    // Put it back for any later reader of this fixture.
    db.prepare(
      "UPDATE medical_records SET value = '44', value_num = 44 WHERE id = ?"
    ).run(ids.uacrRising);
    reconcileFlags(adultId, [ids.uacrRising]);
    expect(flagOf(ids.uacrRising)).toBe("reported-high");
  });
});

describe("what the lab-stated flag reaches, and what it must not", () => {
  it("reaches the flagged-biomarker read behind /upcoming and the care hero", () => {
    // The issue's second symptom: "no follow-up ever reaches /upcoming for it". The
    // shared read's denylist is `flag NOT IN ('normal','immune')`, so a lab-stated flag
    // qualifies on the same footing as a non-optimal one — which is the intent, since
    // the whole complaint is that the persona's key rising-risk lab raised nothing.
    const flagged = getCurrentFlaggedBiomarkers(adultId);
    const uacr = flagged.find(
      (f) => f.name === "Microalbumin/Creatinine Ratio, Urine"
    );
    expect(uacr?.flag).toBe("reported-high");
    // …and the unqualified glucose still raises nothing at all.
    expect(flagged.some((f) => f.name === "Glucose")).toBe(false);
  });

  it("does NOT claim to be out of range on any surface that counts them", () => {
    // isOutOfRange is what the timeline's abnormal count, the `oor` row filter and the
    // attention priority bump all read. A lab's printed range is not our range.
    expect(isOutOfRange("reported-high")).toBe(false);
    expect(flagTone("reported-high")).toBe("warn");
    expect(flagLabel("reported-high")).toBe("Above reported range");
  });
});

describe("the #2337 ruling still holds (unqualified Glucose stays silent)", () => {
  it("does NOT re-flag a post-meal glucose beside a printed fasting interval", () => {
    // The exact row migration 176 cleared. A lab-stated flag here would re-commit the
    // fasting frame the document never claimed — a normal post-meal 120 reading red.
    expect(flagOf(ids.glucosePostMeal)).toBeNull();
  });

  it("does NOT light up the CGM stream the diabetic-cgm persona seeds", () => {
    expect(flagOf(ids.glucoseCgm)).toBeNull();
  });

  it("still flags the FASTING sibling, which does state its frame", () => {
    expect(flagOf(ids.glucoseFasting)).toBe("high");
  });

  it("covers the other two frame-unstated entries the same way (#2371, #2526)", () => {
    expect(flagOf(ids.insulin)).toBeNull();
    expect(flagOf(ids.cortisol)).toBeNull();
  });
});

describe("a good result never flags — the printed range is read through direction", () => {
  it("leaves five band-less higher-better vitals unflagged for BEATING their printed range", () => {
    // Asserted over the REAL curated entries, so the claim is about the catalog's own
    // `direction` values rather than a fixture's. This is #544's "good result reads as
    // needs-attention" rule, held at the door #2799 opened.
    for (const key of ["fev1", "fvc", "peakFlow", "grip", "chairStand"]) {
      expect(flagOf(ids[key]), key).toBeNull();
    }
  });

  it("every one of those entries really is band-less and higher_better", () => {
    // If a band were curated onto one, the row would never reach labStatedFlag and the
    // assertion above would pass for the wrong reason.
    for (const name of [
      "Forced Expiratory Volume in 1 Second (FEV1)",
      "Forced Vital Capacity (FVC)",
      "Peak Expiratory Flow",
      "Grip Strength",
      "30-Second Chair Stand",
    ]) {
      const cb = getCanonicalResultDefinition(name);
      expect(cb?.direction, name).toBe("higher_better");
      expect(cb?.ref_low ?? null, name).toBeNull();
      expect(cb?.ref_high ?? null, name).toBeNull();
      expect(cb?.optimal_low ?? null, name).toBeNull();
      expect(cb?.optimal_high ?? null, name).toBeNull();
    }
  });

  it("still flags the direction that means something — FEV1 below predicted", () => {
    expect(flagOf(ids.fev1Low)).toBe("reported-low");
  });

  it("keeps all five out of the flagged-VITALS read the digest builds from", () => {
    const flagged = getCurrentFlaggedVitals(adultId).map((f) => f.name);
    for (const name of [
      "Forced Vital Capacity (FVC)",
      "Peak Expiratory Flow",
      "Grip Strength",
      "30-Second Chair Stand",
    ]) {
      expect(flagged, name).not.toContain(name);
    }
  });
});

describe("pediatric blood pressure defers to the AAP percentile (#2794)", () => {
  it("clears the adult-band 'low' stored on a toddler's diastolic", () => {
    expect(flagOf(ids.childDiastolic)).toBeNull();
  });

  it("derives no flag for the child's systolic either", () => {
    expect(flagOf(ids.childSystolic)).toBeNull();
  });

  it("does not stop judging the child's age-banded labs", () => {
    // ALP 300 U/L is the canonical false-"high" against the adult 40–129 and normal for
    // a one-year-old against the age band — so the reconcile CLEARS it, on its own
    // pre-existing mechanism. Nothing about #2794 reaches it.
    expect(flagOf(ids.childAlp)).toBeNull();
  });

  it("still judges an ADULT's blood pressure against the adult band", () => {
    expect(flagOf(ids.adultDiastolic)).toBe("low");
  });
});

// EVERY SQL SPELLING OF THE TIERS, AGAINST THE PREDICATES.
//
// The tiers had three independent spellings — the TS predicates, `rangeFilterClause`,
// and lib/timeline's grouped counts — and #2799's two new flag values reached only two
// of them: the timeline kept counting `LIKE 'non-optimal%'`, so the reading the issue is
// about drew no marker on the surface the issue names. The lists now live once in
// lib/reference-range/flags and every spelling reads them, and this test is what holds
// that: it compares the SQL each surface actually emits, not the constants.
describe("SQL/predicate parity across every flag-tier spelling", () => {
  // The literals a `flag IN (...)` clause admits.
  function admitted(clause: string | null): Set<string> {
    if (!clause) return new Set();
    return new Set([...clause.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  }

  const ALL_FLAGS: MedicalFlag[] = [
    "normal",
    "high",
    "low",
    "abnormal",
    "immune",
    "non-optimal",
    "non-optimal-high",
    "non-optimal-low",
    "reported-high",
    "reported-low",
  ];

  it("'oor' admits exactly the isOutOfRange flags", () => {
    expect([...admitted(rangeFilterClause("oor"))].sort()).toEqual(
      ALL_FLAGS.filter(isOutOfRange).sort()
    );
  });

  it("'nonoptimal' admits exactly the isNotableFlag flags", () => {
    expect([...admitted(rangeFilterClause("nonoptimal"))].sort()).toEqual(
      ALL_FLAGS.filter(isNotableFlag).sort()
    );
  });

  it("keeps the lab-stated flags OUT of 'out of range' and IN the broad tier", () => {
    // "Out of range only" must keep meaning OUR clinical verdict. The broad filter is
    // the one a person uses to see what needs a look — and it feeds the passport's
    // flagged-vitals list — so the reading this issue is about has to be in it.
    const oor = admitted(rangeFilterClause("oor"));
    const notable = admitted(rangeFilterClause("nonoptimal"));
    for (const f of ["reported-high", "reported-low"]) {
      expect(oor.has(f)).toBe(false);
      expect(notable.has(f)).toBe(true);
    }
  });

  it("'All' adds no clause", () => {
    expect(rangeFilterClause(undefined)).toBeNull();
  });

  it("the three per-tier SQL fragments admit exactly their predicates", () => {
    expect([...admitted(flagInSql(OUT_OF_RANGE_FLAGS))].sort()).toEqual(
      ALL_FLAGS.filter(isOutOfRange).sort()
    );
    expect([...admitted(flagInSql(NON_OPTIMAL_FLAGS))].sort()).toEqual(
      ALL_FLAGS.filter(isNonOptimal).sort()
    );
    expect([...admitted(flagInSql(LAB_STATED_FLAGS))].sort()).toEqual(
      ALL_FLAGS.filter(isLabStated).sort()
    );
  });

  it("every notable flag is counted by exactly one of the timeline's three counts", () => {
    // The timeline groups a draw into "N results, M out of range / non-optimal /
    // outside reported range". A flag in none of the three counts renders no marker at
    // all, which is #2799's complaint; a flag in two would be double-counted.
    for (const f of ALL_FLAGS) {
      const counts = [
        OUT_OF_RANGE_FLAGS,
        NON_OPTIMAL_FLAGS,
        LAB_STATED_FLAGS,
      ].filter((tier) => admitted(flagInSql(tier)).has(f));
      expect(counts.length, `flag=${f}`).toBe(isNotableFlag(f) ? 1 : 0);
    }
  });
});

describe("the timeline draws a marker for a lab-stated flag (#2799 defect D)", () => {
  it("counts it, tones the group amber, and says which range it was outside", () => {
    const events = getTimelineEvents(adultId, { limit: 200 });
    const group = events.find(
      (e) =>
        e.category === "medical" &&
        e.date === DRAW &&
        (e.detail ?? "").includes("Microalbumin")
    );
    expect(
      group,
      "the urinalysis draw should produce a timeline group"
    ).toBeTruthy();
    expect(group?.subtitle).toContain("outside reported range");
    expect(group?.tone).toBe("warn");
  });
});
