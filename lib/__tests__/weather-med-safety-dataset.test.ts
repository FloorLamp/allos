import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWeatherMedSafetyDataset,
  normalizeSynonym,
} from "@/scripts/gen-weather-med-safety";
import dataset from "@/lib/datasets/data/weather-med-safety.json";
import {
  weatherMedSafetyDataset,
  weatherMedKeyStrategy,
} from "@/lib/datasets/weather-med-safety";
import { runHarness } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked med × weather safety dataset
// (issue #1727): the committed JSON must be a FIXED POINT of the generator, every entry
// present with a normalized/distinct synonym list, every note CITED, and the envelope
// must pass the framework harness (citation / key identity / refusal / no collisions).
// Pure.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/weather-med-safety.json");

const EXPOSURES = new Set(["photosensitizing", "heat-risk"]);

describe("weather-med-safety.json dataset", () => {
  it("is a fixed point of buildWeatherMedSafetyDataset() (regenerate with `npm run gen:weather-med-safety`)", () => {
    const generated =
      JSON.stringify(buildWeatherMedSafetyDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / key identity / refusal / no collisions)", () => {
    const r = runHarness(weatherMedSafetyDataset, weatherMedKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries the curated photosensitizing classes, each cited + normalized", () => {
    const keys = new Set(dataset.entries.map((e) => e.key));
    // The classes the issue names by hand.
    expect(keys).toContain("tetracycline");
    expect(keys).toContain("systemic_retinoid");
    expect(keys).toContain("amiodarone");
    expect(keys).toContain("thiazide_diuretic");
    expect(keys).toContain("fluoroquinolone");
    expect(keys).toContain("st_johns_wort");
  });

  it("carries the curated heat-risk classes", () => {
    const keys = new Set(dataset.entries.map((e) => e.key));
    expect(keys).toContain("diuretic_heat");
    expect(keys).toContain("anticholinergic_heat");
    expect(keys).toContain("beta_blocker_heat");
    expect(keys).toContain("stimulant_heat");
  });

  it("every entry is well-formed, cited, and normalized", () => {
    for (const e of dataset.entries) {
      expect(EXPOSURES.has(e.exposure), e.exposure).toBe(true);
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.synonyms.length).toBeGreaterThan(0);
      expect(e.clause.trim().length, e.key).toBeGreaterThan(0);
      expect(e.note.trim().length, e.key).toBeGreaterThan(0);
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
      for (const s of e.synonyms) expect(s).toBe(normalizeSynonym(s));
      expect(new Set(e.synonyms).size).toBe(e.synonyms.length);
    }
  });

  it("keeps the copy in the informational register — never prescriptive", () => {
    // The house discipline (#1727): state the fact and the source-backed caution, never
    // an instruction to change a medication.
    const banned = /\b(stop taking|discontinue|do not take|stop your)\b/i;
    for (const e of dataset.entries) {
      expect(banned.test(e.note), `${e.key}: ${e.note}`).toBe(false);
      expect(banned.test(e.clause), `${e.key}: ${e.clause}`).toBe(false);
    }
  });

  it("is emitted sorted for a stable diff", () => {
    const keys = dataset.entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
  });
});
