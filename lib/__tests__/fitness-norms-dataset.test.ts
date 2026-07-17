import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFitnessNorms } from "@/scripts/gen-fitness-norms";
import fitnessJson from "@/lib/datasets/data/fitness-norms.json";
import {
  fitnessNormsDataset,
  fitnessNormNameStrategy,
  FITNESS_NORM_MARKERS_MAP,
} from "@/lib/datasets/fitness-norms";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { FITNESS_NORM_MARKERS } from "@/lib/fitness-norms";

// Anti-drift + framework-contract pins for the baked fitness-norm dataset (issue #158,
// migrated onto the curated-dataset framework in #860 Track B). The committed
// lib/datasets/data/fitness-norms.json must be a FIXED POINT of the generator, pass the
// framework harness (citation / identity / refusal / no-collisions), and every marker
// must carry well-formed sex/percentile/band tables. The pure lookup's marker list must
// match the entry names byte-for-byte. Pure — reads the generator + committed JSON, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/fitness-norms.json");

// The name→MarkerNorms map the pure lookup rebuilds from the entries — asserted here so
// the band-table invariants read the same shape the old `{ markers }` map exposed.
const MARKERS = FITNESS_NORM_MARKERS_MAP;

describe("fitness-norms.json dataset", () => {
  it("is a fixed point of buildFitnessNorms() (regenerate with `npm run gen:fitness-norms`)", () => {
    const generated = JSON.stringify(buildFitnessNorms(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity name / refusal / no collisions)", () => {
    const r = runHarness(fitnessNormsDataset, fitnessNormNameStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries a dataset citation with a source", () => {
    expect(citationPresent(fitnessNormsDataset).problems).toEqual([]);
    expect(fitnessNormsDataset.citation[0].source).toMatch(
      /FRIEND|Dodds|Rikli|Springer/
    );
  });

  it("resolves every marker by its own name identity, with no collisions", () => {
    expect(
      identityResolves(fitnessNormsDataset, fitnessNormNameStrategy).problems
    ).toEqual([]);
    expect(
      noKeyCollisions(fitnessNormsDataset, fitnessNormNameStrategy).problems
    ).toEqual([]);
  });

  it("refuses an absent marker (returns null — never a guess)", () => {
    expect(
      refusalGate(fitnessNormsDataset, fitnessNormNameStrategy, [
        "Bench Press",
        "",
      ]).problems
    ).toEqual([]);
  });

  it("declares the four longevity markers with canonical-name keys", () => {
    expect(fitnessJson.entries.map((e) => e.name).sort()).toEqual(
      [
        "30-Second Chair Stand",
        "Grip Strength",
        "Single-Leg Balance",
        "VO2 Max",
      ].sort()
    );
  });

  it("keeps the pure lookup's marker list in sync with the entry names", () => {
    expect([...FITNESS_NORM_MARKERS].sort()).toEqual(
      Object.keys(MARKERS).sort()
    );
  });

  it("gives every marker/sex an ascending percentile grid and monotone value bands", () => {
    for (const [name, m] of Object.entries(MARKERS)) {
      expect(m.unit, name).toBeTruthy();
      expect(m.direction).toBe("higher_better");
      for (const sex of ["male", "female"] as const) {
        const sn = m.sexes[sex];
        // percentiles strictly ascending
        for (let i = 1; i < sn.percentiles.length; i++) {
          expect(sn.percentiles[i], `${name}/${sex} pcts`).toBeGreaterThan(
            sn.percentiles[i - 1]
          );
        }
        // p50 present so fitness age can be computed
        expect(sn.percentiles, `${name}/${sex} needs p50`).toContain(50);
        // bands age-ascending; each value vector matches the percentile length and
        // is non-decreasing (higher percentile ⇒ higher-or-equal value)
        for (let b = 0; b < sn.bands.length; b++) {
          const band = sn.bands[b];
          expect(band.values.length, `${name}/${sex} band ${band.age}`).toBe(
            sn.percentiles.length
          );
          for (let i = 1; i < band.values.length; i++) {
            expect(
              band.values[i],
              `${name}/${sex} band ${band.age} values`
            ).toBeGreaterThanOrEqual(band.values[i - 1]);
          }
          if (b > 0) {
            expect(band.age, `${name}/${sex} band order`).toBeGreaterThan(
              sn.bands[b - 1].age
            );
          }
        }
      }
    }
  });
});
