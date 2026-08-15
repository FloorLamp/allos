// DB INTEGRATION TIER — imported active energy follows the activity's stable
// provider identity, not user-editable date/clock fields.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { upsertMetricSamples } from "@/lib/integrations/normalize";
import { getActiveCaloriesForActivities } from "@/lib/queries/training/activities";
import type { Activity } from "@/lib/types";

describe("getActiveCaloriesForActivities", () => {
  it("preserves a zero-valued measurement after date and clock edits", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Energy Link")
        .lastInsertRowid
    );
    const externalId = "strava:synthetic-ride-1";
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, start_time, end_time,
              source, external_id)
           VALUES (?, ?, 'cardio', 'Synthetic ride', 60, ?, ?, 'strava', ?)`
        )
        .run(profileId, "2026-06-01", "08:00", "09:00", externalId)
        .lastInsertRowid
    );

    expect(
      upsertMetricSamples(
        profileId,
        [
          {
            metric: "active_kcal",
            date: "2026-06-01",
            started_at: "2026-06-01T08:00:00.000Z",
            ended_at: "2026-06-01T09:00:00.000Z",
            value: 0,
            activity_external_id: externalId,
          },
        ],
        "strava"
      )
    ).toMatchObject({ inserted: 1 });

    db.prepare(
      `UPDATE activities
          SET date = '2026-07-10', start_time = '13:15', end_time = '14:15'
        WHERE profile_id = ? AND id = ?`
    ).run(profileId, activityId);
    const activity = db
      .prepare("SELECT * FROM activities WHERE profile_id = ? AND id = ?")
      .get(profileId, activityId) as Activity;

    expect(getActiveCaloriesForActivities(profileId, [activity])).toEqual(
      new Map([[activityId, 0]])
    );
  });
});
