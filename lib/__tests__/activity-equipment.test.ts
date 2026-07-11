import { describe, it, expect } from "vitest";
import {
  equipmentKindsForActivityType,
  usesActivityEquipment,
  equipmentForActivityType,
  pickDefaultActivityEquipment,
} from "@/lib/activity-equipment";
import type { Equipment } from "@/lib/types";

// Pure helpers behind the activity-level equipment picker (issue #342).

function eq(id: number, name: string, category: string | null): Equipment {
  return { id, name, weight_kg: null, category, retired: 0, created_at: "" };
}

const gym: Equipment[] = [
  eq(1, "Trap Bar", "Barbell"), // strength
  eq(2, "Road Bike", "Bike"), // cardio
  eq(3, "Trail Shoes", "Shoes"), // cardio
  eq(4, "Sauna", "Sauna"), // recovery
  eq(5, "Racket", "Other"), // other
  eq(6, "Mystery", null), // null → other
];

describe("equipmentKindsForActivityType", () => {
  it("maps each activity type to its allowed equipment kinds", () => {
    expect(equipmentKindsForActivityType("strength")).toEqual(["strength"]);
    expect(equipmentKindsForActivityType("cardio")).toEqual(["cardio"]);
    expect(equipmentKindsForActivityType("sport")).toEqual(["cardio", "other"]);
  });
});

describe("usesActivityEquipment", () => {
  it("is true for every non-strength type (strength gear is per-set)", () => {
    expect(usesActivityEquipment("strength")).toBe(false);
    expect(usesActivityEquipment("cardio")).toBe(true);
    expect(usesActivityEquipment("sport")).toBe(true);
  });
});

describe("equipmentForActivityType", () => {
  it("offers only cardio gear (bike/shoes) for a cardio activity", () => {
    expect(equipmentForActivityType(gym, "cardio").map((e) => e.id)).toEqual([
      2, 3,
    ]);
  });

  it("offers cardio + other (incl. NULL-category) gear for a sport", () => {
    expect(equipmentForActivityType(gym, "sport").map((e) => e.id)).toEqual([
      2, 3, 5, 6,
    ]);
  });

  it("offers only strength implements for a strength activity", () => {
    expect(equipmentForActivityType(gym, "strength").map((e) => e.id)).toEqual([
      1,
    ]);
  });

  it("preserves input order", () => {
    const reordered = [gym[2], gym[1]]; // shoes, bike
    expect(
      equipmentForActivityType(reordered, "cardio").map((e) => e.id)
    ).toEqual([3, 2]);
  });
});

describe("pickDefaultActivityEquipment", () => {
  const candidates = equipmentForActivityType(gym, "cardio"); // ids 2, 3

  it("returns the last-used id when it is still a valid candidate", () => {
    expect(pickDefaultActivityEquipment(candidates, 3)).toBe(3);
  });

  it("returns null when there is no last-used id", () => {
    expect(pickDefaultActivityEquipment(candidates, null)).toBeNull();
    expect(pickDefaultActivityEquipment(candidates, undefined)).toBeNull();
  });

  it("returns null when the last-used id is not among the candidates (stale/filtered)", () => {
    // id 1 is a strength implement — not a cardio candidate.
    expect(pickDefaultActivityEquipment(candidates, 1)).toBeNull();
    expect(pickDefaultActivityEquipment(candidates, 999)).toBeNull();
  });
});
