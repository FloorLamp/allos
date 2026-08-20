// DB INTEGRATION TIER — the keeper-wins-per-source rule for a merged ride's RECORDED
// children: activity_laps and activity_segment_efforts (issue #3193).
//
// The bug this pins: someone who records every ride on two apps gets two activities
// for one ride, and merging them used to move ALL of the dropped row's laps and
// efforts onto the keeper. Both sets describe the SAME physical traversals, so the
// keeper ended up carrying every lap and every segment effort TWICE, with
// contradictory pr_ranks — the twin uploads shadowed each other on the source's own
// leaderboard, so one says "PR" and the other says "second best" about one ride.
//
// This file drives the real writeActivityFold (the core all four merge entry points
// share — the undoable Training Log merge, mergeActivityPair, mergeActivityCluster,
// and the unattended auto-merge) rather than any one caller, because the rule lives in
// the shared core and a test of one caller proves nothing about the other three. Every
// acceptance criterion here is a row-level fact, which is what this tier asserts
// sharply and a rendered page can only hint at.
//
// It also covers the CLEANUP claim for already-corrupted rows, because that claim is
// about Strava plumbing and deserved a demonstration rather than an assertion.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  replaceActivityLaps,
  replaceSegmentEfforts,
  type NormActivityLap,
  type NormSegmentEffort,
} from "@/lib/integrations/activity-telemetry";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import {
  writeActivityFold,
  snapshotKeeperFold,
  dropSetIds,
} from "@/lib/merge-activity";

const DATE = "2026-08-19";

let profileId: number;
beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('RIDE CHILDREN')").run()
      .lastInsertRowid
  );
});

function insertRide(externalId: string, title = "Evening ride"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, source, external_id, duration_min,
            distance_km, start_time, end_time)
         VALUES (?, ?, 'cardio', ?, 'strava', ?, 62, 24, '17:10', '18:12')`
      )
      .run(profileId, DATE, title, externalId).lastInsertRowid
  );
}

// One lap of a ride, as the normalizer hands it over. `parentExternalId` is the
// ACTIVITY's external id; `lapExternalId` is the lap's own.
function lap(
  parentExternalId: string,
  lapExternalId: string,
  lapIndex: number,
  movingTimeSec: number
): NormActivityLap {
  return {
    external_id: parentExternalId,
    lap_external_id: lapExternalId,
    lap_index: lapIndex,
    name: `Lap ${lapIndex}`,
    distance_m: 8000,
    moving_time_sec: movingTimeSec,
    elapsed_time_sec: movingTimeSec + 4,
    start_index: lapIndex * 100,
    end_index: lapIndex * 100 + 99,
    elevation_gain_m: 40,
    average_speed_mps: 7.1,
    max_speed_mps: 12.4,
    average_cadence: 84,
    average_watts: 190,
    average_heartrate: 146,
    max_heartrate: 168,
  };
}

// One segment effort. `prRank` is the field the twin uploads contradict each other on.
function effort(
  parentExternalId: string,
  effortExternalId: string,
  segmentId: string,
  movingTimeSec: number,
  prRank: number | null
): NormSegmentEffort {
  return {
    external_id: parentExternalId,
    effort_external_id: effortExternalId,
    segment_id: segmentId,
    name: "Long hill drag",
    distance_m: 1200,
    moving_time_sec: movingTimeSec,
    elapsed_time_sec: movingTimeSec,
    start_index: 300,
    end_index: 640,
    average_cadence: 86,
    average_watts: 244,
    average_heartrate: 162,
    max_heartrate: 176,
    pr_rank: prRank,
    kom_rank: null,
  };
}

// The laps/efforts currently parented to one activity, as (source, own external id)
// pairs — the shape every assertion below is written against, because "which rows
// does the keeper carry" is the whole question.
function lapsOn(activityId: number): string[] {
  return (
    db
      .prepare(
        `SELECT source, external_id FROM activity_laps
          WHERE profile_id = ? AND activity_id = ? ORDER BY source, external_id`
      )
      .all(profileId, activityId) as { source: string; external_id: string }[]
  ).map((row) => `${row.source}/${row.external_id}`);
}

function effortsOn(activityId: number): string[] {
  return (
    db
      .prepare(
        `SELECT source, external_id FROM activity_segment_efforts
          WHERE profile_id = ? AND activity_id = ? ORDER BY source, external_id`
      )
      .all(profileId, activityId) as { source: string; external_id: string }[]
  ).map((row) => `${row.source}/${row.external_id}`);
}

function activityRow(id: number): Record<string, unknown> {
  return db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

// Seed the twin uploads of ONE ride: two activities, each carrying its own upload's
// laps and segment efforts for the SAME two traversals, disagreeing by a second of
// moving time and on pr_rank exactly as the real twins do.
function seedTwinUploads(): { keepId: number; dropId: number } {
  const keepId = insertRide("strava:keeper-upload");
  const dropId = insertRide("strava:twin-upload");
  replaceActivityLaps(
    profileId,
    [
      lap("strava:keeper-upload", "lap-keep-1", 1, 900),
      lap("strava:keeper-upload", "lap-keep-2", 2, 880),
    ],
    "strava"
  );
  replaceActivityLaps(
    profileId,
    [
      lap("strava:twin-upload", "lap-twin-1", 1, 901),
      lap("strava:twin-upload", "lap-twin-2", 2, 881),
    ],
    "strava"
  );
  replaceSegmentEfforts(
    profileId,
    [
      effort("strava:keeper-upload", "eff-keep-1", "seg-hill", 396, 1),
      effort("strava:keeper-upload", "eff-keep-2", "seg-sprint", 62, null),
    ],
    "strava"
  );
  replaceSegmentEfforts(
    profileId,
    [
      // The twin's own view of the same two traversals: a second slower, and it
      // believes it was only the second-best effort because the keeper's upload was
      // already sitting on the leaderboard ahead of it.
      effort("strava:twin-upload", "eff-twin-1", "seg-hill", 397, 2),
      effort("strava:twin-upload", "eff-twin-2", "seg-sprint", 63, null),
    ],
    "strava"
  );
  return { keepId, dropId };
}

describe("merging twin uploads of one ride (#3193)", () => {
  it("keeps the keeper's own laps and efforts and DISCARDS the drop's same-source rows", () => {
    const { keepId, dropId } = seedTwinUploads();

    const moves = writeActivityFold(profileId, keepId, activityRow(keepId), [
      activityRow(dropId),
    ]);

    // The fact the bug produced was a UNION: four laps and four efforts on the
    // keeper, every traversal twice. The keeper now carries exactly its own set.
    expect(lapsOn(keepId)).toEqual(["strava/lap-keep-1", "strava/lap-keep-2"]);
    expect(effortsOn(keepId)).toEqual([
      "strava/eff-keep-1",
      "strava/eff-keep-2",
    ]);
    // One row per traversal, and the surviving pr_rank is the keeper's — no
    // contradictory medal beside it.
    expect(
      db
        .prepare(
          `SELECT pr_rank FROM activity_segment_efforts
            WHERE profile_id = ? AND activity_id = ? AND segment_id = 'seg-hill'`
        )
        .all(profileId, keepId)
    ).toEqual([{ pr_rank: 1 }]);

    // Nothing moved, so the returned move says nothing moved — this is what makes
    // the undo contract fall out for free.
    expect(moves[0].movedLapIds).toEqual([]);
    expect(moves[0].movedSegmentEffortIds).toEqual([]);
    // The discarded rows are still on the drop, where the caller's delete captures
    // them as ordinary children (undoable path) or the FK cascade takes them.
    expect(lapsOn(dropId)).toEqual(["strava/lap-twin-1", "strava/lap-twin-2"]);
    expect(effortsOn(dropId)).toEqual([
      "strava/eff-twin-1",
      "strava/eff-twin-2",
    ]);
  });

  it("undo restores the discarded rows onto the restored activity", () => {
    const { keepId, dropId } = seedTwinUploads();
    const keep = activityRow(keepId);
    const keeperBefore = snapshotKeeperFold(keep);
    const movedSetIds = dropSetIds(dropId);

    const moves = writeActivityFold(profileId, keepId, keep, [
      activityRow(dropId),
    ]);
    const undoId = captureDelete("activity", profileId, dropId, {
      keeperId: keepId,
      domain: "activity",
      signature: `id:${keepId}|id:${dropId}`,
      keeperBefore,
      movedSetIds,
      movedRouteId: moves[0].movedRouteId,
      movedTelemetryIds: moves[0].movedTelemetryIds,
      movedLapIds: moves[0].movedLapIds,
      movedSegmentEffortIds: moves[0].movedSegmentEffortIds,
    })!;
    // The drop is gone and its rows went with it into the capture.
    expect(
      db
        .prepare("SELECT COUNT(*) c FROM activities WHERE id = ?")
        .get(dropId) as { c: number }
    ).toEqual({ c: 0 });

    restoreDeletedRow(profileId, undoId);

    const restoredId = (
      db
        .prepare(
          `SELECT id FROM activities
            WHERE profile_id = ? AND external_id = 'strava:twin-upload'`
        )
        .get(profileId) as { id: number }
    ).id;
    // Every row is back where it started: the keeper untouched, the drop whole.
    expect(lapsOn(restoredId)).toEqual([
      "strava/lap-twin-1",
      "strava/lap-twin-2",
    ]);
    expect(effortsOn(restoredId)).toEqual([
      "strava/eff-twin-1",
      "strava/eff-twin-2",
    ]);
    expect(lapsOn(keepId)).toEqual(["strava/lap-keep-1", "strava/lap-keep-2"]);
    expect(effortsOn(keepId)).toEqual([
      "strava/eff-keep-1",
      "strava/eff-keep-2",
    ]);
  });

  it("still moves a source the keeper LACKS — the gap-fill case survives", () => {
    const keepId = insertRide("strava:only-keeper");
    const dropId = insertRide("strava:watch-upload");
    // The keeper has strava laps but NO segment efforts at all; the drop carries a
    // second recording of the ride from a different app.
    replaceActivityLaps(
      profileId,
      [lap("strava:only-keeper", "lap-keep-1", 1, 900)],
      "strava"
    );
    replaceActivityLaps(
      profileId,
      [lap("strava:watch-upload", "lap-hc-1", 1, 902)],
      "health-connect"
    );
    replaceSegmentEfforts(
      profileId,
      [effort("strava:watch-upload", "eff-hc-1", "seg-hill", 398, 3)],
      "health-connect"
    );

    const moves = writeActivityFold(profileId, keepId, activityRow(keepId), [
      activityRow(dropId),
    ]);

    // Per TABLE and per SOURCE: the keeper has strava laps, so nothing about laps
    // from a source it lacks is blocked, and its empty efforts table blocks nothing.
    expect(lapsOn(keepId)).toEqual([
      "health-connect/lap-hc-1",
      "strava/lap-keep-1",
    ]);
    expect(effortsOn(keepId)).toEqual(["health-connect/eff-hc-1"]);
    expect(moves[0].movedLapIds).toHaveLength(1);
    expect(moves[0].movedSegmentEffortIds).toHaveLength(1);
    expect(lapsOn(dropId)).toEqual([]);
  });

  it("keeps a same-source set WHOLE rather than moving its tail", () => {
    // The guard is per SOURCE, and a source is MANY rows here (unlike telemetry,
    // which is one row per source). If it were ever rewritten to mark a source as
    // taken while moving, the first row of a set would be discarded and the rest
    // would follow onto the keeper — a half-doubled ride, which is worse than the
    // bug because it looks plausible. This pins all-or-nothing.
    const keepId = insertRide("strava:whole-keeper");
    const dropId = insertRide("strava:whole-twin");
    replaceActivityLaps(
      profileId,
      [lap("strava:whole-keeper", "lap-keep-1", 1, 900)],
      "strava"
    );
    replaceActivityLaps(
      profileId,
      [
        lap("strava:whole-twin", "lap-twin-1", 1, 901),
        lap("strava:whole-twin", "lap-twin-2", 2, 881),
        lap("strava:whole-twin", "lap-twin-3", 3, 875),
      ],
      "strava"
    );

    writeActivityFold(profileId, keepId, activityRow(keepId), [
      activityRow(dropId),
    ]);

    expect(lapsOn(keepId)).toEqual(["strava/lap-keep-1"]);
    expect(lapsOn(dropId)).toHaveLength(3);
  });

  it("N-way: the first drop with a source wins it, later drops are discarded", () => {
    const keepId = insertRide("strava:nway-keeper");
    const d1 = insertRide("strava:nway-twin-a");
    const d2 = insertRide("strava:nway-twin-b");
    // The keeper has NO efforts, so the first drop's set fills the gap — and the
    // second drop's set must then be discarded, or the gap-fill re-creates the very
    // doubling this rule exists to prevent.
    replaceSegmentEfforts(
      profileId,
      [effort("strava:nway-twin-a", "eff-a-1", "seg-hill", 396, 1)],
      "strava"
    );
    replaceSegmentEfforts(
      profileId,
      [effort("strava:nway-twin-b", "eff-b-1", "seg-hill", 397, 2)],
      "strava"
    );

    const moves = writeActivityFold(profileId, keepId, activityRow(keepId), [
      activityRow(d1),
      activityRow(d2),
    ]);

    expect(effortsOn(keepId)).toHaveLength(1);
    const movedTotal = moves.flatMap((m) => m.movedSegmentEffortIds);
    expect(movedTotal).toHaveLength(1);
    // Whichever drop the deterministic fold order picked, the OTHER one kept its row.
    const byDrop = new Map(
      moves.map((m) => [m.dropId, m.movedSegmentEffortIds.length])
    );
    expect([byDrop.get(d1), byDrop.get(d2)].sort()).toEqual([0, 1]);
    expect(effortsOn(d1).length + effortsOn(d2).length).toBe(1);
  });

  it("leaves the exercise_sets union alone — typed-in history still merges (#199)", () => {
    // The #199 reasoning is CORRECT for typed-in sets: two members' sets are two real
    // pieces of history and the union is lossless. Scoping the recorded children down
    // must not touch it, so this rides alongside the rule that changed.
    const { keepId, dropId } = seedTwinUploads();
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 60, 5)`
    ).run(keepId);
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Front Squat', 1, 50, 5)`
    ).run(dropId);

    writeActivityFold(profileId, keepId, activityRow(keepId), [
      activityRow(dropId),
    ]);

    expect(
      (
        db
          .prepare(
            `SELECT exercise FROM exercise_sets
              WHERE activity_id = ? ORDER BY exercise`
          )
          .all(keepId) as { exercise: string }[]
      ).map((row) => row.exercise)
    ).toEqual(["Back Squat", "Front Squat"]);
  });
});

describe("healing rows an already-shipped merge doubled (#3193)", () => {
  it("a detail re-fetch deletes the twin's rows once only one parent remains", () => {
    // The state a merge on the OLD code left behind: one activity carrying both
    // uploads' laps and efforts. This is what the three activities in the 2026-08-19
    // snapshot look like.
    const keepId = insertRide("strava:corrupted");
    replaceActivityLaps(
      profileId,
      [
        lap("strava:corrupted", "lap-keep-1", 1, 900),
        lap("strava:corrupted", "lap-twin-1", 1, 901),
      ],
      "strava"
    );
    replaceSegmentEfforts(
      profileId,
      [
        effort("strava:corrupted", "eff-keep-1", "seg-hill", 396, 1),
        effort("strava:corrupted", "eff-twin-1", "seg-hill", 397, 2),
      ],
      "strava"
    );
    expect(lapsOn(keepId)).toHaveLength(2);
    expect(effortsOn(keepId)).toHaveLength(2);

    // Re-fetching the surviving activity's detail hands the writer the SOURCE's
    // truth: one lap, one effort, one pr_rank. Rows absent from the incoming set are
    // deleted, which is exactly the doubling — no guess about which twin to keep,
    // because the source is asked.
    replaceActivityLaps(
      profileId,
      [lap("strava:corrupted", "lap-keep-1", 1, 900)],
      "strava",
      ["strava:corrupted"]
    );
    replaceSegmentEfforts(
      profileId,
      [effort("strava:corrupted", "eff-keep-1", "seg-hill", 396, 1)],
      "strava",
      ["strava:corrupted"]
    );

    expect(lapsOn(keepId)).toEqual(["strava/lap-keep-1"]);
    expect(effortsOn(keepId)).toEqual(["strava/eff-keep-1"]);
    expect(
      db
        .prepare(
          `SELECT pr_rank FROM activity_segment_efforts
            WHERE profile_id = ? AND activity_id = ?`
        )
        .all(profileId, keepId)
    ).toEqual([{ pr_rank: 1 }]);
  });
});
