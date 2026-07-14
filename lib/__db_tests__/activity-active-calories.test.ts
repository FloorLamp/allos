// DB INTEGRATION TIER — imported active energy follows the activity's stable
// provider identity, not user-editable date/clock fields.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { upsertMetricSamples } from "@/lib/integrations/normalize";
import { getActiveCaloriesForActivities } from "@/lib/queries/training/activities";
import { up as linkLegacyActivityEnergy } from "@/lib/migrations/versions/035-metric-sample-activity-link";
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
            start_time: "2026-06-01T08:00:00.000Z",
            end_time: "2026-06-01T09:00:00.000Z",
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

  it("backfills a unique legacy Oura workout without using profile timezone", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Legacy Oura")
        .lastInsertRowid
    );
    const externalId = "oura:synthetic-workout-1";
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, start_time, end_time,
              source, external_id)
           VALUES (?, ?, 'cardio', 'Travel run', 60, '08:00', '09:00', 'oura', ?)`
        )
        .run(profileId, "2026-06-01", externalId).lastInsertRowid
    );
    upsertMetricSamples(
      profileId,
      [
        {
          metric: "active_kcal",
          date: "2026-06-01",
          // UTC-normalized sample for an 08:00 workout recorded at -07:00.
          start_time: "2026-06-01T15:00:00.000Z",
          end_time: "2026-06-01T16:00:00.000Z",
          value: 420,
        },
      ],
      "oura"
    );

    linkLegacyActivityEnergy(db);
    db.prepare(
      `UPDATE activities
          SET date = '2026-07-10', start_time = '13:15', end_time = '14:15'
        WHERE profile_id = ? AND id = ?`
    ).run(profileId, activityId);
    const activity = db
      .prepare("SELECT * FROM activities WHERE profile_id = ? AND id = ?")
      .get(profileId, activityId) as Activity;

    expect(getActiveCaloriesForActivities(profileId, [activity])).toEqual(
      new Map([[activityId, 420]])
    );
  });

  it("does not backfill Health Connect energy when only the start matches", () => {
    const profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES (?)")
        .run("Health Connect Window").lastInsertRowid
    );
    const externalId = "health-connect:2026-06-15T07:00:00Z";
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, start_time, end_time,
              source, external_id)
           VALUES (?, '2026-06-15', 'cardio', 'Run', 60, '07:00', '08:00',
                   'health-connect', ?)`
        )
        .run(profileId, externalId).lastInsertRowid
    );
    upsertMetricSamples(
      profileId,
      [
        {
          metric: "active_kcal",
          date: "2026-06-15",
          start_time: "2026-06-15T07:00:00Z",
          end_time: "2026-06-15T07:30:00Z",
          value: 240,
        },
      ],
      "health-connect"
    );

    linkLegacyActivityEnergy(db);
    const activity = db
      .prepare("SELECT * FROM activities WHERE profile_id = ? AND id = ?")
      .get(profileId, activityId) as Activity;
    expect(getActiveCaloriesForActivities(profileId, [activity])).toEqual(
      new Map()
    );
  });
});
