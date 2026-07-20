import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDrugAllergyDataset,
  normalizeSynonym,
} from "@/scripts/gen-drug-allergy";
import dataset from "@/lib/datasets/data/drug-allergy.json";
import {
  drugAllergyDataset,
  drugAllergyKeyStrategy,
  DRUG_ALLERGY_CROSS_RULES,
} from "@/lib/datasets/drug-allergy";
import { runHarness } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked drug-allergy class dataset
// (issue #1029): the committed lib/datasets/data/drug-allergy.json must be a FIXED
// POINT of the generator, every class present with a normalized/distinct synonym
// list, every note/rule CITED, cross rules referencing only known classes, and the
// envelope must pass the framework harness (citation / key identity / refusal /
// no-collisions). Pure.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/drug-allergy.json");

describe("drug-allergy.json dataset", () => {
  it("is a fixed point of buildDrugAllergyDataset() (regenerate with `npm run gen:drug-allergy`)", () => {
    const generated = JSON.stringify(buildDrugAllergyDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / key identity / refusal / no collisions)", () => {
    const r = runHarness(drugAllergyDataset, drugAllergyKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries the well-documented classes, each cited + normalized", () => {
    const keys = new Set(dataset.entries.map((e) => e.key));
    expect(keys).toContain("penicillins");
    expect(keys).toContain("cephalosporins");
    expect(keys).toContain("sulfonamide_antibiotics");
    expect(keys).toContain("nsaids");
    expect(keys).toContain("aspirin");
    for (const e of dataset.entries) {
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.synonyms.length).toBeGreaterThan(0);
      expect(e.note.trim().length).toBeGreaterThan(0);
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
      // Every synonym normalized + distinct.
      for (const s of e.synonyms) expect(s).toBe(normalizeSynonym(s));
      expect(new Set(e.synonyms).size).toBe(e.synonyms.length);
    }
  });

  it("cross rules reference known classes, are sorted pairs, and are cited", () => {
    const keys = new Set(dataset.entries.map((e) => e.key));
    expect(DRUG_ALLERGY_CROSS_RULES.length).toBeGreaterThan(0);
    for (const r of DRUG_ALLERGY_CROSS_RULES) {
      expect(keys.has(r.a), r.a).toBe(true);
      expect(keys.has(r.b), r.b).toBe(true);
      expect(r.a <= r.b).toBe(true);
      expect(r.note.trim().length).toBeGreaterThan(0);
      expect(r.source.trim().length).toBeGreaterThan(0);
    }
    // The two documented pairs this dataset exists for.
    const pairs = new Set(DRUG_ALLERGY_CROSS_RULES.map((r) => `${r.a}|${r.b}`));
    expect(pairs).toContain("cephalosporins|penicillins");
    expect(pairs).toContain("aspirin|nsaids");
  });

  it("keeps the exclusion discipline: non-antibiotic sulfonamides are not listed", () => {
    const sulfa = dataset.entries.find(
      (e) => e.key === "sulfonamide_antibiotics"
    )!;
    for (const excluded of [
      "furosemide",
      "hydrochlorothiazide",
      "sumatriptan",
    ]) {
      expect(sulfa.synonyms).not.toContain(excluded);
    }
  });

  it("is emitted sorted for a stable diff", () => {
    const keys = dataset.entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
  });
});
