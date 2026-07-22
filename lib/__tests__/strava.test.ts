import { describe, it, expect } from "vitest";
import {
  mapStravaActivity,
  stravaSportName,
  splitCamelCase,
  rpeToIntensity,
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

describe("mapStravaActivity — cadence (#419)", () => {
  it("stores cadence for a run (provider-raw per-leg value), not just cycling", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "Run", average_cadence: 89.6 })
    );
    // Rounded, stored raw (per-leg) — not doubled to steps/min.
    expect(res!.activity.avg_cadence).toBe(90);
  });

  it("stores cadence for cycling as before", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "Ride", average_cadence: 92 })
    );
    expect(res!.activity.avg_cadence).toBe(92);
  });

  it("leaves cadence null for a non-run/non-ride sport", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "Swim", average_cadence: 30 })
    );
    expect(res!.activity.avg_cadence).toBeNull();
  });

  it("drops an out-of-range run cadence but keeps the activity (#132)", () => {
    const res = mapStravaActivity(
      stravaRec({ sport_type: "TrailRun", average_cadence: 5000 })
    );
    expect(res).not.toBeNull();
    expect(res!.activity.avg_cadence).toBeNull();
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

describe("mapStravaActivity — plausibility bounds (#132)", () => {
  function stravaRec(over: Record<string, unknown> = {}) {
    return {
      id: 12345,
      name: "ride",
      sport_type: "Ride",
      start_date_local: "2024-05-01T08:00:00Z",
      moving_time: 3600,
      elapsed_time: 3700,
      distance: 20000,
      ...over,
    };
  }

  it("rejects the whole activity when its core distance is impossible", () => {
    // 5,000 km in one activity — reject the record entirely (caller counts skipped).
    const res = mapStravaActivity(stravaRec({ distance: 5_000_000 }));
    expect(res).toBeNull();
  });

  it("rejects the whole activity when its duration is impossible", () => {
    // moving_time in seconds → 3000 min > the 2880 (48h) ceiling.
    const res = mapStravaActivity(stravaRec({ moving_time: 180_000 }));
    expect(res).toBeNull();
  });

  it("keeps the ride but nulls an out-of-range optional field (avg HR)", () => {
    const res = mapStravaActivity(
      stravaRec({
        has_heartrate: true,
        average_heartrate: 5000,
        max_heartrate: 150,
      })
    );
    expect(res).not.toBeNull();
    // The bogus avg HR is dropped; the plausible max HR survives.
    expect(res!.activity.avg_hr).toBeNull();
    expect(res!.activity.max_hr).toBe(150);
  });

  it("drops an out-of-range calories sample but keeps the activity", () => {
    const res = mapStravaActivity(stravaRec(), { calories: 999_999 });
    expect(res).not.toBeNull();
    expect(res!.samples).toHaveLength(0);
  });

  it("keeps a plausible ride and its metrics untouched", () => {
    const res = mapStravaActivity(
      stravaRec({ average_watts: 220, average_speed: 8 }),
      { calories: 600 }
    );
    expect(res).not.toBeNull();
    expect(res!.activity.avg_power_w).toBe(220);
    expect(res!.samples).toHaveLength(1);
    expect(res!.samples[0].value).toBe(600);
    expect(res!.samples[0].activity_external_id).toBe("strava:12345");
  });
});

describe("mapStravaActivity — route capture (#569)", () => {
  it("captures the summary polyline + start/end coordinates", () => {
    // Synthetic polyline over a public-park loop (no residential anchor), per the
    // no-real-PHI fixture rule.
    const res = mapStravaActivity(
      stravaRec({
        map: { id: "a12345", summary_polyline: "_p~iF~ps|U_ulLnnqC" },
        start_latlng: [38.5, -120.2],
        end_latlng: [40.7, -120.95],
      })
    );
    expect(res).not.toBeNull();
    expect(res!.route).not.toBeNull();
    expect(res!.route!.external_id).toBe("strava:12345");
    expect(res!.route!.polyline).toBe("_p~iF~ps|U_ulLnnqC");
    expect(res!.route!.start_lat).toBe(38.5);
    expect(res!.route!.end_lng).toBe(-120.95);
  });

  it("prefers the summary polyline over the full-res detail polyline (privacy zones)", () => {
    const res = mapStravaActivity(
      stravaRec({ map: { summary_polyline: "SUMMARY" } }),
      { map: { summary_polyline: "SUMMARY", polyline: "FULLRES" } }
    );
    expect(res!.route!.polyline).toBe("SUMMARY");
  });

  it("falls back to the detail polyline only when no summary is present", () => {
    const res = mapStravaActivity(stravaRec({ map: {} }), {
      map: { polyline: "FULLRES" },
    });
    expect(res!.route!.polyline).toBe("FULLRES");
  });

  it("returns a null route for an activity with no map (e.g. a trainer ride)", () => {
    const res = mapStravaActivity(stravaRec({ trainer: true }));
    expect(res!.route).toBeNull();
  });
});

describe("rpeToIntensity — subjective 1–10 RPE → intensity band (#1125)", () => {
  it("bands the boundary values 3/4/6/7 into easy/moderate/hard", () => {
    // 1–3 easy, 4–6 moderate, 7+ hard — pinned at the 3/4 and 6/7 seams.
    expect(rpeToIntensity(1)).toBe("easy");
    expect(rpeToIntensity(3)).toBe("easy");
    expect(rpeToIntensity(4)).toBe("moderate");
    expect(rpeToIntensity(6)).toBe("moderate");
    expect(rpeToIntensity(7)).toBe("hard");
    expect(rpeToIntensity(10)).toBe("hard");
  });

  it("absent / out-of-scale / non-finite → null (no invented rating)", () => {
    expect(rpeToIntensity(null)).toBeNull();
    expect(rpeToIntensity(undefined)).toBeNull();
    expect(rpeToIntensity(0)).toBeNull();
    expect(rpeToIntensity(-2)).toBeNull();
    expect(rpeToIntensity(NaN)).toBeNull();
  });
});

describe("mapStravaActivity — perceived_exertion → intensity (#1125)", () => {
  it("maps the manual RPE onto activities.intensity while suffer_score stays on relative_effort", () => {
    const res = mapStravaActivity(
      stravaRec({ perceived_exertion: 8, suffer_score: 142 })
    );
    const a = res!.activity;
    // Subjective RPE → intensity (the subjective seam)...
    expect(a.intensity).toBe("hard");
    // ...and the objective HR-derived load stays exactly where it was (never crossed).
    expect(a.relative_effort).toBe(142);
  });

  it("moderate-band RPE maps to 'moderate'", () => {
    const res = mapStravaActivity(stravaRec({ perceived_exertion: 5 }));
    expect(res!.activity.intensity).toBe("moderate");
  });

  it("no perceived_exertion → intensity NULL (unchanged from today), suffer_score untouched", () => {
    const res = mapStravaActivity(stravaRec({ suffer_score: 90 }));
    const a = res!.activity;
    expect(a.intensity ?? null).toBeNull();
    expect(a.relative_effort).toBe(90);
  });
});
