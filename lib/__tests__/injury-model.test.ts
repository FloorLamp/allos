import { describe, expect, it } from "vitest";
import {
  injuryConstraints,
  injuryRegions,
  excludedRegions,
  temperedRegions,
  excludedRegionDisclosures,
  excludedRegionLabel,
  parseRegions,
  parseMuscles,
  RECOVERING_LOAD_FACTOR,
  type Injury,
} from "@/lib/injury-model";

function inj(over: Partial<Injury> = {}): Injury {
  return {
    id: 1,
    label: "right shoulder",
    regions: ["Chest", "Shoulders"],
    muscles: [],
    status: "active",
    since: "2026-07-01",
    resolvedDate: null,
    notes: null,
    createdAt: "2026-07-01 00:00:00",
    ...over,
  };
}

describe("injury-model — parsing + region rollup", () => {
  it("parses valid regions and drops garbage", () => {
    expect(parseRegions('["Chest","Legs","Bogus"]')).toEqual(["Chest", "Legs"]);
    expect(parseRegions(null)).toEqual([]);
    expect(parseRegions("not json")).toEqual([]);
  });

  it("parses valid MuscleIds and drops garbage", () => {
    expect(parseMuscles('["biceps","nope"]')).toEqual(["biceps"]);
  });

  it("rolls fine muscles up into their coarse region (REGION_SCOPES order)", () => {
    // biceps → Arms, glutes → Glutes; declared Chest stays. Ordered by REGION_SCOPES.
    expect(injuryRegions(["Chest"], ["biceps", "glutes"])).toEqual([
      "Chest",
      "Arms",
      "Glutes",
    ]);
  });
});

describe("injury-model — constraint shaping", () => {
  it("keeps active + recovering, drops resolved (record kept, no effect)", () => {
    const cs = injuryConstraints([
      inj({ id: 1, status: "active" }),
      inj({ id: 2, status: "recovering" }),
      inj({ id: 3, status: "resolved" }),
    ]);
    expect(cs.map((c) => c.id)).toEqual([1, 2]);
  });

  it("excludes only ACTIVE regions; recovering regions are tempered not excluded", () => {
    const cs = injuryConstraints([
      inj({ id: 1, status: "active", regions: ["Chest"], muscles: [] }),
      inj({ id: 2, status: "recovering", regions: ["Legs"], muscles: [] }),
    ]);
    expect([...excludedRegions(cs)]).toEqual(["Chest"]);
    expect([...temperedRegions(cs)]).toEqual(["Legs"]);
  });

  it("exclusion wins over tempering when a region is both active and recovering", () => {
    const cs = injuryConstraints([
      inj({ id: 1, status: "active", regions: ["Chest"], muscles: [] }),
      inj({ id: 2, status: "recovering", regions: ["Chest"], muscles: [] }),
    ]);
    expect([...excludedRegions(cs)]).toContain("Chest");
    expect([...temperedRegions(cs)]).not.toContain("Chest");
  });
});

describe("injury-model — disclosure (never silent, #838)", () => {
  it("names each excluded region with its responsible injury labels", () => {
    const cs = injuryConstraints([
      inj({
        id: 1,
        label: "right shoulder",
        status: "active",
        regions: ["Chest", "Shoulders"],
        muscles: [],
      }),
    ]);
    const disclosures = excludedRegionDisclosures(cs);
    expect(disclosures.map((d) => d.region)).toEqual(["Chest", "Shoulders"]);
    expect(excludedRegionLabel(disclosures[0])).toBe(
      "Chest (right shoulder injury)"
    );
  });

  it("produces no disclosure for a recovering-only injury (nothing excluded)", () => {
    const cs = injuryConstraints([inj({ status: "recovering" })]);
    expect(excludedRegionDisclosures(cs)).toEqual([]);
  });
});

describe("injury-model — recovering tempering constant", () => {
  it("is a conservative documented fraction below 1", () => {
    expect(RECOVERING_LOAD_FACTOR).toBeGreaterThan(0);
    expect(RECOVERING_LOAD_FACTOR).toBeLessThan(1);
  });
});
