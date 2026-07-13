// DB INTEGRATION TIER — the re-import tombstone (issues #507/#508/#509).
//
// The pure suite covers the key math (tombstone-keys.test.ts) and the decision filter
// (import-review.test.ts). This file opens a real (temp) SQLite handle and drives the
// full interleaving the bug cluster is about: a MERGE/DELETE of a source-owned row,
// then a rolling-window resync (the same upsert the sync layer runs), then an undo —
// proving the row does NOT resurrect, the resync counts the suppression honestly, undo
// removes the tombstone without crashing, and a re-formed merged pair resurfaces in
// Review even if the tombstone ever misses.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  upsertActivities,
  upsertBodyMetrics,
  type NormActivity,
} from "@/lib/integrations/normalize";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import {
  writeActivityFold,
  snapshotKeeperFold,
  dropSetIds,
  movedRouteIdForMerge,
} from "@/lib/merge-activity";
import { loadImportTombstones } from "@/lib/integrations/tombstones";
import {
  recordPairDecision,
  getPairDecisions,
  getActivityDuplicates,
} from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  activityToken,
  pairSignature,
} from "@/lib/import-review/detect";
import { recordSyncEvent } from "@/lib/integrations/connections";

const DATE = "2026-03-10";
const count = (sql: string, ...a: unknown[]) =>
  (db.prepare(sql).get(...a) as { c: number }).c;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A cross-source duplicate: a manual "Morning run" + a Strava run on the same day with
// overlapping clock windows (a HIGH-confidence detected pair).
function seedCrossSourcePair(profileId: number, externalId = "strava:1") {
  const manualId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min, distance_km, start_time, end_time)
         VALUES (?, ?, 'cardio', 'Morning run', 30, 5, '07:00', '07:30')`
      )
      .run(profileId, DATE).lastInsertRowid
  );
  const stravaId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min, distance_km, start_time, end_time, source, external_id)
         VALUES (?, ?, 'cardio', 'Afternoon Run', 31, 5.1, '07:05', '07:35', 'strava', ?)`
      )
      .run(profileId, DATE, externalId).lastInsertRowid
  );
  return { manualId, stravaId };
}

// The NormActivity the resync hands upsertActivities for that Strava row.
function stravaNorm(externalId = "strava:1"): NormActivity {
  return {
    external_id: externalId,
    date: DATE,
    type: "cardio",
    title: "Afternoon Run",
    duration_min: 31,
    distance_km: 5.1,
    start_time: "07:05",
    end_time: "07:35",
  };
}

// Reproduce the journal manual-merge (keep the manual row, absorb the Strava row) using
// the SAME primitives the action calls: fold, record decision, capture-delete with the
// merge-undo context (which writes the re-import tombstone).
function mergeAbsorbingStrava(
  profileId: number,
  keepId: number,
  dropId: number
): number {
  const keep = db
    .prepare("SELECT * FROM activities WHERE id = ?")
    .get(keepId) as Record<string, unknown>;
  const drop = db
    .prepare("SELECT * FROM activities WHERE id = ?")
    .get(dropId) as Record<string, unknown>;
  const keeperBefore = snapshotKeeperFold(keep);
  const movedSetIds = dropSetIds(dropId);
  const movedRouteId = movedRouteIdForMerge(keepId, dropId);
  writeActivityFold(profileId, keepId, keep, drop);
  const signature = pairSignature(
    activityToken(keep as { id: number; external_id: string | null }),
    activityToken(drop as { id: number; external_id: string | null })
  );
  recordPairDecision(profileId, ACTIVITY_DOMAIN, signature, "merged");
  return captureDelete("activity", profileId, dropId, {
    keeperId: keepId,
    domain: ACTIVITY_DOMAIN,
    signature,
    keeperBefore,
    movedSetIds,
    movedRouteId,
  })!;
}

let profileId: number;
beforeEach(() => {
  profileId = newProfile("TOMB");
});

describe("merge → resync (no resurrection)", () => {
  it("the absorbed Strava row stays gone and the resync counts it suppressed", () => {
    const { manualId, stravaId } = seedCrossSourcePair(profileId);
    mergeAbsorbingStrava(profileId, manualId, stravaId);

    // Absorbed row deleted; a tombstone on its external_id recorded.
    expect(
      count("SELECT COUNT(*) c FROM activities WHERE id = ?", stravaId)
    ).toBe(0);
    expect(loadImportTombstones(profileId, "activities").has("strava:1")).toBe(
      true
    );

    // The rolling window re-sends the same Strava activity.
    const counts = upsertActivities(profileId, [stravaNorm()], "strava");

    // It is NOT re-inserted, and the suppression is counted (no silent cap).
    expect(counts.suppressed).toBe(1);
    expect(counts.inserted).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND external_id = 'strava:1'",
        profileId
      )
    ).toBe(0);
  });
});

describe("delete → resync (no resurrection)", () => {
  it("a plain delete of a Strava row tombstones it so the resync can't re-insert it", () => {
    const { stravaId } = seedCrossSourcePair(profileId, "strava:2");
    captureDelete("activity", profileId, stravaId);

    const counts = upsertActivities(
      profileId,
      [stravaNorm("strava:2")],
      "strava"
    );
    expect(counts.suppressed).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND external_id = 'strava:2'",
        profileId
      )
    ).toBe(0);
  });

  it("body_metrics: a deleted scale reading is not resurrected by the ON CONFLICT push", () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, 80, 'withings')`
        )
        .run(profileId, DATE).lastInsertRowid
    );
    captureDelete("body-metric", profileId, id);

    const counts = upsertBodyMetrics(
      profileId,
      [{ date: DATE, weight_kg: 80 }],
      "withings"
    );
    expect(counts.suppressed).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) c FROM body_metrics WHERE profile_id = ? AND date = ? AND source = 'withings'",
        profileId,
        DATE
      )
    ).toBe(0);
  });
});

describe("merge → resync → undo (no crash, sane outcome)", () => {
  it("undo restores the absorbed row, removes the tombstone, and resumes ingest", () => {
    const { manualId, stravaId } = seedCrossSourcePair(profileId);
    const undoId = mergeAbsorbingStrava(profileId, manualId, stravaId);

    // A resync in between is suppressed (the #509 collision never forms).
    expect(
      upsertActivities(profileId, [stravaNorm()], "strava").suppressed
    ).toBe(1);

    // Undo the merge — must not throw.
    expect(restoreDeletedRow(profileId, undoId)).toBe(true);

    // The absorbed row is back, the tombstone is gone, and the merged decision cleared.
    expect(
      count(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND external_id = 'strava:1'",
        profileId
      )
    ).toBe(1);
    expect(loadImportTombstones(profileId, "activities").has("strava:1")).toBe(
      false
    );
    expect(getPairDecisions(profileId, ACTIVITY_DOMAIN).size).toBe(0);

    // A subsequent resync now ingests the row normally (it exists → unchanged), not
    // suppressed.
    const after = upsertActivities(profileId, [stravaNorm()], "strava");
    expect(after.suppressed).toBe(0);
    expect(after.inserted).toBe(0);
  });
});

describe("#509 — undo after a resync already re-inserted (no tombstone held)", () => {
  it("adopts the live row instead of throwing on UNIQUE(profile_id, external_id)", () => {
    const { manualId, stravaId } = seedCrossSourcePair(profileId);
    const undoId = mergeAbsorbingStrava(profileId, manualId, stravaId);

    // Simulate a PRE-tombstone delete: drop the tombstone so the resync resurrects the
    // row, exactly the state that used to make undo throw.
    db.prepare(
      "DELETE FROM import_tombstones WHERE profile_id = ? AND target_table = 'activities'"
    ).run(profileId);
    const resync = upsertActivities(profileId, [stravaNorm()], "strava");
    expect(resync.inserted).toBe(1); // resurrected
    expect(
      count(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND external_id = 'strava:1'",
        profileId
      )
    ).toBe(1);

    // Undo must not throw on the occupied natural key; it adopts the live row.
    expect(() => restoreDeletedRow(profileId, undoId)).not.toThrow();
    // Still exactly ONE row for that external_id — no duplicate.
    expect(
      count(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND external_id = 'strava:1'",
        profileId
      )
    ).toBe(1);
    // The holding row was consumed.
    expect(
      count("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?", undoId)
    ).toBe(0);
  });
});

describe("Review-surface visibility (#507 point 3/4)", () => {
  it("a re-formed 'merged' pair resurfaces; kept-both stays suppressed", () => {
    const { manualId, stravaId } = seedCrossSourcePair(profileId);
    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(manualId) as { id: number; external_id: string | null };
    const drop = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(stravaId) as { id: number; external_id: string | null };
    const signature = pairSignature(activityToken(keep), activityToken(drop));

    // Both rows still exist (the sync re-formed the duplicate). A recorded 'merged'
    // decision must NOT hide it — the regression should be visible in Review.
    recordPairDecision(profileId, ACTIVITY_DOMAIN, signature, "merged");
    expect(getActivityDuplicates(profileId)).toHaveLength(1);

    // A 'dismissed' (or kept-both) decision DOES keep suppressing a re-formed pair.
    recordPairDecision(profileId, ACTIVITY_DOMAIN, signature, "dismissed");
    expect(getActivityDuplicates(profileId)).toHaveLength(0);
  });
});

describe("sync-event accounting persists the suppressed count", () => {
  it("recordSyncEvent stores the suppressed column", () => {
    recordSyncEvent(profileId, "strava", {
      ok: true,
      inserted: 0,
      updated: 0,
      unchanged: 3,
      suppressed: 2,
      skipped: 0,
      received: 5,
      written: 3,
    });
    const row = db
      .prepare(
        "SELECT suppressed FROM integration_sync_events WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profileId) as { suppressed: number | null };
    expect(row.suppressed).toBe(2);
  });
});
