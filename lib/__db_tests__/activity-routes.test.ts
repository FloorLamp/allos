// DB INTEGRATION TIER — activity_routes capture, idempotency, scoping, and the
// merge/undo side-state contract (issue #569).

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  upsertActivityRoutes,
  type NormActivityRoute,
} from "@/lib/integrations/normalize";
import { getRoutePolylinesForActivities } from "@/lib/queries";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import {
  writeActivityFold,
  snapshotKeeperFold,
  dropSetIds,
  movedRouteIdForMerge,
} from "@/lib/merge-activity";

// A synthetic public-park loop polyline (canonical Google example vector, remote CA
// wilderness) — never a real home route, per the no-real-PHI fixture rule.
const POLY = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const POLY2 = "_p~iF~ps|U_ulLnnqC";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newActivity(profileId: number, externalId: string | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, source, external_id)
         VALUES (?, '2024-05-01', 'cardio', 'Ride', 'strava', ?)`
      )
      .run(profileId, externalId).lastInsertRowid
  );
}

function route(externalId: string, polyline = POLY): NormActivityRoute {
  return {
    external_id: externalId,
    polyline,
    start_lat: 38.5,
    start_lng: -120.2,
    end_lat: 43.252,
    end_lng: -126.453,
  };
}

let profileId: number;

beforeEach(() => {
  profileId = newProfile(`routes-${Math.random()}`);
});

// Route rows belonging to `profileId` (the whole activity_routes table is shared
// across the per-file temp DB, so scope every count to this profile's activities).
function routeCount(pid: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM activity_routes r
           JOIN activities a ON a.id = r.activity_id WHERE a.profile_id = ?`
      )
      .get(pid) as { n: number }
  ).n;
}

describe("upsertActivityRoutes", () => {
  it("inserts, then re-syncs idempotently, then updates on a changed polyline", () => {
    const actId = newActivity(profileId, "strava:1");

    const c1 = upsertActivityRoutes(profileId, [route("strava:1")], "strava");
    expect(c1.inserted).toBe(1);
    expect(getRoutePolylinesForActivities(profileId, [actId]).get(actId)).toBe(
      POLY
    );

    // Identical re-sync → unchanged, no write.
    const c2 = upsertActivityRoutes(profileId, [route("strava:1")], "strava");
    expect(c2.unchanged).toBe(1);
    expect(c2.inserted).toBe(0);

    // Changed polyline → updated in place (1:1 on activity_id).
    const c3 = upsertActivityRoutes(
      profileId,
      [route("strava:1", POLY2)],
      "strava"
    );
    expect(c3.updated).toBe(1);
    expect(getRoutePolylinesForActivities(profileId, [actId]).get(actId)).toBe(
      POLY2
    );
    // Still exactly one route row for the activity (UNIQUE(activity_id)).
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM activity_routes WHERE activity_id = ?"
      )
      .get(actId) as { n: number };
    expect(n.n).toBe(1);
  });

  it("skips a route whose parent activity doesn't exist for the profile (no orphan)", () => {
    // No activity with this external_id → the resolve SELECT finds nothing.
    const c = upsertActivityRoutes(
      profileId,
      [route("strava:missing")],
      "strava"
    );
    expect(c.inserted).toBe(0);
    expect(routeCount(profileId)).toBe(0);
  });

  it("is profile-scoped — never attaches a route to another profile's activity", () => {
    const other = newProfile("other");
    newActivity(other, "strava:shared"); // same external_id, different profile
    // Acting profile has no such activity → nothing written.
    const c = upsertActivityRoutes(
      profileId,
      [route("strava:shared")],
      "strava"
    );
    expect(c.inserted).toBe(0);
    expect(routeCount(profileId)).toBe(0);
    expect(routeCount(other)).toBe(0);
  });
});

describe("route survives delete + undo (row-ops side-state)", () => {
  it("captures and restores the route with the activity", () => {
    const actId = newActivity(profileId, "strava:del");
    upsertActivityRoutes(profileId, [route("strava:del")], "strava");

    const undoId = captureDelete("activity", profileId, actId)!;
    // Deleted: activity + its route cascade away.
    expect(routeCount(profileId)).toBe(0);

    restoreDeletedRow(profileId, undoId);
    // Restored under a NEW activity id, route re-attached with the same polyline.
    const restored = db
      .prepare("SELECT id FROM activities WHERE profile_id = ?")
      .get(profileId) as { id: number };
    expect(
      getRoutePolylinesForActivities(profileId, [restored.id]).get(restored.id)
    ).toBe(POLY);
  });
});

describe("merge keeper-wins + undo moves the route back (#569)", () => {
  it("moves the drop's route onto a routeless keeper, and undo restores it to the drop", () => {
    const keepId = newActivity(profileId, "strava:keep");
    const dropId = newActivity(profileId, "strava:drop");
    // Only the drop has a route; the keeper has none.
    upsertActivityRoutes(profileId, [route("strava:drop")], "strava");

    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keepId) as Record<string, unknown>;
    const drop = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(dropId) as Record<string, unknown>;

    const keeperBefore = snapshotKeeperFold(keep);
    const movedSetIds = dropSetIds(dropId);
    const movedRouteId = movedRouteIdForMerge(keepId, dropId);
    expect(movedRouteId).not.toBeNull();

    writeActivityFold(profileId, keepId, keep, drop);
    // Keeper-wins: the route is now on the keeper.
    expect(
      getRoutePolylinesForActivities(profileId, [keepId]).get(keepId)
    ).toBe(POLY);

    const undoId = captureDelete("activity", profileId, dropId, {
      keeperId: keepId,
      domain: "activity",
      signature: `id:${keepId}|id:${dropId}`,
      keeperBefore,
      movedSetIds,
      movedRouteId,
    })!;
    restoreDeletedRow(profileId, undoId);

    // Undo moved the route back off the keeper onto the restored drop row.
    expect(
      getRoutePolylinesForActivities(profileId, [keepId]).get(keepId)
    ).toBe(undefined);
    const restoredDrop = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND external_id = 'strava:drop'"
      )
      .get(profileId) as { id: number };
    expect(
      getRoutePolylinesForActivities(profileId, [restoredDrop.id]).get(
        restoredDrop.id
      )
    ).toBe(POLY);
  });

  it("keeper-wins keeps the keeper's own route when both have one (movedRouteId null)", () => {
    const keepId = newActivity(profileId, "strava:k2");
    const dropId = newActivity(profileId, "strava:d2");
    upsertActivityRoutes(
      profileId,
      [route("strava:k2", POLY), route("strava:d2", POLY2)],
      "strava"
    );
    expect(movedRouteIdForMerge(keepId, dropId)).toBeNull();

    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(keepId) as Record<string, unknown>;
    const drop = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(dropId) as Record<string, unknown>;
    writeActivityFold(profileId, keepId, keep, drop);
    // Keeper keeps its OWN route; the drop's stays on the drop (until it's deleted).
    expect(
      getRoutePolylinesForActivities(profileId, [keepId]).get(keepId)
    ).toBe(POLY);
  });
});
