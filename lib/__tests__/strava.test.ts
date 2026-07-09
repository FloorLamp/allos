import { describe, it, expect } from "vitest";
import {
  mapStravaActivity,
  stravaSportName,
  splitCamelCase,
} from "@/lib/integrations/strava";

// A minimal Strava summary-activity record; override per test.
function stravaRec(over: Record<string, unknown> = {}) {
  return {
    id: 12345,
    name: "new bike day",
    sport_type: "Ride",
    start_date_local: "2024-05-01T08:00:00Z",
    moving_time: 3600, // 60 min
    elapsed_time: 3700,
    distance: 20000, // 20 km
    ...over,
  };
}

describe("mapStravaActivity — title vs grouping component (issue #15)", () => {
  it("keeps the athlete's freeform name as the title AND adds a canonical 'Cycling' component", () => {
    const res = mapStravaActivity(stravaRec({ name: "new bike day" }));
    expect(res).not.toBeNull();
    const a = res!.activity;
    // Title is the athlete's freeform Strava name — NOT the sport (grouping-only fix).
    expect(a.title).toBe("new bike day");
    expect(a.type).toBe("cardio");
    // One structured component named by the canonical sport, carrying the activity's
    // own distance/duration and the classified type.
    expect(a.components).toEqual([
      { name: "Cycling", type: "cardio", distance_km: 20, duration_min: 60 },
    ]);
  });

  it("Run → component name 'Running' (title still the freeform name)", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "Run", name: "sunrise miles" })
    );
    const a = res!.activity;
    expect(a.title).toBe("sunrise miles");
    expect(a.components?.[0].name).toBe("Running");
    expect(a.components?.[0].type).toBe("cardio");
  });

  it("MountainBikeRide → 'Mountain Biking'", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "MountainBikeRide" })
    );
    expect(res!.activity.components?.[0].name).toBe("Mountain Biking");
  });

  it("unknown sport_type falls back to a camelCase-split Title Case name", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "AlpineSki", name: "powder day" })
    );
    const a = res!.activity;
    expect(a.title).toBe("powder day");
    expect(a.components?.[0].name).toBe("Alpine Ski");
  });

  it("component distance/duration may be null when the record omits them", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "Run", distance: null, moving_time: null })
    );
    expect(res!.activity.components).toEqual([
      {
        name: "Running",
        type: "cardio",
        distance_km: null,
        duration_min: null,
      },
    ]);
  });
});

describe("stravaSportName", () => {
  it("maps the known cycling variants all to 'Cycling'", () => {
    for (const t of ["Ride", "GravelRide", "EBikeRide", "VirtualRide"]) {
      expect(stravaSportName(t)).toBe("Cycling");
    }
  });

  it("maps the remaining catalog sports", () => {
    expect(stravaSportName("Run")).toBe("Running");
    expect(stravaSportName("VirtualRun")).toBe("Running");
    expect(stravaSportName("TrailRun")).toBe("Trail Run");
    expect(stravaSportName("Walk")).toBe("Walking");
    expect(stravaSportName("Hike")).toBe("Hiking");
    expect(stravaSportName("Swim")).toBe("Swimming");
    expect(stravaSportName("Rowing")).toBe("Rowing");
    expect(stravaSportName("WeightTraining")).toBe("Weight Training");
    expect(stravaSportName("Workout")).toBe("Workout");
  });

  it("falls back to camelCase split for unknown sports", () => {
    expect(stravaSportName("AlpineSki")).toBe("Alpine Ski");
    expect(stravaSportName(null)).toBe("Activity");
  });
});

describe("splitCamelCase", () => {
  it("splits PascalCase / camelCase into Title Case words", () => {
    expect(splitCamelCase("AlpineSki")).toBe("Alpine Ski");
    expect(splitCamelCase("StandUpPaddling")).toBe("Stand Up Paddling");
    expect(splitCamelCase("EBikeRide")).toBe("E Bike Ride");
    expect(splitCamelCase("Workout")).toBe("Workout");
  });
});
