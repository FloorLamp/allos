// DB INTEGRATION TIER — Strava perceived_exertion (RPE) → activities.intensity (#1125).
//
// Proves the import-side write path to the subjective session-effort seam:
//   - a Strava record with perceived_exertion lands the RPE band on
//     activities.intensity, while relative_effort still reads suffer_score
//     (subjective and objective effort signals never cross);
//   - a record with no perceived_exertion leaves intensity NULL (no invented rating);
//   - the #133 user-edit lock protects a later in-app / #1122 rating — a re-push
//     carrying a DIFFERENT Strava RPE is counted `edited`, the human value survives;
//   - an un-edited row updates when the Strava RPE band changes;
//   - a re-push with an unchanged RPE is `unchanged` (SELECT-before-compare), and
//     suffer_score keeps landing on relative_effort untouched throughout.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { upsertActivities } from "@/lib/integrations/normalize";
import { mapStravaActivity } from "@/lib/integrations/strava";

const SOURCE = "strava";
let profileId: number;

// Build a normalized Strava activity from a summary record, asserting it parsed.
function stravaActivity(over: Record<string, unknown>) {
  const res = mapStravaActivity({
    id: 1,
    name: "ride",
    sport_type: "Ride",
    start_date_local: "2024-06-01T08:00:00Z",
    moving_time: 3600,
    elapsed_time: 3700,
    distance: 20000,
    ...over,
  });
  if (!res) throw new Error("mapStravaActivity returned null");
  return res.activity;
}

function storedRow(externalId: string) {
  return db
    .prepare(
      "SELECT intensity, relative_effort, edited FROM activities WHERE profile_id = ? AND external_id = ?"
    )
    .get(profileId, externalId) as {
    intensity: string | null;
    relative_effort: number | null;
    edited: number | null;
  };
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('STRAVA-RPE')").run()
      .lastInsertRowid
  );
});

describe("Strava perceived_exertion → activities.intensity (#1125)", () => {
  it("maps the manual RPE onto intensity; suffer_score stays on relative_effort", () => {
    const ride = stravaActivity({
      id: 111,
      perceived_exertion: 8,
      suffer_score: 142,
    });
    // Sanity on the normalized shape before the DB round-trip.
    expect(ride.intensity).toBe("hard");
    expect(ride.relative_effort).toBe(142);

    expect(upsertActivities(profileId, [ride], SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });

    const row = storedRow(ride.external_id);
    // Subjective RPE landed on intensity...
    expect(row.intensity).toBe("hard");
    // ...and the objective HR-derived load is untouched on relative_effort.
    expect(row.relative_effort).toBe(142);
  });

  it("no perceived_exertion → intensity NULL (relative_effort still set)", () => {
    const ride = stravaActivity({
      id: 222,
      suffer_score: 90,
      start_date_local: "2024-06-02T08:00:00Z",
    });
    expect(ride.intensity ?? null).toBeNull();

    expect(upsertActivities(profileId, [ride], SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });

    const row = storedRow(ride.external_id);
    expect(row.intensity).toBeNull();
    expect(row.relative_effort).toBe(90);
  });

  it("identical re-push is unchanged; a changed RPE band updates an un-edited row", () => {
    const ride = stravaActivity({
      id: 333,
      perceived_exertion: 2, // easy
      suffer_score: 40,
      start_date_local: "2024-06-03T08:00:00Z",
    });
    expect(upsertActivities(profileId, [ride], SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
    expect(storedRow(ride.external_id).intensity).toBe("easy");

    // Same RPE → SELECT-before-compare sees no change → unchanged, not a spurious update.
    expect(upsertActivities(profileId, [ride], SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      suppressed: 0,
      edited: 0,
    });

    // Athlete revises the RPE up to a harder band → intensity updates (row un-edited).
    const harder = stravaActivity({
      id: 333,
      perceived_exertion: 9, // hard
      suffer_score: 40,
      start_date_local: "2024-06-03T08:00:00Z",
    });
    expect(upsertActivities(profileId, [harder], SOURCE)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
    expect(storedRow(harder.external_id).intensity).toBe("hard");
  });

  it("an in-app rating (edit lock #133) survives a re-push carrying a different Strava RPE", () => {
    const ride = stravaActivity({
      id: 444,
      perceived_exertion: 8, // hard, on first import
      suffer_score: 120,
      start_date_local: "2024-06-04T08:00:00Z",
    });
    expect(upsertActivities(profileId, [ride], SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });

    // The user re-rates the session in-app (or via the #1122 Telegram buttons):
    // the app's edit path flips `edited` and sets the human intensity.
    db.prepare(
      "UPDATE activities SET edited = 1, intensity = 'easy' WHERE profile_id = ? AND external_id = ?"
    ).run(profileId, ride.external_id);

    // Next rolling-window push carries a DIFFERENT Strava RPE — must be skipped as
    // edit-locked, never clobbering the human rating.
    const rePush = stravaActivity({
      id: 444,
      perceived_exertion: 3, // easy band from Strava, but the row is edit-locked
      suffer_score: 120,
      start_date_local: "2024-06-04T08:00:00Z",
    });
    expect(upsertActivities(profileId, [rePush], SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 1,
    });

    const row = storedRow(ride.external_id);
    expect(row.intensity).toBe("easy"); // the human value survived
    expect(row.edited).toBe(1);
  });
});
