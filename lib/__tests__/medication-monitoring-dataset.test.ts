import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMedMonitoringDataset,
  normalizeSynonym,
} from "@/scripts/gen-medication-monitoring";
import dataset from "@/lib/datasets/data/medication-monitoring.json";
import {
  medMonitoringDataset,
  medMonitoringKeyStrategy,
} from "@/lib/datasets/medication-monitoring";
import { runHarness } from "@/lib/datasets";

// Anti-drift + framework-contract pins for the baked medication-monitoring dataset (issue
// #995): the committed lib/datasets/data/medication-monitoring.json must be a FIXED POINT
// of the generator, every entry well-formed (normalized/distinct synonyms, ≥1 required
// lab, a legal tier, sane cadences, a cited note), and the envelope must pass the
// framework harness (citation / key identity / refusal / no-collisions). Pure.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/medication-monitoring.json");

const TIERS = new Set(["care", "coaching"]);
// The care-tier split ratified in #995 decision 1.
const CARE_KEYS = [
  "lithium",
  "clozapine",
  "warfarin",
  "valproate",
  "carbamazepine",
];

describe("medication-monitoring.json dataset", () => {
  it("is a fixed point of buildMedMonitoringDataset() (regenerate with `npm run gen:medication-monitoring`)", () => {
    const generated =
      JSON.stringify(buildMedMonitoringDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / key identity / refusal / no collisions)", () => {
    const r = runHarness(medMonitoringDataset, medMonitoringKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries the driving + platform drugs, each well-formed + cited", () => {
    const keys = new Set(dataset.entries.map((e) => e.key));
    for (const k of CARE_KEYS) expect(keys, k).toContain(k);
    expect(keys).toContain("second_gen_antipsychotic");
    expect(keys).toContain("amiodarone");
    expect(keys).toContain("methotrexate");
    expect(keys).toContain("acei_arb");
    expect(keys).toContain("metformin");

    const citations = new Set(dataset.citation.map((c) => c.source));
    for (const e of dataset.entries) {
      expect(TIERS.has(e.tier), e.tier).toBe(true);
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.synonyms.length).toBeGreaterThan(0);
      expect(e.labs.length, e.key).toBeGreaterThan(0);
      expect(e.note.trim().length).toBeGreaterThan(0);
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
      // Every entry's note-source is one of the dataset-level citations (auditable).
      expect(citations.has(e.source), `${e.key}: ${e.source}`).toBe(true);
      // Cadences are sane: init tighter-or-equal to maintenance, both positive.
      expect(e.initDays).toBeGreaterThan(0);
      expect(e.maintenanceDays).toBeGreaterThanOrEqual(e.initDays);
      // Every lab carries a canonical name + a display label.
      for (const lab of e.labs) {
        expect(lab.canonical.trim().length, e.key).toBeGreaterThan(0);
        expect(lab.label.trim().length, e.key).toBeGreaterThan(0);
      }
      // Every synonym normalized + distinct.
      for (const s of e.synonyms) expect(s).toBe(normalizeSynonym(s));
      expect(new Set(e.synonyms).size).toBe(e.synonyms.length);
    }
  });

  it("assigns the ratified care tier to exactly the high-consequence drugs (#995 decision 1)", () => {
    const careInData = dataset.entries
      .filter((e) => e.tier === "care")
      .map((e) => e.key)
      .sort();
    expect(careInData).toEqual([...CARE_KEYS].sort());
  });

  it("is emitted sorted for a stable diff", () => {
    const keys = dataset.entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort());
  });
});
