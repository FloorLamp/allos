import { describe, expect, it } from "vitest";
import {
  summarizeEquipmentAvailability,
  liftImplementCategory,
  liftRequiredCategory,
  isLiftAvailable,
  deRankUnavailableLifts,
  type EquipmentAvailability,
} from "../equipment-availability";
import type { Equipment } from "../types";

function eq(over: Partial<Equipment>): Equipment {
  return {
    id: 1,
    name: "Gear",
    weight_kg: null,
    category: null,
    retired: 0,
    created_at: "2026-01-01",
    ...over,
  };
}

describe("summarizeEquipmentAvailability", () => {
  it("empty registry → hasAny false, no categories", () => {
    expect(summarizeEquipmentAvailability([])).toEqual({
      hasAny: false,
      categories: [],
    });
  });

  it("collects distinct present categories, ignoring retired and null", () => {
    const a = summarizeEquipmentAvailability([
      eq({ id: 1, category: "Dumbbell" }),
      eq({ id: 2, category: "Dumbbell" }), // dupe collapses
      eq({ id: 3, category: "Bike" }),
      eq({ id: 4, category: "Barbell", retired: 1 }), // retired excluded
      eq({ id: 5, category: null }), // null ignored
    ]);
    expect(a.hasAny).toBe(true);
    expect(new Set(a.categories)).toEqual(new Set(["Dumbbell", "Bike"]));
  });

  it("a registry of only retired rows is treated as empty", () => {
    expect(
      summarizeEquipmentAvailability([eq({ category: "Barbell", retired: 1 })])
    ).toEqual({ hasAny: false, categories: [] });
  });
});

describe("liftRequiredCategory", () => {
  it("maps barbell lifts (plain + variant) to Barbell", () => {
    expect(liftRequiredCategory("Back Squat")).toBe("Barbell");
    expect(liftRequiredCategory("Barbell Curl")).toBe("Barbell");
    expect(liftRequiredCategory("Deadlift")).toBe("Barbell");
  });

  it("maps dumbbell / machine lifts to their category", () => {
    expect(liftRequiredCategory("Dumbbell Curl")).toBe("Dumbbell");
    expect(liftRequiredCategory("Goblet Squat")).toBe("Dumbbell");
    expect(liftRequiredCategory("Leg Press")).toBe("Machine");
  });

  it("returns null (always available) for cable / bodyweight / unknown", () => {
    expect(liftRequiredCategory("Cable Curl")).toBeNull();
    expect(liftRequiredCategory("Pull Up")).toBeNull(); // bodyweight
    expect(liftRequiredCategory("Plank")).toBeNull(); // timed bodyweight
    expect(liftRequiredCategory("Running")).toBeNull(); // not a lift
    expect(liftRequiredCategory("Underwater Basketweaving")).toBeNull();
  });

  // The two places this gate deliberately parts company with the implement
  // resolver it now narrows. Neither is a missing case, and both are invisible to
  // the cases above: a resolver used raw would gate the swing on owning a
  // kettlebell, and a gate that dropped its own plate-loaded check would stop
  // gating the trap-bar deadlift on a barbell.
  it("keeps its own answer where the resolved implement is not it", () => {
    expect(liftImplementCategory("Kettlebell Swing")).toBe("Kettlebell");
    expect(liftRequiredCategory("Kettlebell Swing")).toBeNull();

    expect(liftImplementCategory("Trap Bar Deadlift")).toBeNull();
    expect(liftRequiredCategory("Trap Bar Deadlift")).toBe("Barbell");
  });
});

describe("liftImplementCategory", () => {
  it("resolves the composed variant's implement, then the lift's normal one", () => {
    expect(liftImplementCategory("Dumbbell Curl")).toBe("Dumbbell");
    expect(liftImplementCategory("Machine Row")).toBe("Machine");
    expect(liftImplementCategory("Back Squat")).toBe("Barbell");
    expect(liftImplementCategory("Leg Press")).toBe("Machine");
  });

  it("is null when the implement is no registry category, unchosen, or unknown", () => {
    expect(liftImplementCategory("Cable Curl")).toBeNull(); // Cable is not one
    expect(liftImplementCategory("Smith Squat")).toBeNull(); // nor is Smith
    expect(liftImplementCategory("Pull Up")).toBeNull(); // nor Bodyweight
    expect(liftImplementCategory("Curl")).toBeNull(); // a choice, none made
    expect(liftImplementCategory("Underwater Basketweaving")).toBeNull();
  });
});

describe("isLiftAvailable", () => {
  const dumbbellOnly: EquipmentAvailability = {
    hasAny: true,
    categories: ["Dumbbell"],
  };
  it("empty/absent registry → everything available", () => {
    expect(isLiftAvailable("Back Squat", null)).toBe(true);
    expect(
      isLiftAvailable("Back Squat", { hasAny: false, categories: [] })
    ).toBe(true);
  });
  it("non-empty registry gates by required category", () => {
    expect(isLiftAvailable("Dumbbell Curl", dumbbellOnly)).toBe(true);
    expect(isLiftAvailable("Back Squat", dumbbellOnly)).toBe(false); // needs Barbell
    expect(isLiftAvailable("Pull Up", dumbbellOnly)).toBe(true); // bodyweight
  });
});

describe("deRankUnavailableLifts", () => {
  const dumbbellOnly: EquipmentAvailability = {
    hasAny: true,
    categories: ["Dumbbell"],
  };
  it("is a no-op for an empty/absent registry", () => {
    const opts = ["Back Squat", "Dumbbell Curl"];
    expect(deRankUnavailableLifts(opts, null)).toBe(opts);
    expect(
      deRankUnavailableLifts(opts, { hasAny: false, categories: [] })
    ).toBe(opts);
  });
  it("sinks unavailable lifts to the bottom, stable within each partition", () => {
    const opts = ["Back Squat", "Dumbbell Curl", "Deadlift", "Goblet Squat"];
    expect(deRankUnavailableLifts(opts, dumbbellOnly)).toEqual([
      "Dumbbell Curl",
      "Goblet Squat",
      "Back Squat",
      "Deadlift",
    ]);
  });
  it("never drops an option (de-rank, not hide)", () => {
    const opts = ["Back Squat", "Dumbbell Curl"];
    expect(new Set(deRankUnavailableLifts(opts, dumbbellOnly))).toEqual(
      new Set(opts)
    );
  });
});
