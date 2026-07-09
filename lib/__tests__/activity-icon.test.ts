import { describe, it, expect } from "vitest";
import {
  pickActivityIconKey,
  activityComponentSportNames,
} from "@/lib/activity-icon";

describe("pickActivityIconKey", () => {
  it("strength is always the barbell, regardless of title", () => {
    expect(pickActivityIconKey("strength", "Bench Press")).toBe("barbell");
    expect(pickActivityIconKey("strength", "Bike Sprints")).toBe("barbell");
  });

  it("matches the free-text title when no structured sport is given", () => {
    expect(pickActivityIconKey("cardio", "Morning Run")).toBe("run");
    expect(pickActivityIconKey("cardio", "Cycling")).toBe("bike");
    expect(pickActivityIconKey("sport", "Basketball pickup")).toBe(
      "basketball"
    );
  });

  it("falls back to the per-type generic icon when nothing matches", () => {
    expect(pickActivityIconKey("cardio", "Zone 2 effort")).toBe("run");
    expect(pickActivityIconKey("sport", "Club match")).toBe("medal");
    expect(pickActivityIconKey("mystery", "")).toBe("activity");
  });

  // The bug: a Strava ride's free-text title ("Morning Ride") doesn't contain a
  // cycling keyword, so it fell back to the cardio (run) icon — while the form,
  // which icons off the canonical "Cycling" component, showed a bike.
  it("matches the structured component/sport name before the title", () => {
    expect(pickActivityIconKey("cardio", "Morning Ride", ["Cycling"])).toBe(
      "bike"
    );
    expect(
      pickActivityIconKey("cardio", "Epic Trail Sufferfest", [
        "Mountain Biking",
      ])
    ).toBe("bike");
  });

  it("the sport name wins even when the title alone would match another icon", () => {
    // Without the component this title matches "run"; the canonical sport corrects it.
    expect(pickActivityIconKey("cardio", "Run Club Ride", ["Cycling"])).toBe(
      "bike"
    );
  });

  it('"ride" (word boundary) rescues a component-less ride title', () => {
    expect(pickActivityIconKey("cardio", "Morning Ride")).toBe("bike");
    expect(pickActivityIconKey("cardio", "Strava morning ride")).toBe("bike");
  });

  it('"ride" does not false-match inside other words', () => {
    // "stride" / "pride" / "override" all contain the substring "ride".
    expect(pickActivityIconKey("cardio", "Long Stride Run")).toBe("run");
    expect(pickActivityIconKey("sport", "Pride Match")).toBe("medal");
  });

  it("preserves rule priority (more specific rule wins)", () => {
    expect(pickActivityIconKey("sport", "Table Tennis")).toBe("ping-pong");
    expect(pickActivityIconKey("sport", "Tennis")).toBe("tennis");
    expect(pickActivityIconKey("cardio", "Skipping rope")).toBe("jump-rope");
  });
});

describe("activityComponentSportNames", () => {
  it("returns [] for absent or malformed JSON", () => {
    expect(activityComponentSportNames(null)).toEqual([]);
    expect(activityComponentSportNames(undefined)).toEqual([]);
    expect(activityComponentSportNames("")).toEqual([]);
    expect(activityComponentSportNames("not json")).toEqual([]);
    expect(activityComponentSportNames('{"name":"Cycling"}')).toEqual([]);
  });

  it("extracts non-strength component names", () => {
    const json = JSON.stringify([
      { name: "Cycling", type: "cardio", distance_km: 24.5, duration_min: 62 },
    ]);
    expect(activityComponentSportNames(json)).toEqual(["Cycling"]);
  });

  it("excludes strength component names (a lift can't pull the icon)", () => {
    const json = JSON.stringify([
      { name: "Farmer's Walk", type: "strength" },
      { name: "Rowing", type: "cardio" },
    ]);
    expect(activityComponentSportNames(json)).toEqual(["Rowing"]);
  });

  it("feeds into pickActivityIconKey end to end", () => {
    const json = JSON.stringify([
      { name: "Cycling", type: "cardio", distance_km: 24.5, duration_min: 62 },
    ]);
    expect(
      pickActivityIconKey(
        "cardio",
        "Strava morning ride",
        activityComponentSportNames(json)
      )
    ).toBe("bike");
  });
});
