import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStrengthStandards } from "@/scripts/gen-strength-standards";
import standardsJson from "@/lib/strength-standards.json";
import { STRENGTH_STANDARD_LIFTS } from "@/lib/strength-standards";

// Anti-drift pins for the baked strength-standards dataset (issue #152): the
// committed lib/strength-standards.json must be a FIXED POINT of the generator,
// every lift must carry well-formed sex/level/band tables, and the pure lookup's
// lift list must match the JSON keys. Pure — reads the generator + committed JSON.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/strength-standards.json");

describe("strength-standards.json dataset", () => {
  it("is a fixed point of buildStrengthStandards() (regenerate with `npm run gen:strength-standards`)", () => {
    const generated = JSON.stringify(buildStrengthStandards(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("declares the five core barbell/bodyweight lifts with canonical-name keys", () => {
    expect(Object.keys(standardsJson.lifts).sort()).toEqual(
      [
        "Back Squat",
        "Bench Press",
        "Deadlift",
        "Overhead Press",
        "Pull Up",
      ].sort()
    );
  });

  it("keeps the pure lookup's lift list in sync with the JSON keys", () => {
    expect([...STRENGTH_STANDARD_LIFTS].sort()).toEqual(
      Object.keys(standardsJson.lifts).sort()
    );
  });

  it("gives every lift/sex ascending bodyweight bands and monotone level floors", () => {
    for (const [name, lift] of Object.entries(standardsJson.lifts)) {
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
