import { describe, expect, it } from "vitest";
import { parseExerciseJson } from "@/lib/integrations/fitbit-takeout";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { mapOuraWorkout } from "@/lib/integrations/oura";
import { mapStravaActivity } from "@/lib/integrations/strava";

// ISSUE #4537 — THE CROSS-SOURCE REGRESSION.
//
// The owner records the same ride on two apps at once, so one physical session
// arrives through two mappers and lands in the same `distance_km` / `duration_min`
// columns the activity duplicate/merge detector compares. Before the shared unit
// boundary each mapper spelled its own conversion and its own rounding, and the
// question "what does 5,432 m store as" had a per-source answer.
//
// This is the test that would have caught that: ONE physical session, stated the way
// each source states it, through each source's REAL mapper, asserted to agree
// exactly. It fails the moment any mapper re-acquires a private rounding rule.

const TZ = "UTC";
// One 5,432 m session lasting 3,661 s — the issue's own example distance, and a
// duration whose seconds (61.016 min) round rather than divide evenly.
const METRES = 5432;
const SECONDS = 3661;
const EXPECT_KM = 5.43;
const EXPECT_MIN = 61;

function stravaKm(): { km: number | null; min: number | null } {
  const res = mapStravaActivity({
    id: 12345,
    name: "morning ride",
    sport_type: "Ride",
    start_date_local: "2026-05-01T08:00:00Z",
    moving_time: SECONDS,
    elapsed_time: SECONDS,
    distance: METRES, // Strava states METRES
  });
  return {
    km: res!.activity.distance_km,
    min: res!.activity.duration_min,
  };
}

function ouraKm(): { km: number | null; min: number | null } {
  const res = mapOuraWorkout({
    id: "workout-abc",
    activity: "running",
    day: "2026-05-01",
    distance: METRES, // Oura states METRES
    start_datetime: "2026-05-01T08:00:00Z",
    end_datetime: new Date(Date.UTC(2026, 4, 1, 8, 0, 0) + SECONDS * 1000)
      .toISOString()
      .replace(".000", ""),
    intensity: "moderate",
    label: null,
    source: "manual",
  });
  return { km: res!.activity.distance_km, min: res!.activity.duration_min };
}

function healthConnectKm(): { km: number | null; min: number | null } {
  const out = parseHealthConnectPayload(
    {
      exercise: [
        {
          type: "running",
          start_time: "2026-05-01T08:00:00Z",
          end_time: new Date(Date.UTC(2026, 4, 1, 8, 0, 0) + SECONDS * 1000)
            .toISOString()
            .replace(".000", ""),
          distance_meters: METRES, // Health Connect states METRES
        },
      ],
    },
    TZ
  );
  return {
    km: out.activities[0].distance_km,
    min: out.activities[0].duration_min,
  };
}

// The Fitbit archive is the only source that STATES its unit per log, so it gets one
// row per spelling — including miles, whose factor used to be a private constant in
// that mapper rather than `toKm`'s.
function fitbitKm(
  distance: number,
  distanceUnit: string
): { km: number | null; min: number | null } {
  const out = parseExerciseJson(
    JSON.stringify([
      {
        logId: 1,
        activityName: "Run",
        startTime: "05/01/26 08:00:00",
        activeDuration: SECONDS * 1000, // the archive states MILLISECONDS
        distance,
        distanceUnit,
      },
    ]),
    TZ
  );
  return {
    km: out.activities[0].distance_km,
    min: out.activities[0].duration_min,
  };
}

describe("one canonical distance and duration across the mappers (issue #4537)", () => {
  it.each<[string, () => { km: number | null; min: number | null }]>([
    ["strava (metres, seconds)", stravaKm],
    ["oura (metres, instants)", ouraKm],
    ["health connect (metres, instants)", healthConnectKm],
    ["fitbit archive (metres, millis)", () => fitbitKm(METRES, "meters")],
    ["fitbit archive (km, millis)", () => fitbitKm(METRES / 1000, "kilometer")],
    [
      "fitbit archive (miles, millis)",
      () => fitbitKm(3.3753413390382526, "Mile"),
    ],
  ])("%s stores the same session", (_name, read) => {
    expect(read()).toEqual({ km: EXPECT_KM, min: EXPECT_MIN });
  });

  // Health Connect's interval samples are the sixth distance site and land in
  // `metric_samples`, not `activities` — the same boundary, a different column.
  it("stores the identical kilometres for a distance interval sample", () => {
    const out = parseHealthConnectPayload(
      {
        distance: [
          {
            start_time: "2026-05-01T00:00:00Z",
            end_time: "2026-05-02T00:00:00Z",
            meters: METRES,
          },
        ],
      },
      TZ
    );
    const sample = out.samples.find((s) => s.metric === "distance_km");
    expect(sample?.value).toBe(EXPECT_KM);
  });
});
