import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDentalSafetyDataset,
  normalizeKeyword,
} from "@/scripts/gen-dental-safety";
import dataset from "@/lib/datasets/data/dental-safety.json";
import {
  dentalSafetyDataset,
  dentalKeyStrategy,
} from "@/lib/datasets/dental-safety";
import { runHarness } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked dental-safety dataset (issue
// #704): the committed lib/datasets/data/dental-safety.json must be a FIXED POINT of
// the generator, every drug entry + condition gate present, keyword/synonym lists
// normalized + distinct, every note CITED, and the envelope must pass the framework
// harness (citation / key identity / refusal / no-collisions). Pure.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/dental-safety.json");

const CATEGORIES = new Set(["antiresorptive", "anticoagulant"]);

describe("dental-safety.json dataset", () => {
  it("is a fixed point of buildDentalSafetyDataset() (regenerate with `npm run gen:dental-safety`)", () => {
    const generated =
      JSON.stringify(buildDentalSafetyDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / key identity / refusal / no collisions)", () => {
    const r = runHarness(dentalSafetyDataset, dentalKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries both drug categories (antiresorptive + anticoagulant) as entries", () => {
    const cats = new Set(dataset.entries.map((e) => e.category));
    expect(cats).toEqual(CATEGORIES);
    for (const e of dataset.entries) {
      expect(CATEGORIES.has(e.category), e.category).toBe(true);
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.synonyms.length).toBeGreaterThan(0);
      // Every synonym normalized.
      for (const s of e.synonyms) expect(s).toBe(normalizeKeyword(s));
      expect(new Set(e.synonyms).size).toBe(e.synonyms.length);
    }
  });

  it("includes bisphosphonates + denosumab (antiresorptive) and warfarin + DOAC (anticoagulant)", () => {
    const keys = new Set(dataset.entries.map((e) => e.key));
    expect(keys).toContain("antiresorptive_bisphosphonate");
    expect(keys).toContain("antiresorptive_denosumab");
    expect(keys).toContain("anticoagulant_warfarin");
    expect(keys).toContain("anticoagulant_doac");
  });

  it("carries the AHA cardiac condition gates with keywords + notes", () => {
    const keys = new Set(dataset.meta.conditionGates.map((g) => g.key));
    expect(keys).toContain("prosthetic_valve");
    expect(keys).toContain("prior_endocarditis");
    for (const g of dataset.meta.conditionGates) {
      expect(g.keywords.length).toBeGreaterThan(0);
      for (const kw of g.keywords) expect(kw).toBe(normalizeKeyword(kw));
      expect(g.note.trim().length).toBeGreaterThan(0);
    }
  });

  it("cites a guideline on every drug entry and condition gate (source discipline)", () => {
    for (const e of dataset.entries)
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
    for (const g of dataset.meta.conditionGates)
      expect(g.source.trim().length, g.key).toBeGreaterThan(0);
  });

  it("is emitted sorted for a stable diff", () => {
    const keys = dataset.entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
    const gateKeys = dataset.meta.conditionGates.map((g) => g.key);
    expect(gateKeys).toEqual([...gateKeys].sort());
  });
});
