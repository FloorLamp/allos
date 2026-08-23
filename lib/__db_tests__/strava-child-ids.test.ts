// DB INTEGRATION TIER — #3194: int64 child ids, and the two writes that used to
// throw on them.
//
// `activity_segment_efforts` and `activity_laps` both carry
// `UNIQUE(profile_id, source, external_id)`, which spans EVERY activity. So a
// duplicate inside one incoming group, and an id that has moved between
// activities, are both `UNIQUE constraint failed` — the exact SQLite string that
// killed the owner's ride-detail backfill at 48 of 208 and then sat on the
// settings card for a fortnight.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  replaceActivityLaps,
  replaceSegmentEfforts,
  type NormActivityLap,
  type NormSegmentEffort,
} from "@/lib/integrations/activity-telemetry";
import { mapStravaActivityArtifacts } from "@/lib/integrations/strava";
import { parseJsonPreservingIds } from "@/lib/integrations/json-big-ids";

const SOURCE = "strava";

// Real-magnitude Strava effort ids (~3.5×10^18). A and B are 100 apart, inside the
// 512 spacing of doubles up there, so an ordinary JSON.parse collapses them onto
// ONE value — the collision this file is about. Small ids cannot exhibit it.
const EFFORT_A = "3502836819860123456";
const EFFORT_B = "3502836819860123556";

let profileId: number;
let rideOne: number;
let rideTwo: number;

function insertActivity(externalId: string, date: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, source, external_id)
         VALUES (?, ?, 'cardio', 'Ride', ?, ?)`
      )
      .run(profileId, date, SOURCE, externalId).lastInsertRowid
  );
}

function effort(
  parent: string,
  externalId: string,
  over: Partial<NormSegmentEffort> = {}
): NormSegmentEffort {
  return {
    external_id: parent,
    effort_external_id: externalId,
    segment_id: "7654321",
    name: "Climb",
    distance_m: 1200,
    moving_time_sec: 240,
    elapsed_time_sec: 250,
    start_index: 0,
    end_index: 100,
    average_cadence: 80,
    average_watts: 280,
    average_heartrate: 150,
    max_heartrate: 165,
    pr_rank: null,
    kom_rank: null,
    ...over,
  };
}

function lap(
  parent: string,
  externalId: string,
  over: Partial<NormActivityLap> = {}
): NormActivityLap {
  return {
    external_id: parent,
    lap_external_id: externalId,
    lap_index: 1,
    name: "Lap 1",
    distance_m: 5000,
    moving_time_sec: 600,
    elapsed_time_sec: 610,
    start_index: 0,
    end_index: 500,
    elevation_gain_m: 20,
    average_speed_mps: 8,
    max_speed_mps: 12,
    average_cadence: 85,
    average_watts: 220,
    average_heartrate: 148,
    max_heartrate: 160,
    ...over,
  };
}

function storedEffortIds(activityId: number): string[] {
  return (
    db
      .prepare(
        `SELECT external_id FROM activity_segment_efforts
          WHERE profile_id = ? AND activity_id = ? AND source = ?
          ORDER BY external_id`
      )
      .all(profileId, activityId, SOURCE) as { external_id: string }[]
  ).map((r) => r.external_id);
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('STRAVA-CHILD-IDS')").run()
      .lastInsertRowid
  );
  rideOne = insertActivity("strava:15308821234", "2026-08-03");
  rideTwo = insertActivity("strava:15308829999", "2026-08-04");
});

describe("int64 child ids survive the whole path (#3194)", () => {
  it("a detail payload with an effort id past 2^53 stores the exact digit string", () => {
    const detail = parseJsonPreservingIds(
      `{"segment_efforts":[{"id":${EFFORT_A},"name":"Climb","segment":{"id":7654321}}],` +
        `"laps":[{"id":1810452937100055123,"lap_index":1,"name":"Lap 1"}]}`
    );
    const artifacts = mapStravaActivityArtifacts(
      "15308821234",
      detail,
      null,
      null,
      null,
      "2026-08-23T12:00:00.000Z"
    );
    replaceSegmentEfforts(profileId, artifacts.segmentEfforts, SOURCE, [
      "strava:15308821234",
    ]);
    replaceActivityLaps(profileId, artifacts.laps, SOURCE, [
      "strava:15308821234",
    ]);
    expect(storedEffortIds(rideOne)).toEqual([EFFORT_A]);
    expect(
      db
        .prepare(
          `SELECT external_id FROM activity_laps
            WHERE profile_id = ? AND activity_id = ? AND source = ?`
        )
        .get(profileId, rideOne, SOURCE)
    ).toEqual({ external_id: "1810452937100055123" });
  });

  it("a re-sync of an activity stored with MANGLED ids ends with one row per faithful id", () => {
    // What the pre-fix parse stored: both distinct ids rounded onto one double.
    const mangled = String(Number(EFFORT_A));
    expect(mangled).toBe(String(Number(EFFORT_B)));
    replaceSegmentEfforts(
      profileId,
      [effort("strava:15308829999", mangled)],
      SOURCE,
      ["strava:15308829999"]
    );
    expect(storedEffortIds(rideTwo)).toEqual([mangled]);

    // The re-sync brings both faithful ids; the mangled row is absent from the
    // incoming group and is deleted as such. No migration, exactly as #3194 says.
    replaceSegmentEfforts(
      profileId,
      [
        effort("strava:15308829999", EFFORT_A),
        effort("strava:15308829999", EFFORT_B, { name: "Climb again" }),
      ],
      SOURCE,
      ["strava:15308829999"]
    );
    expect(storedEffortIds(rideTwo)).toEqual([EFFORT_A, EFFORT_B]);
  });
});

describe("the two writes that used to throw", () => {
  it("a duplicate effort id INSIDE one incoming group collapses instead of crashing", () => {
    const ride = insertActivity("strava:15308820001", "2026-08-05");
    expect(() =>
      replaceSegmentEfforts(
        profileId,
        [
          effort("strava:15308820001", EFFORT_A, { name: "First" }),
          effort("strava:15308820001", EFFORT_A, { name: "Last" }),
        ],
        SOURCE,
        ["strava:15308820001"]
      )
    ).not.toThrow();
    expect(storedEffortIds(ride)).toEqual([EFFORT_A]);
    // Last wins.
    expect(
      db
        .prepare(
          "SELECT name FROM activity_segment_efforts WHERE profile_id = ? AND activity_id = ?"
        )
        .get(profileId, ride)
    ).toEqual({ name: "Last" });
  });

  it("a duplicate LAP id inside one group collapses too", () => {
    const ride = insertActivity("strava:15308820002", "2026-08-06");
    expect(() =>
      replaceActivityLaps(
        profileId,
        [
          lap("strava:15308820002", "1810452937100055123", { name: "First" }),
          lap("strava:15308820002", "1810452937100055123", { name: "Last" }),
        ],
        SOURCE,
        ["strava:15308820002"]
      )
    ).not.toThrow();
    expect(
      db
        .prepare(
          "SELECT external_id, name FROM activity_laps WHERE profile_id = ? AND activity_id = ?"
        )
        .all(profileId, ride)
    ).toEqual([{ external_id: "1810452937100055123", name: "Last" }]);
  });

  it("an effort id that has moved to another activity RE-PARENTS instead of crashing", () => {
    const from = insertActivity("strava:15308820003", "2026-08-07");
    const to = insertActivity("strava:15308820004", "2026-08-08");
    const movingId = "3502836819870000111";
    replaceSegmentEfforts(
      profileId,
      [effort("strava:15308820003", movingId, { name: "Was here" })],
      SOURCE,
      ["strava:15308820003"]
    );
    expect(storedEffortIds(from)).toEqual([movingId]);

    expect(() =>
      replaceSegmentEfforts(
        profileId,
        [effort("strava:15308820004", movingId, { name: "Now here" })],
        SOURCE,
        ["strava:15308820004"]
      )
    ).not.toThrow();
    // One row, on the new parent, carrying the new payload — not two, not a throw.
    expect(storedEffortIds(from)).toEqual([]);
    expect(storedEffortIds(to)).toEqual([movingId]);
    expect(
      db
        .prepare(
          "SELECT name FROM activity_segment_efforts WHERE profile_id = ? AND external_id = ?"
        )
        .all(profileId, movingId)
    ).toEqual([{ name: "Now here" }]);
  });

  it("a lap id that has moved to another activity re-parents too", () => {
    const from = insertActivity("strava:15308820005", "2026-08-09");
    const to = insertActivity("strava:15308820006", "2026-08-10");
    const movingId = "1810452937100066222";
    replaceActivityLaps(
      profileId,
      [lap("strava:15308820005", movingId)],
      SOURCE,
      ["strava:15308820005"]
    );
    expect(() =>
      replaceActivityLaps(
        profileId,
        [lap("strava:15308820006", movingId, { name: "Moved" })],
        SOURCE,
        ["strava:15308820006"]
      )
    ).not.toThrow();
    expect(
      db
        .prepare(
          "SELECT activity_id, name FROM activity_laps WHERE profile_id = ? AND external_id = ?"
        )
        .all(profileId, movingId)
    ).toEqual([{ activity_id: to, name: "Moved" }]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM activity_laps WHERE profile_id = ? AND activity_id = ?"
        )
        .get(profileId, from)
    ).toEqual({ n: 0 });
  });
});
