import { describe, it, expect } from "vitest";
import {
  mapOuraSleep,
  mapOuraWorkout,
  classifyOuraActivity,
  ouraSportName,
  ouraIntensity,
  titleizeActivity,
} from "@/lib/integrations/oura";

// Synthetic Oura API v2 fixtures — shapes/units mirror the real API
// (https://cloud.ouraring.com/v2/docs) with obviously-fake ids/values.

function sleepRec(over: Record<string, unknown> = {}) {
  return {
    id: "sleep-0001",
    day: "2024-05-02",
    type: "long_sleep",
    bedtime_start: "2024-05-01T23:10:00-07:00",
    bedtime_end: "2024-05-02T07:10:00-07:00",
    total_sleep_duration: 27000, // 450 min
    deep_sleep_duration: 5400, // 90 min
    rem_sleep_duration: 5400, // 90 min
    light_sleep_duration: 14400, // 240 min
    awake_time: 1800, // 30 min
    average_hrv: 65,
    lowest_heart_rate: 48,
    average_heart_rate: 56,
    ...over,
  };
}

function workoutRec(over: Record<string, unknown> = {}) {
  return {
    id: "workout-abc",
    activity: "running",
    day: "2024-05-02",
    calories: 480,
    distance: 8000, // 8 km
    start_datetime: "2024-05-02T17:00:00-07:00",
    end_datetime: "2024-05-02T17:45:00-07:00",
    intensity: "moderate",
    label: null,
    source: "manual",
    ...over,
  };
}

describe("mapOuraSleep", () => {
  it("maps a long-sleep period to total + stage samples, HRV, and resting HR", () => {
    const res = mapOuraSleep(sleepRec());
    expect(res).not.toBeNull();
    const byMetric = Object.fromEntries(
      res!.samples.map((s) => [s.metric, s.value])
    );
    expect(byMetric).toEqual({
      sleep_min: 450,
      sleep_deep_min: 90,
      sleep_rem_min: 90,
      sleep_light_min: 240,
      sleep_awake_min: 30,
      hrv_ms: 65,
    });
    // Every sample is attributed to the wake day and keyed on the bedtime window.
    for (const s of res!.samples) {
      expect(s.date).toBe("2024-05-02");
      expect(s.start_time).toBe("2024-05-01T23:10:00-07:00");
      expect(s.end_time).toBe("2024-05-02T07:10:00-07:00");
    }
    // Resting (lowest) HR → a body_metrics row on the wake day.
    expect(res!.bodyMetric).toEqual({ date: "2024-05-02", resting_hr: 48 });
  });

  it("skips naps and rest periods (only long_sleep is mapped)", () => {
    expect(mapOuraSleep(sleepRec({ type: "late_nap" }))).toBeNull();
    expect(mapOuraSleep(sleepRec({ type: "rest" }))).toBeNull();
  });

  it("returns no body metric when resting HR is absent", () => {
    const res = mapOuraSleep(sleepRec({ lowest_heart_rate: null }));
    expect(res!.bodyMetric).toBeNull();
    // Sleep samples are still produced.
    expect(res!.samples.some((s) => s.metric === "sleep_min")).toBe(true);
  });

  it("omits a stage sample the payload doesn't carry, keeping the rest", () => {
    const res = mapOuraSleep(sleepRec({ rem_sleep_duration: null }));
    const metrics = res!.samples.map((s) => s.metric);
    expect(metrics).not.toContain("sleep_rem_min");
    expect(metrics).toContain("sleep_deep_min");
  });

  it("drops an out-of-range HRV but keeps the night's sleep (plausibility #132)", () => {
    // hrv_ms bound is 0–2000; 99999 is a sensor fault.
    const res = mapOuraSleep(sleepRec({ average_hrv: 99999 }));
    expect(res!.samples.some((s) => s.metric === "hrv_ms")).toBe(false);
    expect(res!.samples.some((s) => s.metric === "sleep_min")).toBe(true);
  });

  it("returns null for an unusable period (no window / no total)", () => {
    expect(mapOuraSleep(sleepRec({ total_sleep_duration: null }))).toBeNull();
    expect(mapOuraSleep(sleepRec({ bedtime_start: null }))).toBeNull();
    expect(mapOuraSleep(null)).toBeNull();
  });
});

describe("mapOuraWorkout", () => {
  it("maps a run to a cardio activity with a canonical Running component + calories", () => {
    const res = mapOuraWorkout(workoutRec());
    expect(res).not.toBeNull();
    const a = res!.activity;
    expect(a.external_id).toBe("oura:workout-abc");
    expect(a.date).toBe("2024-05-02");
    expect(a.type).toBe("cardio");
    expect(a.title).toBe("Running"); // label was null → canonical name
    expect(a.distance_km).toBe(8);
    expect(a.duration_min).toBe(45);
    expect(a.start_time).toBe("17:00");
    expect(a.end_time).toBe("17:45");
    expect(a.components).toEqual([
      { name: "Running", type: "cardio", distance_km: 8, duration_min: 45 },
    ]);
    // Oura's effort level rides through to activities.intensity.
    expect(a.intensity).toBe("moderate");
    // Calories → one active_kcal sample keyed on the workout instant window.
    expect(res!.samples).toHaveLength(1);
    expect(res!.samples[0].metric).toBe("active_kcal");
    expect(res!.samples[0].value).toBe(480);
  });

  it("maps each intensity level and nulls an unknown/absent one", () => {
    expect(
      mapOuraWorkout(workoutRec({ intensity: "easy" }))!.activity.intensity
    ).toBe("easy");
    expect(
      mapOuraWorkout(workoutRec({ intensity: "HARD" }))!.activity.intensity
    ).toBe("hard");
    expect(
      mapOuraWorkout(workoutRec({ intensity: "extreme" }))!.activity.intensity
    ).toBeNull();
    expect(
      mapOuraWorkout(workoutRec({ intensity: null }))!.activity.intensity
    ).toBeNull();
  });

  it("prefers a freeform label as the title when present", () => {
    const res = mapOuraWorkout(workoutRec({ label: "Sunrise loop" }));
    expect(res!.activity.title).toBe("Sunrise loop");
    // Grouping still uses the canonical sport component.
    expect(res!.activity.components?.[0].name).toBe("Running");
  });

  it("classifies strength_training as a strength activity → Weight Training", () => {
    const res = mapOuraWorkout(
      workoutRec({ activity: "strength_training", distance: null })
    );
    expect(res!.activity.type).toBe("strength");
    expect(res!.activity.components?.[0].name).toBe("Weight Training");
  });

  it("rejects the whole workout when its core distance is impossible", () => {
    // 5,000 km in one workout — distance_km bound is 0–1000.
    expect(mapOuraWorkout(workoutRec({ distance: 5_000_000 }))).toBeNull();
  });

  it("drops an out-of-range calories sample but keeps the workout", () => {
    const res = mapOuraWorkout(workoutRec({ calories: 999_999 }));
    expect(res).not.toBeNull();
    expect(res!.samples).toHaveLength(0);
  });

  it("returns null when the id or start is missing", () => {
    expect(mapOuraWorkout(workoutRec({ id: null }))).toBeNull();
    expect(mapOuraWorkout(workoutRec({ start_datetime: null }))).toBeNull();
    expect(mapOuraWorkout(null)).toBeNull();
  });
});

describe("classifyOuraActivity", () => {
  it("classifies cardio / strength / sport", () => {
    expect(classifyOuraActivity("running")).toBe("cardio");
    expect(classifyOuraActivity("indoor_cycling")).toBe("cardio");
    expect(classifyOuraActivity("strength_training")).toBe("strength");
    expect(classifyOuraActivity("tennis")).toBe("sport");
  });
});

describe("ouraSportName / titleizeActivity", () => {
  it("maps known activities to catalog names", () => {
    expect(ouraSportName("running")).toBe("Running");
    expect(ouraSportName("indoor_cycling")).toBe("Cycling");
    expect(ouraSportName("strength_training")).toBe("Weight Training");
  });

  it("falls back to a title-cased snake_case name", () => {
    expect(ouraSportName("kickboxing")).toBe("Kickboxing");
    expect(ouraSportName("stand_up_paddling")).toBe("Stand Up Paddling");
    expect(ouraSportName(null)).toBe("Workout");
  });

  it("titleizes tokens", () => {
    expect(titleizeActivity("indoor_cycling")).toBe("Indoor Cycling");
  });
});

describe("ouraIntensity", () => {
  it("accepts the three scale values (case-insensitive), rejects everything else", () => {
    expect(ouraIntensity("easy")).toBe("easy");
    expect(ouraIntensity("Moderate")).toBe("moderate");
    expect(ouraIntensity("hard")).toBe("hard");
    expect(ouraIntensity("vigorous")).toBeNull();
    expect(ouraIntensity("")).toBeNull();
    expect(ouraIntensity(null)).toBeNull();
    expect(ouraIntensity(3)).toBeNull();
  });
});
