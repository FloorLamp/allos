import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFitnessHoldNorms } from "@/scripts/gen-fitness-hold-norms";
import {
  fitnessHoldNormsDataset,
  fitnessHoldNormNameStrategy,
} from "@/lib/datasets/fitness-hold-norms";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { holdBand, hasHoldNorm } from "@/lib/fitness-hold-norms";

// #1135 — the DISCLOSED-ROUGH band ladder for dead hang + plank. Anti-drift + framework
// contract + the pure band lookup (correct band per sex, favorability direction, the
// rough quality flag). Pure — reads the generator + committed JSON, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/fitness-hold-norms.json");

describe("fitness-hold-norms.json dataset", () => {
  it("is a fixed point of buildFitnessHoldNorms() (regenerate with `npm run gen:fitness-hold-norms`)", () => {
    const generated = JSON.stringify(buildFitnessHoldNorms(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity / refusal / no-collisions)", () => {
    const report = runHarness(fitnessHoldNormsDataset, fitnessHoldNormNameStrategy, [
      citationPresent,
      identityResolves,
      refusalGate,
      noKeyCollisions,
    ]);
    expect(report.ok, JSON.stringify(report, null, 2)).toBe(true);
  });

  it("every entry carries the explicit rough quality flag", () => {
    for (const e of fitnessHoldNormsDataset.entries) {
      expect(e.quality).toBe("rough");
      expect(e.source.length).toBeGreaterThan(0);
    }
  });
});

describe("holdBand lookup", () => {
  it("knows the two hold tests and refuses others", () => {
    expect(hasHoldNorm("plank")).toBe(true);
    expect(hasHoldNorm("deadhang")).toBe(true);
    expect(hasHoldNorm("vo2max")).toBe(false);
  });

  it("places a male plank hold in the correct rough band", () => {
    expect(holdBand("plank", 10, "male")!.band).toBe("weak");
    expect(holdBand("plank", 45, "male")!.band).toBe("fair"); // [30,60)
    expect(holdBand("plank", 90, "male")!.band).toBe("good"); // [60,120)
    expect(holdBand("plank", 150, "male")!.band).toBe("excellent"); // >=120
  });

  it("uses sex-appropriate cutoffs (female bands are lower)", () => {
    // 25s is "weak" for a man (<30) but "fair" for a woman (>=20).
    expect(holdBand("plank", 25, "male")!.band).toBe("weak");
    expect(holdBand("plank", 25, "female")!.band).toBe("fair");
  });

  it("favorability position rises with a longer hold (longer = greener)", () => {
    const short = holdBand("deadhang", 10, "male")!.position;
    const mid = holdBand("deadhang", 55, "male")!.position;
    const long = holdBand("deadhang", 150, "male")!.position;
    expect(short).toBeLessThan(mid);
    expect(mid).toBeLessThan(long);
    expect(long).toBeGreaterThan(75);
    expect(short).toBeLessThan(25);
  });

  it("clamps at the top band and never exceeds 100", () => {
    const r = holdBand("plank", 9999, "male")!;
    expect(r.band).toBe("excellent");
    expect(r.clampedTop).toBe(true);
    expect(r.position).toBeLessThanOrEqual(100);
  });

  it("tags the result rough with a citation, never a percentile", () => {
    const r = holdBand("plank", 60, "male")!;
    expect(r.quality).toBe("rough");
    expect(r.citation.length).toBeGreaterThan(0);
    expect(r.bandLabel).toBe("Good");
  });

  it("returns null when sex is unset or the value is missing", () => {
    expect(holdBand("plank", 60, null)).toBeNull();
    expect(holdBand("plank", null, "male")).toBeNull();
    expect(holdBand("nope", 60, "male")).toBeNull();
  });
});
