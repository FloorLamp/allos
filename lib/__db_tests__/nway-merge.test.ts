// DB INTEGRATION TIER — N-way activity merge core + high-confidence auto-merge (#1081).
//
// The pure suite covers the clustering / keeper / auto-decision math
// (import-review-cluster.test.ts). This file opens a real SQLite handle and drives:
//   - the generalized writeActivityFold folding N drops into one keeper and moving
//     EVERY drop's exercise_sets (the #199 row-side-state rule across N children);
//   - autoMergeActivityDuplicates collapsing a high-confidence overlapping cluster
//     through the shared core (tombstones + merged decisions), and a re-sync
//     resurrecting nothing;
//   - autoMerge LEAVING a materially-conflicting cluster for manual Review.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { writeActivityFold } from "@/lib/merge-activity";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import {
  upsertActivities,
  type NormActivity,
} from "@/lib/integrations/normalize";
import { getActivityDuplicateClusters, getPairDecisions } from "@/lib/queries";
import { ACTIVITY_DOMAIN } from "@/lib/import-review/detect";

const DATE = "2026-04-12";
const count = (sql: string, ...a: unknown[]) =>
  (db.prepare(sql).get(...a) as { c: number }).c;

let profileId: number;
beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('NWAY')").run()
      .lastInsertRowid
  );
});

interface Over {
  title?: string;
  source?: string | null;
  external_id?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  start_time?: string;
  end_time?: string;
  avg_hr?: number | null;
  max_hr?: number | null;
  notes?: string | null;
  edited?: number;
}
function insertActivity(o: Over): number {
  const r = {
    title: "Run",
    source: null,
    external_id: null,
    duration_min: 30,
    distance_km: 5,
    start_time: "08:00",
    end_time: "08:30",
    avg_hr: null,
    max_hr: null,
    notes: null,
    edited: 0,
    ...o,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, source, external_id, duration_min,
            distance_km, start_time, end_time, avg_hr, max_hr, notes, edited)
         VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        DATE,
        r.title,
        r.source,
        r.external_id,
        r.duration_min,
        r.distance_km,
        r.start_time,
        r.end_time,
        r.avg_hr,
        r.max_hr,
        r.notes,
        r.edited
      ).lastInsertRowid
  );
}
function insertSet(activityId: number, exercise: string): void {
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, 40, 5)`
  ).run(activityId, exercise);
}

describe("writeActivityFold — N-way core (#1081/#199)", () => {
  it("folds three drops into the keeper and moves EVERY drop's sets", () => {
    const keepId = insertActivity({ title: "keeper", notes: "own" });
    insertSet(keepId, "Bench");
    const d1 = insertActivity({ title: "d1", distance_km: null, avg_hr: 150 });
    insertSet(d1, "Squat");
    const d2 = insertActivity({ title: "d2", notes: "from d2", max_hr: 180 });
    insertSet(d2, "Deadlift");
    const d3 = insertActivity({ title: "d3" });
    insertSet(d3, "Row");

    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keepId) as Record<string, unknown>;
    const drops = [d1, d2, d3].map(
      (id) =>
        db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
          string,
          unknown
        >
    );
    const moves = writeActivityFold(profileId, keepId, keep, drops);
    expect(moves).toHaveLength(3);

    // All four rows' sets are now on the keeper (#199 across N children).
    expect(
      count(
        "SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?",
        keepId
      )
    ).toBe(4);
    // Gap-fill: keeper had notes ("own") → keeper wins; avg_hr was null → filled from d1.
    const merged = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keepId) as Record<string, unknown>;
    expect(merged.notes).toBe("own");
    expect(merged.avg_hr).toBe(150);
    expect(merged.max_hr).toBe(180);
    expect(merged.edited).toBe(1);
  });

  it("lands a per-field member choice regardless of fold order (#1431)", () => {
    // Keeper carries a real distance; the CHOSEN drop sorts LAST in the fold
    // order (token order: ext: before id:, and the keeper's own value would win
    // anyway) — so only the override can make its value land.
    const keepId = insertActivity({ title: "keeper", distance_km: 5 });
    const d1 = insertActivity({
      title: "d1",
      source: "strava",
      external_id: "strava:o1",
      distance_km: 8,
      avg_hr: 150,
    });
    const d2 = insertActivity({ title: "d2", distance_km: 12 });

    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keepId) as Record<string, unknown>;
    const drops = [d1, d2].map(
      (id) =>
        db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
          string,
          unknown
        >
    );
    writeActivityFold(profileId, keepId, keep, drops, { distance_km: d2 });

    const merged = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keepId) as Record<string, unknown>;
    expect(merged.distance_km).toBe(12); // the chosen member's value
    expect(merged.avg_hr).toBe(150); // un-chosen fields still gap-fill
    expect(merged.edited).toBe(1);
  });
});

describe("autoMergeActivityDuplicates (#1081)", () => {
  it("collapses a high-confidence overlapping cross-source cluster; a re-sync resurrects nothing", () => {
    // Manual + Strava + Health Connect, all overlapping, same distance/duration.
    const manual = insertActivity({ title: "Morning run" });
    insertSet(manual, "warmup");
    const strava = insertActivity({
      title: "Run",
      source: "strava",
      external_id: "strava:1",
      start_time: "08:01",
      end_time: "08:31",
      avg_hr: 150,
      max_hr: 175, // richest → keeper
    });
    insertSet(strava, "strava-set");
    const hc = insertActivity({
      title: "Run",
      source: "health-connect",
      external_id: "hc:1",
      start_time: "08:02",
      end_time: "08:32",
      avg_hr: 148,
    });
    insertSet(hc, "hc-set");

    const dropped = autoMergeActivityDuplicates(profileId);
    expect(dropped).toBe(2);

    // One activity survives — the sourced+richest Strava keeper.
    expect(
      count("SELECT COUNT(*) c FROM activities WHERE profile_id = ?", profileId)
    ).toBe(1);
    const survivor = db
      .prepare("SELECT * FROM activities WHERE profile_id = ?")
      .get(profileId) as Record<string, unknown>;
    expect(survivor.external_id).toBe("strava:1");
    // All three sets rode onto the keeper.
    expect(
      count(
        "SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?",
        survivor.id
      )
    ).toBe(3);
    // The dropped Health Connect row is tombstoned (the manual row needs none).
    expect(
      count(
        "SELECT COUNT(*) c FROM import_tombstones WHERE profile_id = ? AND target_table = 'activities' AND natural_key = 'hc:1'",
        profileId
      )
    ).toBe(1);
    // A merged decision was recorded for each constituent pair.
    const decisions = [
      ...getPairDecisions(profileId, ACTIVITY_DOMAIN).values(),
    ];
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    expect(decisions.every((d) => d === "merged")).toBe(true);
    // No cluster remains in Review.
    expect(getActivityDuplicateClusters(profileId)).toHaveLength(0);

    // A rolling-window resync of the dropped HC row must NOT resurrect it (tombstone),
    // and the Strava keeper is edit-locked so it's left alone.
    const hcNorm: NormActivity = {
      external_id: "hc:1",
      date: DATE,
      type: "cardio",
      title: "Run",
      duration_min: 30,
      distance_km: 5,
      start_time: "08:02",
      end_time: "08:32",
    };
    upsertActivities(profileId, [hcNorm], "health-connect");
    expect(
      count("SELECT COUNT(*) c FROM activities WHERE profile_id = ?", profileId)
    ).toBe(1);
  });

  // #2056. The widened loader hands the auto path a cross-midnight cluster it never
  // used to see. It must NOT collapse it unattended: those two rows are a MEDIUM
  // wrong-offset reading, and the auto decision's overlap requirement — measured on
  // each row's own clock — is exactly what keeps a person in the loop.
  it("LEAVES a cross-midnight offset cluster for manual Review", () => {
    const insNight = db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, source, external_id, duration_min,
          distance_km, start_time, end_time)
       VALUES (?, ?, 'cardio', ?, ?, ?, 25, ?, ?, ?)`
    );
    insNight.run(
      profileId,
      "2026-04-20",
      "Night walk",
      "health-connect",
      "hc:night",
      2.1,
      "23:30",
      "23:55"
    );
    insNight.run(
      profileId,
      "2026-04-21",
      "Evening Walk",
      "strava",
      "strava:night",
      2.11,
      "00:30",
      "00:55"
    );

    expect(autoMergeActivityDuplicates(profileId)).toBe(0);
    expect(
      count("SELECT COUNT(*) c FROM activities WHERE profile_id = ?", profileId)
    ).toBe(2);
    // …and it IS in Review, which is the half #2056 fixes.
    const clusters = getActivityDuplicateClusters(profileId);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].confidence).toBe("medium");
    expect(clusters[0].date).toBe("2026-04-20");
  });

  it("LEAVES a materially-conflicting cluster for manual Review", () => {
    insertActivity({ title: "Morning run", distance_km: 5 });
    insertActivity({
      title: "Run",
      source: "strava",
      external_id: "strava:9",
      start_time: "08:01",
      end_time: "08:31",
      distance_km: 9, // material conflict vs 5 → auto bails
    });

    const dropped = autoMergeActivityDuplicates(profileId);
    expect(dropped).toBe(0);
    // Both rows survive and the cluster still surfaces for a human.
    expect(
      count("SELECT COUNT(*) c FROM activities WHERE profile_id = ?", profileId)
    ).toBe(2);
    expect(getActivityDuplicateClusters(profileId)).toHaveLength(1);
  });
});
