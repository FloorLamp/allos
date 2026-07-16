import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the two kind-owned intake forms (issue #846). Before the
// split, ONE IntakeItemForm rendered a supplement-shaped body for medications too —
// SUPPLEMENT_BRANDS suggestions and an "e.g. Thorne" placeholder on a med, a Stack
// section and a Priority sort (#559) that mean nothing for a drug, dose suggestions
// from the supplement catalog. Placeholders teach the user what a field is for; those
// taught wrong. The forms are now split for real: MedicationForm owns the medication
// concepts, SupplementForm the supplement concepts, and NEITHER may import or render
// the other's. This test reads the two form modules as TEXT (pure, no DB/network) and
// fails the build if either reaches across the seam — making the wrong-placeholder
// class structurally impossible. The genuinely-shared machinery (RxNorm confirm,
// cross-kind interaction notices, dose rows, keep-apart pairs, critical, refill, notes)
// lives in components/intake/* and is composed by both, so it is NOT scanned here.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MED = "components/MedicationForm.tsx";
const SUPP = "components/SupplementForm.tsx";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("intake form split boundary (issue #846)", () => {
  const med = read(MED);
  const supp = read(SUPP);

  it("the old shared IntakeItemForm is gone", () => {
    expect(
      fs.existsSync(path.join(REPO, "components/IntakeItemForm.tsx"))
    ).toBe(false);
  });

  it("MedicationForm renders no supplement kind concepts", () => {
    // Supplement catalog/brands, the priority sort, the stack grouping, the workout
    // condition scheduler — none belong on a medication.
    const forbidden = [
      "SUPPLEMENT_BRANDS",
      "SUPPLEMENT_CATALOG",
      "supplement-brands",
      "supplement-catalog",
      "PRIORITIES",
      "PRIORITY_LABELS",
      "availableConditions",
      'name="priority"',
      'name="stack"',
      "e.g. Thorne",
      "e.g. Vitamin D3",
    ];
    const hits = forbidden.filter((f) => med.includes(f));
    expect(
      hits,
      `MedicationForm must not reference: ${hits.join(", ")}`
    ).toEqual([]);
  });

  it("SupplementForm renders no medication kind concepts", () => {
    // Medication catalog, prescriber/Rx identity, PRN redose + pediatric dosing —
    // none belong on a supplement.
    const forbidden = [
      "medicationCatalogNames",
      "MED_CATALOG_NAMES",
      "splitMedicationName",
      "medicationBrandNames",
      "prnDefaultsFor",
      "pediatricDoseSuggestion",
      "resolveIntakePrefill",
      'name="prescriber"',
      'name="rx_number"',
      'name="as_needed"',
      "e.g. Ibuprofen",
    ];
    const hits = forbidden.filter((f) => supp.includes(f));
    expect(
      hits,
      `SupplementForm must not reference: ${hits.join(", ")}`
    ).toEqual([]);
  });

  it("neither form imports the other", () => {
    expect(med).not.toMatch(/from\s+["']@\/components\/SupplementForm["']/);
    expect(supp).not.toMatch(/from\s+["']@\/components\/MedicationForm["']/);
  });
});
