// Pure logic — equipment category set + kind classification (issue #341).

import { describe, it, expect } from "vitest";
import {
  EQUIPMENT_CATEGORIES,
  kindOf,
  isBarbell,
  type EquipmentKind,
} from "@/lib/types";

describe("EQUIPMENT_CATEGORIES", () => {
  it("is the one deliberate fixed set, no duplicates", () => {
    expect(EQUIPMENT_CATEGORIES).toEqual([
      "Barbell",
      "Dumbbell",
      "Kettlebell",
      "Machine",
      "Bike",
      "Shoes",
      "Sauna",
      "Cold plunge",
      "Red light",
      "Massage device",
      "Hearing aid",
      "Other",
    ]);
    expect(new Set(EQUIPMENT_CATEGORIES).size).toBe(
      EQUIPMENT_CATEGORIES.length
    );
  });
});

describe("kindOf", () => {
  const cases: [string, EquipmentKind][] = [
    ["Barbell", "strength"],
    ["Dumbbell", "strength"],
    ["Kettlebell", "strength"],
    ["Machine", "strength"],
    ["Bike", "cardio"],
    ["Shoes", "cardio"],
    ["Sauna", "recovery"],
    ["Cold plunge", "recovery"],
    ["Red light", "recovery"],
    ["Massage device", "recovery"],
    ["Hearing aid", "other"],
    ["Other", "other"],
  ];
  it.each(cases)("classifies %s as %s", (category, kind) => {
    expect(kindOf(category)).toBe(kind);
  });

  it("is case-insensitive and trims", () => {
    expect(kindOf("  barbell ")).toBe("strength");
    expect(kindOf("COLD PLUNGE")).toBe("recovery");
  });

  it("falls back to 'other' for unknown / null / empty", () => {
    expect(kindOf(null)).toBe("other");
    expect(kindOf(undefined)).toBe("other");
    expect(kindOf("")).toBe("other");
    expect(kindOf("Resistance band")).toBe("other");
  });

  it("classifies every canonical category (total function over the set)", () => {
    for (const c of EQUIPMENT_CATEGORIES) {
      expect(kindOf(c)).not.toBeUndefined();
    }
  });
});

describe("isBarbell", () => {
  it("only barbell (case-insensitive) gates the plate builder", () => {
    expect(isBarbell("Barbell")).toBe(true);
    expect(isBarbell("barbell")).toBe(true);
    expect(isBarbell("Dumbbell")).toBe(false);
    expect(isBarbell("Machine")).toBe(false);
    expect(isBarbell(null)).toBe(false);
  });
});
