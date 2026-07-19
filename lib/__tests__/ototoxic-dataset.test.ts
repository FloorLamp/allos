import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOtotoxicDataset, normalizeSynonym } from "@/scripts/gen-ototoxic";
import dataset from "@/lib/datasets/data/ototoxic.json";
import { ototoxicDataset, ototoxicKeyStrategy } from "@/lib/datasets/ototoxic";
import { runHarness } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked ototoxic-medication dataset (issue
// #717): the committed lib/datasets/data/ototoxic.json must be a FIXED POINT of the
// generator, every drug entry present with a normalized/distinct synonym list, every
// note CITED, and the envelope must pass the framework harness (citation / key identity
// / refusal / no-collisions). Pure.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/ototoxic.json");

const CATEGORIES = new Set([
  "aminoglycoside",
  "platinum-chemo",
  "loop-diuretic",
  "salicylate",
  "glycopeptide",
  "antimalarial",
]);

describe("ototoxic.json dataset", () => {
  it("is a fixed point of buildOtotoxicDataset() (regenerate with `npm run gen:ototoxic`)", () => {
    const generated = JSON.stringify(buildOtotoxicDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / key identity / refusal / no collisions)", () => {
    const r = runHarness(ototoxicDataset, ototoxicKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries the well-established ototoxic drug classes, each cited + normalized", () => {
    const keys = new Set(dataset.entries.map((e) => e.key));
    expect(keys).toContain("aminoglycoside");
    expect(keys).toContain("platinum_chemo");
    expect(keys).toContain("loop_diuretic");
    expect(keys).toContain("salicylate");
    expect(keys).toContain("vancomycin");
    expect(keys).toContain("quinine_antimalarial");
    for (const e of dataset.entries) {
      expect(CATEGORIES.has(e.category), e.category).toBe(true);
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.synonyms.length).toBeGreaterThan(0);
      expect(e.note.trim().length).toBeGreaterThan(0);
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
      // Every synonym normalized + distinct.
      for (const s of e.synonyms) expect(s).toBe(normalizeSynonym(s));
      expect(new Set(e.synonyms).size).toBe(e.synonyms.length);
    }
  });

  it("is emitted sorted for a stable diff", () => {
    const keys = dataset.entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
  });
});
