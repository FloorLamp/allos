import { describe, it, expect } from "vitest";
import {
  equipmentKindsForActivityType,
  usesActivityEquipment,
  equipmentForActivityType,
  equipmentForActivity,
  cardioGearCategories,
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

// Issue #339: the cardio-specific gear affinity — a run wears shoes, a ride a bike.
describe("cardioGearCategories", () => {
  it("maps foot-based activities to Shoes (curated and coined names)", () => {
    for (const name of [
      "Running",
      "Trail Run",
      "Walking",
      "Incline Walk",
      "Hiking",
      "Rucking",
      "Treadmill",
      "Morning jog",
    ]) {
      expect(cardioGearCategories(name)).toEqual(["Shoes"]);
    }
  });

  it("maps wheeled activities to Bike (curated and coined names)", () => {
    for (const name of [
      "Cycling",
      "Mountain Biking",
      "Stationary Bike",
      "Air Bike",
      "Spin Class",
      "Bike commute",
    ]) {
      expect(cardioGearCategories(name)).toEqual(["Bike"]);
    }
  });

  it("returns [] for cardio with no shoe/wheel affinity, and for empty names", () => {
    expect(cardioGearCategories("Rowing")).toEqual([]);
    expect(cardioGearCategories("Swimming")).toEqual([]);
    expect(cardioGearCategories("Elliptical")).toEqual([]);
    expect(cardioGearCategories("")).toEqual([]);
    expect(cardioGearCategories(null)).toEqual([]);
    expect(cardioGearCategories(undefined)).toEqual([]);
  });
});

describe("equipmentForActivity (issue #339 cardio narrowing)", () => {
  it("narrows a run to Shoes only (not the bike)", () => {
    expect(
      equipmentForActivity(gym, "cardio", "Trail Run").map((e) => e.id)
    ).toEqual([3]);
  });

  it("narrows a ride to Bikes only (not the shoes)", () => {
    expect(
      equipmentForActivity(gym, "cardio", "Cycling").map((e) => e.id)
    ).toEqual([2]);
  });

  it("keeps all cardio gear for a generic cardio activity (no affinity)", () => {
    expect(
      equipmentForActivity(gym, "cardio", "Rowing").map((e) => e.id)
    ).toEqual([2, 3]);
    // No name at all also falls back to the kind-level filter.
    expect(equipmentForActivity(gym, "cardio", null).map((e) => e.id)).toEqual([
      2, 3,
    ]);
  });

  it("narrows strictly: a run with no shoes on file offers nothing", () => {
    const bikeOnly = [gym[1]]; // just the Road Bike
    expect(equipmentForActivity(bikeOnly, "cardio", "Running")).toEqual([]);
  });

  it("does not narrow non-cardio types (sport keeps cardio + other)", () => {
    expect(
      equipmentForActivity(gym, "sport", "Tennis").map((e) => e.id)
    ).toEqual([2, 3, 5, 6]);
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

  // Issue #339: a recency-ordered list picks the FIRST valid candidate, so the
  // narrowed candidate set decides which gear a run vs a ride remembers.
  it("takes the first recent id that is a valid candidate", () => {
    // Most recent (1 = strength) is invalid here; 3 (shoes) is the first valid one.
    expect(pickDefaultActivityEquipment(candidates, [1, 3, 2])).toBe(3);
  });

  it("with a shoes-only candidate set, skips a more-recent bike to the last shoes", () => {
    const shoes = equipmentForActivity(gym, "cardio", "Running"); // id 3 only
    // Recency list: bike (2) used most recently, shoes (3) before it — a run still
    // defaults to the shoes because the bike isn't a candidate for a run.
    expect(pickDefaultActivityEquipment(shoes, [2, 3])).toBe(3);
  });

  it("returns null when no recent id is a valid candidate, or the list is empty", () => {
    expect(pickDefaultActivityEquipment(candidates, [1, 999])).toBeNull();
    expect(pickDefaultActivityEquipment(candidates, [])).toBeNull();
  });
});
