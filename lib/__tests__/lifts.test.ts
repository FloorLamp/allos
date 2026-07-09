import { describe, expect, it } from "vitest";
import {
  ALL_LIFT_NAMES,
  LIFT_OPTIONS,
  baseLiftName,
  composeVariant,
  defaultEquipment,
  isBarbellLift,
  isBodyweight,
  isTimed,
  isUnilateral,
  liftInfo,
  muscleFor,
  regionForExercise,
  regionsForGroup,
  suggestTitle,
  variantOf,
} from "@/lib/lifts";

describe("composeVariant", () => {
  it("prefixes the equipment to the base name", () => {
    const group = variantOf("Curl")!.group;
    expect(composeVariant(group, "Dumbbell")).toBe("Dumbbell Curl");
    expect(composeVariant(group, "Cable")).toBe("Cable Curl");
  });
});

describe("variantOf", () => {
  it("resolves a composed name to its group and equipment", () => {
    const r = variantOf("Dumbbell Curl");
    expect(r?.group.name).toBe("Curl");
    expect(r?.equipment).toBe("Dumbbell");
  });

  it("resolves a bare base name with null equipment", () => {
    const r = variantOf("Curl");
    expect(r?.group.name).toBe("Curl");
    expect(r?.equipment).toBeNull();
  });

  it("is case- and whitespace-insensitive", () => {
    expect(variantOf("  cable row  ")?.group.name).toBe("Row");
  });

  it("returns null for non-variant lifts", () => {
    expect(variantOf("Deadlift")).toBeNull();
    expect(variantOf("not a lift")).toBeNull();
  });
});

describe("baseLiftName", () => {
  it("collapses a composed variant to its base", () => {
    expect(baseLiftName("Dumbbell Curl")).toBe("Curl");
    expect(baseLiftName("Barbell Bench Press")).toBe("Bench Press");
  });

  it("passes non-composed names through unchanged", () => {
    expect(baseLiftName("Deadlift")).toBe("Deadlift");
    expect(baseLiftName("Curl")).toBe("Curl");
    expect(baseLiftName("Unknown Lift")).toBe("Unknown Lift");
  });
});

describe("liftInfo", () => {
  it("looks up by exact name, case-insensitively", () => {
    expect(liftInfo("deadlift")?.name).toBe("Deadlift");
    expect(liftInfo("  Back Squat ")?.name).toBe("Back Squat");
  });

  it("resolves generated variant defs", () => {
    expect(liftInfo("Dumbbell Curl")?.muscle).toBe("Biceps");
  });

  it("falls back to a loose contains match for non-exact names", () => {
    // Not an exact catalog name, but it contains one ("Incline Bench Press"),
    // so it resolves via the contains-fallback rather than the exact-name map.
    expect(liftInfo("incline bench press (smith machine)")?.name).toBe(
      "Incline Bench Press"
    );
  });

  it("returns undefined for empty and unknown input", () => {
    expect(liftInfo("")).toBeUndefined();
    expect(liftInfo("   ")).toBeUndefined();
    expect(liftInfo("xyzzy")).toBeUndefined();
  });
});

describe("muscleFor / regionForExercise", () => {
  it("returns the muscle and region for a known lift", () => {
    expect(muscleFor("Back Squat")).toBe("Quads");
    expect(regionForExercise("Back Squat")).toBe("Legs");
  });

  it("returns null for an unknown lift", () => {
    expect(muscleFor("xyzzy")).toBeNull();
    expect(regionForExercise("xyzzy")).toBeNull();
  });
});

describe("lift classification flags", () => {
  it("identifies unilateral lifts", () => {
    expect(isUnilateral("Cable Lateral Raise")).toBe(true); // unilateral equipment
    expect(isUnilateral("Machine Lateral Raise")).toBe(false); // bilateral equipment
    expect(isUnilateral("Dumbbell Curl")).toBe(true); // unilateral equipment
    expect(isUnilateral("Barbell Curl")).toBe(false); // bilateral equipment
    expect(isUnilateral("Deadlift")).toBe(false);
  });

  it("identifies timed (isometric hold) lifts", () => {
    expect(isTimed("Plank")).toBe(true);
    expect(isTimed("Dead Hang")).toBe(true);
    expect(isTimed("Deadlift")).toBe(false);
  });

  it("identifies bodyweight-loaded lifts", () => {
    expect(isBodyweight("Pull Up")).toBe(true);
    expect(isBodyweight("Dip")).toBe(true);
    expect(isBodyweight("Back Squat")).toBe(false);
  });

  it("identifies plate-barbell lifts, including barbell variants", () => {
    expect(isBarbellLift("Deadlift")).toBe(true);
    expect(isBarbellLift("Barbell Curl")).toBe(true);
    expect(isBarbellLift("Dumbbell Curl")).toBe(false);
    expect(isBarbellLift("Leg Press")).toBe(false);
  });
});

describe("defaultEquipment", () => {
  it("prioritizes bodyweight then barbell", () => {
    expect(defaultEquipment("Pull Up")).toBe("Bodyweight");
    expect(defaultEquipment("Deadlift")).toBe("Barbell");
  });

  it("maps machine, cable, and dumbbell lifts", () => {
    expect(defaultEquipment("Leg Press")).toBe("Machine");
    expect(defaultEquipment("Tricep Pushdown")).toBe("Cable");
    expect(defaultEquipment("Hammer Curl")).toBe("Dumbbell");
  });

  it("returns null for unknown lifts", () => {
    expect(defaultEquipment("xyzzy")).toBeNull();
  });
});

describe("regionsForGroup", () => {
  it("expands body groups to their regions", () => {
    expect(regionsForGroup("Lower")).toEqual(["Legs", "Glutes"]);
    expect(regionsForGroup("Core")).toEqual(["Core"]);
    expect(regionsForGroup("Upper")).toContain("Chest");
    expect(regionsForGroup("Full")).toHaveLength(7);
  });
});

describe("catalog exports", () => {
  it("LIFT_OPTIONS includes variant base names but not composed variants", () => {
    expect(LIFT_OPTIONS).toContain("Curl");
    expect(LIFT_OPTIONS).not.toContain("Dumbbell Curl");
  });

  it("ALL_LIFT_NAMES includes the composed variants", () => {
    expect(ALL_LIFT_NAMES).toContain("Dumbbell Curl");
    expect(ALL_LIFT_NAMES).toContain("Deadlift");
  });
});

describe("suggestTitle", () => {
  it("falls back to a generic session when nothing is recognized", () => {
    expect(suggestTitle(["xyzzy"])).toBe("Strength session");
    expect(suggestTitle([])).toBe("Strength session");
  });

  it("names the region when all lifts share one", () => {
    // Bench Press + Incline Bench Press are both Chest.
    expect(suggestTitle(["Bench Press", "Incline Bench Press"])).toBe(
      "Chest workout"
    );
  });

  it("names the movement when all lifts share one pattern across regions", () => {
    // Bench Press (Chest/push) + Overhead Press (Shoulders/push) → Push day.
    expect(suggestTitle(["Bench Press", "Overhead Press"])).toBe("Push day");
  });

  it("names the dominant region when one makes up ≥60%", () => {
    // 2 Chest (push) + 1 Pull Up (Back/pull): regions & patterns both vary,
    // but Chest is 2/3 ≈ 67% ≥ 60%.
    expect(
      suggestTitle(["Bench Press", "Incline Bench Press", "Pull Up"])
    ).toBe("Chest workout");
  });

  it("falls back to full body when nothing dominates", () => {
    // Mixed regions and patterns with no 60% majority.
    expect(
      suggestTitle(["Bench Press", "Deadlift", "Back Squat", "Lateral Raise"])
    ).toBe("Full body workout");
  });
});
