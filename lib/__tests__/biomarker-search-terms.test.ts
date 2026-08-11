import { describe, it, expect } from "vitest";
import { biomarkerSearchTerms } from "@/lib/canonical-name";
import { fuzzyFilterWithTerms } from "@/lib/fuzzy";
import canonicalBiomarkers from "@/lib/canonical-biomarkers.json";

// #2382. The app-wide combobox matcher is a greedy leftmost SUBSEQUENCE walk that
// never backtracks, so #2335's `Long Name (ABBR)` convention puts an analyte's
// abbreviation exactly where the matcher is structurally incapable of seeing it:
// for "Prostate-Specific Antigen (PSA)" the query `psa` is consumed scattered
// inside "Prostate-Specific" and the literal "(PSA)" at the end is never reached.
// `psa` did not offer that entry AT ALL. Searching the abbreviation as its own key
// is therefore not a nicety — it is the only way the abbreviation is reachable.

const CATALOG: string[] = canonicalBiomarkers.biomarkers.map((b) => b.name);

// The Combobox's own cap. Ranking first is the claim; falling off an 8-row list is
// the failure mode the cap adds on top of it.
const ROWS = 8;

function offered(query: string): string[] {
  return fuzzyFilterWithTerms(CATALOG, query, biomarkerSearchTerms, {
    limit: ROWS,
  });
}

describe("biomarkerSearchTerms", () => {
  it("derives the bare full name and the acronym from the name itself", () => {
    expect(biomarkerSearchTerms("Prostate-Specific Antigen (PSA)")).toEqual(
      expect.arrayContaining(["Prostate-Specific Antigen", "PSA"])
    );
  });

  it("adds the curated alias routes that already point at the analyte", () => {
    // The vocabulary has routed `A1c` → `Hemoglobin A1c` all along; before this it
    // contributed nothing to search because no biomarker picker passed the terms.
    expect(biomarkerSearchTerms("Hemoglobin A1c")).toContain("A1c");
    expect(biomarkerSearchTerms("Red Blood Cell Count")).toContain("RBC");
  });

  it("never repeats the visible name — the matcher always scores that", () => {
    const echoed = CATALOG.filter((name) =>
      biomarkerSearchTerms(name).includes(name)
    );
    expect(echoed).toEqual([]);
  });

  it("keeps a WORD parenthetical out, because it qualifies the quantity", () => {
    // Dropping it would turn peak-exercise systolic pressure into resting pressure.
    expect(
      biomarkerSearchTerms("Blood Pressure Systolic (Peak Exercise)")
    ).toEqual([]);
  });

  it("answers [] for a label that names no analyte", () => {
    // A mixed picker (metrics + biomarkers, plus Compare's "— none —" row) passes
    // this unconditionally, so a non-analyte label must simply contribute nothing.
    expect(biomarkerSearchTerms("— none —")).toEqual([]);
    expect(biomarkerSearchTerms("Weight (metric)")).toEqual([]);
  });
});

// Frozen as a PROPERTY, not as an array (#2353): for each (query, intended entry)
// pair the intended entry must RANK FIRST. A future curation that reorders the tail
// cannot break this; a regression that buries the target does. What else a short
// query matches is a property of the DATASET, not of the picker, so it is not
// pinned here.
describe("a short query reaches the analyte it obviously means", () => {
  const BATTERY: readonly (readonly [string, string])[] = [
    // Reachable ONLY through the trailing acronym: the greedy walk consumes the
    // query inside the long name and never arrives at the parenthetical.
    ["psa", "Prostate-Specific Antigen (PSA)"],
    ["alt", "Alanine Aminotransferase (ALT)"],
    ["ast", "Aspartate Aminotransferase (AST)"],
    ["ggt", "Gamma-Glutamyl Transferase (GGT)"],
    ["bun", "Blood Urea Nitrogen (BUN)"],
    ["tsh", "Thyroid-Stimulating Hormone (TSH)"],
    ["mcv", "Mean Corpuscular Volume (MCV)"],
    ["apob", "Apolipoprotein B (ApoB)"],
    ["tibc", "Total Iron-Binding Capacity (TIBC)"],
    ["igf", "Insulin-Like Growth Factor 1 (IGF-1)"],
    ["egfr", "Estimated Glomerular Filtration Rate (eGFR)"],
    ["hscrp", "High-Sensitivity C-Reactive Protein (hs-CRP)"],
    ["homair", "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)"],
    // Reachable through a curated alias route the vocabulary already held.
    ["a1c", "Hemoglobin A1c"],
    ["hba1c", "Hemoglobin A1c"],
    ["rbc", "Red Blood Cell Count"],
    ["ldl", "LDL Cholesterol"],
    // Already correct before this change, and must stay correct: a short query
    // still finds the obvious candidate, and an exact prefix still wins.
    ["b12", "Vitamin B12"],
    ["wbc", "White Blood Cell Count"],
    ["ferritin", "Ferritin"],
    ["hemoglobin a1c", "Hemoglobin A1c"],
    ["total chol", "Total Cholesterol"],
  ];

  for (const [query, intended] of BATTERY) {
    it(`"${query}" leads with ${intended}`, () => {
      expect(offered(query)[0]).toBe(intended);
    });
  }
});
