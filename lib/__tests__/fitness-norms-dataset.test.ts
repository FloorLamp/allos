import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFitnessNorms } from "@/scripts/gen-fitness-norms";
import fitnessJson from "@/lib/fitness-norms.json";
import { FITNESS_NORM_MARKERS } from "@/lib/fitness-norms";

// Anti-drift pins for the baked fitness-norm dataset (issue #158): the committed
// lib/fitness-norms.json must be a FIXED POINT of the generator, every marker must
// carry well-formed sex/percentile/band tables, and the pure lookup's marker list
// must match the JSON's keys. Pure — reads the generator + committed JSON, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/fitness-norms.json");

describe("fitness-norms.json dataset", () => {
  it("is a fixed point of buildFitnessNorms() (regenerate with `npm run gen:fitness-norms`)", () => {
    const generated = JSON.stringify(buildFitnessNorms(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("declares the four longevity markers with canonical-name keys", () => {
    expect(Object.keys(fitnessJson.markers).sort()).toEqual(
      [
        "30-Second Chair Stand",
        "Grip Strength",
        "Single-Leg Balance",
        "VO2 Max",
      ].sort()
    );
  });

  it("keeps the pure lookup's marker list in sync with the JSON keys", () => {
    expect([...FITNESS_NORM_MARKERS].sort()).toEqual(
      Object.keys(fitnessJson.markers).sort()
    );
  });

  it("gives every marker/sex an ascending percentile grid and monotone value bands", () => {
    for (const [name, m] of Object.entries(fitnessJson.markers)) {
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
