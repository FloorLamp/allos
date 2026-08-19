// SCRATCH REPRO — deleted before the PR. Pins the CURRENT (defective) behaviour of
// #3050 and #2937 against main, so the fix can be shown to flip it.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  getBioAgeReadings,
  getCurrentFlaggedBiomarkers,
  reconcileFlags,
} from "@/lib/queries";
import { rangeFilterClause } from "@/lib/queries/medical";
import { setProfileBirthdate } from "@/lib/settings";
import {
  bioAgeSurface,
  completenessChecklistMessage,
  inputCompleteness,
} from "@/lib/bio-age";
import { flagLabel, isNormalFlag, isNotableFlag } from "@/lib/reference-range";
import { biomarkerFlagDetail } from "@/lib/biomarker-flag-copy";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertLab(
  profileId: number,
  canonical: string,
  unit: string,
  value: string,
  valueNum: number | null,
  date: string,
  flag?: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        date,
        canonical,
        value,
        unit,
        canonical,
        valueNum,
        flag ?? null
      ).lastInsertRowid
  );
}

// The eight non-albumin PhenoAge inputs.
function seedEightNonAlbumin(profileId: number, date: string): void {
  insertLab(profileId, "Creatinine", "mg/dL", "0.9", 0.9, date);
  insertLab(profileId, "Glucose", "mg/dL", "90", 90, date);
  insertLab(profileId, "Lymphocytes", "%", "32", 32, date);
  insertLab(profileId, "Mean Corpuscular Volume (MCV)", "fL", "89", 89, date);
  insertLab(
    profileId,
    "Red Cell Distribution Width (RDW)",
    "%",
    "13",
    13,
    date
  );
  insertLab(profileId, "Alkaline Phosphatase", "U/L", "62", 62, date);
  insertLab(profileId, "White Blood Cell Count", "10^3/uL", "5.5", 5.5, date);
  insertLab(
    profileId,
    "High-Sensitivity C-Reactive Protein (hs-CRP)",
    "mg/L",
    "0.4",
    0.4,
    date
  );
}

describe("#3050 REPRO — nine ticked, no single complete draw", () => {
  it("claims completeness while the linked section renders nothing", () => {
    const p = newProfile("repro3050");
    setProfileBirthdate(p, "1980-01-01");
    // Albumin from an old draw; the other eight from a recent one. Nine ever, none together.
    insertLab(p, "Albumin", "g/dL", "4.4", 4.4, "2020-02-02");
    seedEightNonAlbumin(p, "2026-06-03");

    const { draws, presentInputs } = getBioAgeReadings(p);
    const c = inputCompleteness(presentInputs);
    console.log("presentInputs:", presentInputs.length, "draws:", draws.length);
    console.log("status sentence:", completenessChecklistMessage(c));
    console.log(
      "card surface:",
      bioAgeSurface(false, draws.length, c.presentCount),
      "| longevity hero renders:",
      bioAgeSurface(false, draws.length, c.presentCount) === "hero"
    );

    expect(c.complete).toBe(true);
    expect(c.presentCount).toBe(9);
    expect(completenessChecklistMessage(c)).toBe("All 9 inputs present.");
    // …and yet there is no computed draw at all, so /longevity#bio-age renders nothing.
    expect(draws).toHaveLength(0);
    expect(bioAgeSurface(false, draws.length, c.presentCount)).toBe(
      "checklist"
    );
  });

  it("a complete draw is named nowhere on the card (only draws.length is used)", () => {
    const p = newProfile("repro3050b");
    setProfileBirthdate(p, "1980-01-01");
    insertLab(p, "Albumin", "g/dL", "4.4", 4.4, "2026-06-03");
    seedEightNonAlbumin(p, "2026-06-03");
    // A NEWER partial re-draw: everything but hs-CRP.
    insertLab(p, "Albumin", "g/dL", "4.3", 4.3, "2026-07-12");
    insertLab(p, "Creatinine", "mg/dL", "0.95", 0.95, "2026-07-12");
    insertLab(p, "Glucose", "mg/dL", "92", 92, "2026-07-12");
    insertLab(p, "Lymphocytes", "%", "31", 31, "2026-07-12");
    insertLab(p, "Mean Corpuscular Volume (MCV)", "fL", "90", 90, "2026-07-12");
    insertLab(
      p,
      "Red Cell Distribution Width (RDW)",
      "%",
      "13.1",
      13.1,
      "2026-07-12"
    );
    insertLab(p, "Alkaline Phosphatase", "U/L", "64", 64, "2026-07-12");
    insertLab(
      p,
      "White Blood Cell Count",
      "10^3/uL",
      "5.6",
      5.6,
      "2026-07-12"
    );

    const { draws, presentInputs } = getBioAgeReadings(p);
    const c = inputCompleteness(presentInputs);
    console.log(
      "draw dates:",
      draws.map((d) => d.date),
      "| status sentence:",
      completenessChecklistMessage(c)
    );
    expect(draws.map((d) => d.date)).toEqual(["2026-06-03"]);
    // The sentence the card renders says nothing about WHICH draw, nor that the
    // newest panel failed to compute.
    expect(completenessChecklistMessage(c)).toBe("All 9 inputs present.");
  });
});

describe("#2937 REPRO — a stranded unknown flag token", () => {
  it("reads Normal and flagged at once, and no reconcile can reach it", () => {
    const p = newProfile("repro2937");
    setProfileBirthdate(p, "1980-01-01");
    // A token written by a build from the future (the shape `reported-high` had
    // under v10, or `immune` under v4). Band-less analyte, printed range on the row.
    const id = insertLab(
      p,
      "Microalbumin/Creatinine Ratio, Urine",
      "mg/g",
      "44",
      44,
      "2026-06-03",
      "reported-elevated"
    );
    db.prepare("UPDATE medical_records SET reference_range = ? WHERE id = ?").run(
      "<30",
      id
    );

    const token = "reported-elevated";
    console.log("flagLabel:", JSON.stringify(flagLabel(token)));
    console.log("isNormalFlag:", isNormalFlag(token));
    console.log("isNotableFlag:", isNotableFlag(token));
    console.log("nonoptimal filter clause:", rangeFilterClause("nonoptimal"));
    const flagged = getCurrentFlaggedBiomarkers(p);
    console.log(
      "raised as a review item:",
      flagged.map((f) => biomarkerFlagDetail(f.flag, f.value))
    );
    console.log("reconcileFlags changed rows:", reconcileFlags(p));
    console.log(
      "flag after reconcile:",
      (
        db
          .prepare("SELECT flag FROM medical_records WHERE id = ?")
          .get(id) as { flag: string | null }
      ).flag
    );

    // Display tier: Normal.
    expect(flagLabel(token)).toBe("Normal");
    expect(isNormalFlag(token)).toBe(true);
    // Filter tier: in neither state.
    expect(rangeFilterClause("nonoptimal")).not.toContain(token);
    // Query tier: flagged — the incoherent card.
    expect(flagged.map((f) => biomarkerFlagDetail(f.flag, f.value))).toContain(
      "Flagged normal — 44"
    );
    // And the reconcile never selects the row, so it is permanent.
    expect(
      (
        db
          .prepare("SELECT flag FROM medical_records WHERE id = ?")
          .get(id) as { flag: string | null }
      ).flag
    ).toBe(token);
  });
});
