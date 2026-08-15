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
  reconcileFlags,
} from "@/lib/queries";
import { flagLabel, flagTone, isOutOfRange } from "@/lib/reference-range";

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
