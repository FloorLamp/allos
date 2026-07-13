// DB INTEGRATION TIER — the real grouping proof for issue #15.
//
// Strava keeps the athlete's freeform title ("new bike day", "lunch spin"), so the
// title-fallback grouping in getCardioByActivity would fragment every uniquely-named
// ride into its own group. The fix attaches a canonical-sport `components` entry to
// each Strava activity; cardio summaries group by component name, so two
// differently-titled rides both mapped to a "Cycling" component collapse into ONE
// "Cycling" group. Also proves upsertActivities round-trips `components` and keeps
// the inserted/updated/unchanged accounting correct when components change.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { upsertActivities } from "@/lib/integrations/normalize";
import { mapStravaActivity } from "@/lib/integrations/strava";
import { getCardioByActivity } from "@/lib/queries";

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

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('STRAVA-GROUP')").run()
      .lastInsertRowid
  );
});

describe("Strava activities group by canonical-sport component (issue #15)", () => {
  it("two differently-titled rides collapse into one 'Cycling' group", () => {
    const rideA = stravaActivity({
      id: 111,
      name: "new bike day",
      distance: 20000,
      moving_time: 3600,
      start_date_local: "2024-06-01T08:00:00Z",
    });
    const rideB = stravaActivity({
      id: 222,
      name: "lunch spin",
      distance: 10000,
      moving_time: 1800,
      start_date_local: "2024-06-02T12:00:00Z",
    });

    // Sanity: the two rows keep their DISTINCT freeform titles but share a "Cycling"
    // component — the whole point of the grouping fix.
    expect(rideA.title).toBe("new bike day");
    expect(rideB.title).toBe("lunch spin");
    expect(rideA.components?.[0].name).toBe("Cycling");
    expect(rideB.components?.[0].name).toBe("Cycling");

    expect(upsertActivities(profileId, [rideA, rideB], SOURCE)).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });

    const cardio = getCardioByActivity(profileId, "km");
    // Exactly one group, named by the canonical sport (NOT either freeform title).
    expect(cardio).toHaveLength(1);
    expect(cardio[0].activity).toBe("Cycling");
    expect(cardio[0].sessions).toBe(2);
    expect(cardio[0].totalDistanceKm).toBe(30); // 20 + 10
  });

  it("upsertActivities round-trips components and accounts for changes", () => {
    const ride = stravaActivity({
      id: 333,
      name: "evening loop",
      sport_type: "Run",
      distance: 5000,
      moving_time: 1500,
      start_date_local: "2024-06-03T18:00:00Z",
    });
    expect(ride.components?.[0].name).toBe("Running");

    expect(upsertActivities(profileId, [ride], SOURCE)).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });

    // The components JSON is persisted verbatim and reparses to the component.
    const stored = db
      .prepare(
        "SELECT components FROM activities WHERE profile_id = ? AND external_id = ?"
      )
      .get(profileId, ride.external_id) as { components: string | null };
    expect(stored.components).not.toBeNull();
    expect(JSON.parse(stored.components!)).toEqual([
      { name: "Running", type: "cardio", distance_km: 5, duration_min: 25 },
    ]);

    // Identical re-sync → unchanged (SELECT-before-compare sees matching JSON).
    expect(upsertActivities(profileId, [ride], SOURCE)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 1,
      suppressed: 0,
      edited: 0,
    });

    // A components-only change → updated (nothing else about the row differs).
    const renamed = {
      ...ride,
      components: [
        {
          name: "Trail Run",
          type: "cardio" as const,
          distance_km: 5,
          duration_min: 25,
        },
      ],
    };
    expect(upsertActivities(profileId, [renamed], SOURCE)).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
      suppressed: 0,
      edited: 0,
    });
  });
});
