import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStrengthStandards } from "@/scripts/gen-strength-standards";
import standardsJson from "@/lib/datasets/data/strength-standards.json";
import {
  strengthStandardsDataset,
  strengthStandardNameStrategy,
  STRENGTH_STANDARD_LIFTS_MAP,
} from "@/lib/datasets/strength-standards";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { STRENGTH_STANDARD_LIFTS } from "@/lib/strength-standards";

// Anti-drift + framework-contract pins for the baked strength-standards dataset (issue
// #152, migrated onto the curated-dataset framework in #860 Track B). The committed
// lib/datasets/data/strength-standards.json must be a FIXED POINT of the generator, pass
// the framework harness (citation / identity / refusal / no-collisions), and every lift
// must carry well-formed sex/level/band tables. The pure lookup's lift list must match
// the entry names byte-for-byte. Pure — reads the generator + committed JSON, no DB.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/strength-standards.json");

// The name→LiftStandards map the pure lookup rebuilds from the entries — asserted here so
// the band-monotonicity invariants read the same shape the old `{ lifts }` map exposed.
const LIFTS = STRENGTH_STANDARD_LIFTS_MAP;

describe("strength-standards.json dataset", () => {
  it("is a fixed point of buildStrengthStandards() (regenerate with `npm run gen:strength-standards`)", () => {
    const generated = JSON.stringify(buildStrengthStandards(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity name / refusal / no collisions)", () => {
    const r = runHarness(
      strengthStandardsDataset,
      strengthStandardNameStrategy
    );
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries a dataset citation with a source", () => {
    expect(citationPresent(strengthStandardsDataset).problems).toEqual([]);
    expect(strengthStandardsDataset.citation[0].source).toMatch(
      /Lietzke|allometric|strength/i
    );
  });

  it("resolves every lift by its own name identity, with no collisions", () => {
    expect(
      identityResolves(strengthStandardsDataset, strengthStandardNameStrategy)
        .problems
    ).toEqual([]);
    expect(
      noKeyCollisions(strengthStandardsDataset, strengthStandardNameStrategy)
        .problems
    ).toEqual([]);
  });

  it("refuses an absent lift (returns null — never a guess)", () => {
    expect(
      refusalGate(strengthStandardsDataset, strengthStandardNameStrategy, [
        "Leg Press",
        "",
      ]).problems
    ).toEqual([]);
  });

  it("declares the covered barbell/bodyweight lifts with canonical-name keys", () => {
    expect(standardsJson.entries.map((e) => e.name).sort()).toEqual(
      [
        "Back Squat",
        "Bench Press",
        "Chin Up",
        "Deadlift",
        "Front Squat",
        "Incline Bench Press",
        "Overhead Press",
        "Pull Up",
      ].sort()
    );
  });

  it("keeps the pure lookup's lift list in sync with the entry names", () => {
    expect([...STRENGTH_STANDARD_LIFTS].sort()).toEqual(
      Object.keys(LIFTS).sort()
    );
  });

  it("gives every lift/sex ascending bodyweight bands and monotone level floors", () => {
    for (const [name, lift] of Object.entries(LIFTS)) {
      expect(lift.unit, name).toBe("kg");
      expect(lift.source, name).toBeTruthy();
      for (const sex of ["male", "female"] as const) {
        const sn = lift.sexes[sex];
        expect(sn.levels, `${name}/${sex}`).toEqual([
          "beginner",
          "novice",
          "intermediate",
          "advanced",
          "elite",
        ]);
        for (let b = 0; b < sn.bands.length; b++) {
          const band = sn.bands[b];
          // Each value vector aligns with the five levels.
          expect(
            band.values.length,
            `${name}/${sex} band ${band.bodyweight}`
          ).toBe(sn.levels.length);
          // Level floors strictly ascending within a band (beginner < … < elite).
          for (let i = 1; i < band.values.length; i++) {
            expect(
              band.values[i],
              `${name}/${sex} band ${band.bodyweight} floors`
            ).toBeGreaterThan(band.values[i - 1]);
          }
          // Bodyweight bands strictly ascending, and heavier ⇒ higher absolute
          // floors (allometric scaling raises absolutes with bodyweight).
          if (b > 0) {
            expect(
              band.bodyweight,
              `${name}/${sex} band order`
            ).toBeGreaterThan(sn.bands[b - 1].bodyweight);
            for (let i = 0; i < band.values.length; i++) {
              expect(
                band.values[i],
                `${name}/${sex} band ${band.bodyweight} vs lighter`
              ).toBeGreaterThan(sn.bands[b - 1].values[i]);
            }
          }
        }
      }
    }
  });
});
