import { describe, expect, it } from "vitest";
import {
  ALL_LIFT_NAMES,
  MUSCLE_IDS,
  type MuscleId,
  type MuscleRegion,
  liftInfo,
  muscleRegion,
} from "@/lib/lifts";

const REGIONS: MuscleRegion[] = [
  "Chest",
  "Back",
  "Shoulders",
  "Arms",
  "Legs",
  "Glutes",
  "Core",
];

describe("muscleRegion rollup", () => {
  it("is total over the MuscleId enum (every id maps to a valid region)", () => {
    expect(MUSCLE_IDS).toHaveLength(22);
    for (const m of MUSCLE_IDS) {
      expect(REGIONS).toContain(muscleRegion(m));
    }
  });

  it("splits hip flexor accessories by region: adductors→Legs, abductors→Glutes", () => {
    // Matches the catalog placement of "Hip Adduction" (Legs) vs
    // "Hip Abduction" (Glutes) — the reconciliation the rollup invariant needs.
    expect(muscleRegion("hip-adductors")).toBe("Legs");
    expect(muscleRegion("hip-abductors")).toBe("Glutes");
  });
});

describe("catalog muscle tagging", () => {
  // Every concrete catalog lift (plain + composed variants + bare bases).
  const defs = ALL_LIFT_NAMES.map((name) => {
    const info = liftInfo(name);
    if (!info) throw new Error(`no LiftDef for catalog name ${name}`);
    return info;
  });

  it("gives every lift at least one primary muscle", () => {
    for (const d of defs) {
      expect(
        d.primaryMuscles.length,
        `${d.name} has no primary muscle`
      ).toBeGreaterThan(0);
    }
  });

  it("rolls every lift's primary muscles up into its declared region (the load-bearing invariant)", () => {
    // Catches tagging typos: e.g. a Bench Press (Chest) tagged with `quads`
    // would fail here because quads rolls up to Legs, not Chest.
    for (const d of defs) {
      for (const m of d.primaryMuscles) {
        expect(
          muscleRegion(m),
          `${d.name}: primary muscle "${m}" rolls up to ${muscleRegion(
            m
          )}, but the lift's region is ${d.region}`
        ).toBe(d.region);
      }
    }
  });

  it("only uses known MuscleId values in primary and secondary tags", () => {
    const known = new Set<MuscleId>(MUSCLE_IDS);
    for (const d of defs) {
      for (const m of [...d.primaryMuscles, ...d.secondaryMuscles]) {
        expect(known.has(m), `${d.name}: unknown muscle "${m}"`).toBe(true);
      }
    }
  });

  it("never lists a muscle as both primary and secondary on the same lift", () => {
    for (const d of defs) {
      const prim = new Set(d.primaryMuscles);
      for (const m of d.secondaryMuscles) {
        expect(
          prim.has(m),
          `${d.name}: "${m}" is both primary and secondary`
        ).toBe(false);
      }
    }
  });
});
