import { describe, it, expect } from "vitest";
import guidesJson from "@/lib/exercise-guides.json";
import {
  getExerciseGuide,
  hasExerciseGuide,
  allExerciseGuides,
  type ExerciseGuide,
} from "@/lib/exercise-guides";
import {
  type Equipment,
  type MuscleId,
  ALL_LIFT_NAMES,
  LIFT_OPTIONS,
  MUSCLE_IDS,
  baseLiftName,
  exerciseHistoryKey,
  liftInfo,
  muscleRegion,
} from "@/lib/lifts";

const MUSCLE_SET = new Set<string>(MUSCLE_IDS);
const EQUIPMENT: Equipment[] = ["Barbell", "Dumbbell", "Cable", "Machine"];

// The distinct exerciseHistoryKeys the completeness invariant is defined over —
// derived exactly the way the accessor keys and the generator builds, so a new
// catalog lift automatically joins this set.
function catalogKeys(): string[] {
  const keys = new Set<string>();
  for (const name of [...ALL_LIFT_NAMES, ...LIFT_OPTIONS])
    keys.add(exerciseHistoryKey(name));
  return [...keys].sort();
}

const guides = (guidesJson as { guides: ExerciseGuide[] }).guides;

describe("exercise-guides completeness (the load-bearing invariant)", () => {
  // Build-failing guard: every catalog exerciseHistoryKey MUST have a guide, so a
  // new catalog lift cannot ship guideless.
  it("has a guide for every catalog exerciseHistoryKey", () => {
    const have = new Set(guides.map((g) => g.key));
    const missing = catalogKeys().filter((k) => !have.has(k));
    expect(missing).toEqual([]);
  });

  it("resolves every catalog lift name through the accessor", () => {
    for (const name of [...ALL_LIFT_NAMES, ...LIFT_OPTIONS]) {
      expect(getExerciseGuide(name), `no guide for ${name}`).toBeDefined();
      expect(hasExerciseGuide(name), name).toBe(true);
    }
  });

  it("has no orphan guide key that isn't a catalog exerciseHistoryKey", () => {
    const catalog = new Set(catalogKeys());
    const orphans = guides.map((g) => g.key).filter((k) => !catalog.has(k));
    expect(orphans).toEqual([]);
  });

  it("has no duplicate guide keys", () => {
    const keys = guides.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("getExerciseGuide resolution (identity through exerciseHistoryKey)", () => {
  it("collapses an equipment variant to its base guide", () => {
    const base = getExerciseGuide("Curl");
    expect(base).toBeDefined();
    expect(base?.key).toBe("curl");
    // Every variant spelling resolves to the SAME guide object.
    for (const variant of ["Barbell Curl", "Dumbbell Curl", "Cable Curl"]) {
      expect(getExerciseGuide(variant)).toBe(base);
    }
  });

  it("resolves case- and whitespace-insensitively", () => {
    expect(getExerciseGuide("  romanian DEADLIFT ")?.key).toBe(
      "romanian deadlift"
    );
  });

  it("returns undefined for a non-catalog custom lift", () => {
    expect(getExerciseGuide("Kettlebell Halo")).toBeUndefined();
    expect(getExerciseGuide("My Custom Move")).toBeUndefined();
    expect(hasExerciseGuide("My Custom Move")).toBe(false);
  });

  it("returns undefined for empty/nullish input", () => {
    expect(getExerciseGuide("")).toBeUndefined();
    expect(getExerciseGuide(null)).toBeUndefined();
    expect(getExerciseGuide(undefined)).toBeUndefined();
  });

  it("allExerciseGuides returns the full set", () => {
    expect(allExerciseGuides().length).toBe(guides.length);
  });
});

describe("exercise-guides muscle tags (#735 — one identity, one computation)", () => {
  it("uses only valid MuscleIds", () => {
    for (const g of guides) {
      for (const m of [...g.primaryMuscles, ...g.secondaryMuscles]) {
        expect(MUSCLE_SET.has(m), `${g.key}: invalid MuscleId "${m}"`).toBe(
          true
        );
      }
    }
  });

  it("has at least one primary muscle per guide", () => {
    for (const g of guides) {
      expect(
        g.primaryMuscles.length,
        `${g.key} has no primary`
      ).toBeGreaterThan(0);
    }
  });

  it("matches the catalog base lift's tags exactly (reuse, not a re-derivation)", () => {
    for (const g of guides) {
      const info = liftInfo(g.key) ?? liftInfo(baseLiftName(g.key));
      expect(info, `${g.key}: no catalog lift`).toBeDefined();
      expect(g.primaryMuscles, `${g.key} primary`).toEqual(
        info!.primaryMuscles
      );
      expect(g.secondaryMuscles, `${g.key} secondary`).toEqual(
        info!.secondaryMuscles
      );
    }
  });

  it("every primary muscle rolls up into the catalog lift's declared region", () => {
    for (const g of guides) {
      const info = liftInfo(g.key) ?? liftInfo(baseLiftName(g.key));
      const regions = new Set<string>(
        g.primaryMuscles.map((m: MuscleId) => muscleRegion(m))
      );
      expect(
        regions.has(info!.region),
        `${g.key}: primary muscles ${[...regions].join("/")} don't include region ${info!.region}`
      ).toBe(true);
    }
  });
});

describe("exercise-guides content integrity", () => {
  it("has non-empty setup, execution, and commonMistakes for every guide", () => {
    for (const g of guides) {
      expect(g.setup.length, `${g.key} setup`).toBeGreaterThan(0);
      expect(g.execution.length, `${g.key} execution`).toBeGreaterThan(0);
      expect(
        g.commonMistakes.length,
        `${g.key} commonMistakes`
      ).toBeGreaterThan(0);
      for (const step of [...g.setup, ...g.execution, ...g.commonMistakes]) {
        expect(typeof step, g.key).toBe("string");
        expect(step.trim().length, `${g.key}: empty string`).toBeGreaterThan(0);
      }
    }
  });

  it("uses only valid Equipment keys in equipmentNotes", () => {
    const valid = new Set<string>(EQUIPMENT);
    for (const g of guides) {
      if (!g.equipmentNotes) continue;
      for (const [eq, note] of Object.entries(g.equipmentNotes)) {
        expect(valid.has(eq), `${g.key}: invalid equipment "${eq}"`).toBe(true);
        expect((note ?? "").trim().length, `${g.key}.${eq}`).toBeGreaterThan(0);
      }
    }
  });

  it("survives a JSON round-trip", () => {
    const round = JSON.parse(JSON.stringify(guidesJson));
    expect(round).toEqual(guidesJson);
  });
});
