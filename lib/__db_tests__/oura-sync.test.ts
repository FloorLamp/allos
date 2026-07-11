// DB INTEGRATION TIER — Oura response → rows → idempotent upserts.
//
// Drives the Oura pure mappers (mapOuraSleep/mapOuraWorkout) through the SHARED
// normalize upserts against the real schema, proving the two properties issue #140
// requires: re-pushing the same window is all-unchanged (natural-key dedup), and a
// hand-edited imported row is left untouched (the #133 user-edit lock). Runs under
// vitest.db.config.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { mapOuraSleep, mapOuraWorkout, OURA_ID } from "@/lib/integrations/oura";
import {
  upsertActivities,
  upsertBodyMetrics,
  upsertMetricSamples,
  type NormActivity,
  type NormBodyMetric,
  type NormMetricSample,
} from "@/lib/integrations/normalize";

let profileId: number;

const SLEEP = {
  id: "sleep-e2e-1",
  day: "2024-06-02",
  type: "long_sleep",
  bedtime_start: "2024-06-01T23:00:00-07:00",
  bedtime_end: "2024-06-02T07:00:00-07:00",
  total_sleep_duration: 25200, // 420 min
  deep_sleep_duration: 4800,
  rem_sleep_duration: 5400,
  light_sleep_duration: 13200,
  awake_time: 1800,
  average_hrv: 60,
  lowest_heart_rate: 50,
};

const WORKOUT = {
  id: "workout-e2e-1",
  activity: "cycling",
  day: "2024-06-02",
  calories: 520,
  distance: 24000,
  start_datetime: "2024-06-02T18:00:00-07:00",
  end_datetime: "2024-06-02T19:00:00-07:00",
  intensity: "hard",
  label: null,
};

// Rebuild the normalized batch from the fixtures (a fresh sync run).
function batch(): {
  acts: NormActivity[];
  body: NormBodyMetric[];
  samples: NormMetricSample[];
} {
  const acts: NormActivity[] = [];
  const body: NormBodyMetric[] = [];
  const samples: NormMetricSample[] = [];
  const s = mapOuraSleep(SLEEP)!;
  samples.push(...s.samples);
  if (s.bodyMetric) body.push(s.bodyMetric);
  const w = mapOuraWorkout(WORKOUT)!;
  acts.push(w.activity);
  samples.push(...w.samples);
  return { acts, body, samples };
}

function apply() {
  const b = batch();
  return db.transaction(() => ({
    acts: upsertActivities(profileId, b.acts, OURA_ID),
    body: upsertBodyMetrics(profileId, b.body, OURA_ID),
    samples: upsertMetricSamples(profileId, b.samples, OURA_ID),
  }))();
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('OURA-SYNC')").run()
      .lastInsertRowid
  );
});

describe("Oura sync upsert/dedup", () => {
  it("first push inserts everything; an identical re-push is all-unchanged", () => {
    const first = apply();
    // 6 sleep samples (total + 4 stages + hrv) + 1 workout kcal sample = 7 samples.
    expect(first.samples).toEqual({ inserted: 7, updated: 0, unchanged: 0 });
    expect(first.acts).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(first.body).toEqual({ inserted: 1, updated: 0, unchanged: 0 });

    // Re-push the same rolling window → every row dedups on its natural key.
    const second = apply();
    expect(second.samples).toEqual({ inserted: 0, updated: 0, unchanged: 7 });
    expect(second.acts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(second.body).toEqual({ inserted: 0, updated: 0, unchanged: 1 });

    // The workout landed with the right source + external id and grouping component.
    const act = db
      .prepare(
        "SELECT type, title, source, external_id, distance_km, intensity, components FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, "oura:workout-e2e-1") as {
      type: string;
      title: string;
      source: string;
      external_id: string;
      distance_km: number;
      intensity: string | null;
      components: string;
    };
    expect(act.type).toBe("cardio");
    expect(act.source).toBe("oura");
    expect(act.distance_km).toBe(24);
    // Oura's effort level landed in the activities.intensity column.
    expect(act.intensity).toBe("hard");
    expect(JSON.parse(act.components)[0].name).toBe("Cycling");

    // Resting HR landed in body_metrics under source 'oura', keyed on the wake day.
    const bm = db
      .prepare(
        "SELECT resting_hr, source FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?"
      )
      .get(profileId, "2024-06-02", OURA_ID) as {
      resting_hr: number;
      source: string;
    };
    expect(bm.resting_hr).toBe(50);
  });

  it("a hand-edited imported workout survives the next re-push (edit lock #133)", () => {
    apply(); // ensure present
    db.prepare(
      "UPDATE activities SET edited = 1, title = 'My hand-titled ride' WHERE profile_id = ? AND external_id = ?"
    ).run(profileId, "oura:workout-e2e-1");
    const res = apply();
    expect(res.acts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const stored = db
      .prepare(
        "SELECT title FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, "oura:workout-e2e-1") as { title: string };
    expect(stored.title).toBe("My hand-titled ride");
  });

  it("a hand-corrected imported resting HR is never clobbered by a re-push", () => {
    apply();
    db.prepare(
      "UPDATE body_metrics SET edited = 1, resting_hr = 44 WHERE profile_id = ? AND date = ? AND source IS ?"
    ).run(profileId, "2024-06-02", OURA_ID);
    const res = apply();
    expect(res.body).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const bm = db
      .prepare(
        "SELECT resting_hr FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?"
      )
      .get(profileId, "2024-06-02", OURA_ID) as { resting_hr: number };
    expect(bm.resting_hr).toBe(44);
  });

  it("a changed sleep value flips that sample to updated, others stay unchanged", () => {
    apply();
    // Simulate Oura finalizing the night with a corrected total (450 vs 420 min).
    const s = mapOuraSleep({ ...SLEEP, total_sleep_duration: 27000 })!;
    const res = db.transaction(() =>
      upsertMetricSamples(profileId, s.samples, OURA_ID)
    )();
    expect(res.updated).toBe(1); // only sleep_min changed
    expect(res.inserted).toBe(0);
  });

  it("a changed workout intensity flips the activity to updated, then re-dedups", () => {
    apply();
    // Clear any edit lock a prior test set so the change isn't skipped.
    db.prepare(
      "UPDATE activities SET edited = 0 WHERE profile_id = ? AND external_id = ?"
    ).run(profileId, "oura:workout-e2e-1");
    const w = mapOuraWorkout({ ...WORKOUT, intensity: "moderate" })!;
    const changed = db.transaction(() =>
      upsertActivities(profileId, [w.activity], OURA_ID)
    )();
    expect(changed).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const stored = db
      .prepare(
        "SELECT intensity FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, "oura:workout-e2e-1") as { intensity: string };
    expect(stored.intensity).toBe("moderate");
    // Re-applying the same (moderate) intensity is now a no-op → unchanged.
    const again = db.transaction(() =>
      upsertActivities(profileId, [w.activity], OURA_ID)
    )();
    expect(again).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("does not touch a manual body-metrics row for the same date (source-scoped)", () => {
    // A manual weigh-in (NULL source) on the same wake day must be untouched.
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, '2024-06-02', 80, NULL)"
    ).run(profileId);
    apply();
    const manual = db
      .prepare(
        "SELECT weight_kg, resting_hr FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS NULL"
      )
      .get(profileId, "2024-06-02") as {
      weight_kg: number;
      resting_hr: number | null;
    };
    expect(manual.weight_kg).toBe(80);
    expect(manual.resting_hr).toBeNull();
  });
});
