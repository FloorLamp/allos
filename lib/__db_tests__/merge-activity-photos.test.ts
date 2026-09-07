// DB INTEGRATION TIER — a merged session keeps its photos, on every merge path
// (#5481, the data-loss defect in #3285 item 3's neighbourhood).
//
// The bug this pins: `writeActivityFold` hand-enumerates an activity's children and
// moved `activity_videos` but not `training_photos`, whose `activity_id` is ON DELETE
// CASCADE. Merging two sessions therefore destroyed the dropped one's photos — and on
// three of the four callers permanently, because they delete the drop with a bare
// DELETE and no undo capture. The worst of the three is the unattended auto-merge,
// which runs on import with nobody in the loop, so a sync could silently take
// somebody's race photos.
//
// TWO ASSERTIONS PER PATH, not one, because a moved row and a moved FILE are separate
// facts and the cascade broke both differently:
//   1. the photo is ON THE KEEPER afterwards and the profile's photo count is unchanged;
//   2. NO FILE the merge touched is left on disk without a row pointing at it. A
//      cascaded row never runs any delete core, so its content-named bytes stayed under
//      data/uploads/training-photos/<profileId>/ forever — invisible to the #1847 purge
//      and to deleteProfile, which both walk rows. Each case records its photos' paths
//      BEFORE the merge, which is the last moment the association exists to record.
//
// This file drives the REAL entry points: `autoMergeActivityDuplicates` end-to-end for
// the unattended path, and the shared `writeActivityFold` + bare DELETE that both Data
// → Review resolvers perform (the resolvers themselves are auth-gated Server Actions;
// the rule under test lives in the core they share, which is also why the fix does).
//
// SYNTHETIC ONLY: fictional profiles, invented sessions, one-byte "images" written
// through the real store — the ingest pipeline is proved at the action tier.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import type { ProcessedPhoto } from "@/lib/photo/ingest";
import { addTrainingPhotoCore } from "@/lib/training-photo-write";
import { writeActivityFold, snapshotKeeperFold } from "@/lib/merge-activity";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import { captureDelete } from "@/lib/undo-delete-db";

const DATE = "2026-09-07";

let profileId: number;
beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('MERGE PHOTOS')").run()
      .lastInsertRowid
  );
});

interface Over {
  title?: string;
  source?: string | null;
  external_id?: string | null;
  start_time?: string;
  end_time?: string;
  avg_hr?: number | null;
  max_hr?: number | null;
}
function insertActivity(o: Over = {}): number {
  const r = {
    title: "Run",
    source: null,
    external_id: null,
    start_time: "08:00",
    end_time: "08:30",
    avg_hr: null,
    max_hr: null,
    ...o,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, source, external_id, duration_min,
            distance_km, start_time, end_time, avg_hr, max_hr)
         VALUES (?, ?, 'cardio', ?, ?, ?, 30, 5, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        DATE,
        r.title,
        r.source,
        r.external_id,
        r.start_time,
        r.end_time,
        r.avg_hr,
        r.max_hr
      ).lastInsertRowid
  );
}

// A ProcessedPhoto as the ingest hands one over; `seed` varies the content hash, which
// is what the dedup reads and what names the file on disk.
function processed(seed: string): ProcessedPhoto {
  return {
    bytes: Buffer.from(`photo bytes ${seed}`),
    thumbBytes: Buffer.from(`thumb bytes ${seed}`),
    mime: "image/jpeg",
    width: 800,
    height: 600,
    sizeBytes: 20 + seed.length,
    contentHash: `hash-${seed}-5481`.replace(/[^a-z0-9-]/g, ""),
    captureDate: null,
  };
}

// Attach a photo to a session and return its row id, refusing to swallow a failure.
function photographSession(activityId: number, seed: string): number {
  const out = addTrainingPhotoCore(
    profileId,
    { kind: "activity", activityId },
    processed(seed)
  );
  if (out.kind !== "added") throw new Error(`photo not added: ${out.kind}`);
  return out.id;
}

function ownerOf(photoId: number): number | null {
  return (
    (
      db
        .prepare(`SELECT activity_id FROM training_photos WHERE id = ?`)
        .get(photoId) as { activity_id: number | null } | undefined
    )?.activity_id ?? null
  );
}

function photoCount(): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM training_photos WHERE profile_id = ?`)
      .get(profileId) as { c: number }
  ).c;
}

// The absolute files one photo row points at, read WHILE THE ROW STILL EXISTS — the
// only moment the association is recoverable, which is the whole shape of the leak.
function filesOf(photoId: number): string[] {
  const row = db
    .prepare(`SELECT stored_path, thumb_path FROM training_photos WHERE id = ?`)
    .get(photoId) as
    { stored_path: string; thumb_path: string | null } | undefined;
  if (!row) throw new Error(`photo ${photoId} has no row to read paths from`);
  return [row.stored_path, row.thumb_path]
    .filter((p): p is string => p != null)
    .map((p) => path.resolve(process.cwd(), p));
}

// What became of those files after the merge. `orphaned` is the #5481 leak: bytes
// still on disk that no live row claims, so nothing will ever reclaim them — not the
// #1847 purge, not deleteProfile, both of which walk rows. `missing` is its mirror,
// a file deleted out from under a row that still points at it.
//
// Deliberately NOT a scan of the profile's whole directory: `data/uploads` is shared
// by the whole tier and sequential files in one worker thread reuse a fixture profile
// block (fixture-profile-space.ts), so a directory listing can carry an earlier
// FILE's leftovers and would fail this test for somebody else's photos.
function fileState(watched: string[]): {
  orphaned: string[];
  missing: string[];
} {
  const claimed = new Set(
    (
      db
        .prepare(
          `SELECT stored_path, thumb_path FROM training_photos WHERE profile_id = ?`
        )
        .all(profileId) as {
        stored_path: string;
        thumb_path: string | null;
      }[]
    )
      .flatMap((r) => [r.stored_path, r.thumb_path])
      .filter((p): p is string => p != null)
      .map((p) => path.resolve(process.cwd(), p))
  );
  return {
    orphaned: watched.filter((f) => fs.existsSync(f) && !claimed.has(f)),
    missing: watched.filter((f) => !fs.existsSync(f)),
  };
}

function fullRow(id: number): Record<string, unknown> {
  return db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

describe("the unattended auto-merge (#5481 — nobody is in the loop)", () => {
  it("carries a synced session's photos onto the keeper and strands no file", () => {
    // The shape a sync actually produces: the same run from two connected sources,
    // overlapping clocks, no material conflict — the cluster autoMergeCluster
    // collapses without asking anyone.
    const manual = insertActivity({ title: "Morning run" });
    const strava = insertActivity({
      title: "Run",
      source: "strava",
      external_id: "strava:5481",
      start_time: "08:01",
      end_time: "08:31",
      avg_hr: 150,
      max_hr: 175, // richest → the keeper
    });
    const onManual = photographSession(manual, "finish-line");
    const onStrava = photographSession(strava, "medal");
    // Recorded before the merge, because after it the losing row is the thing that no
    // longer exists to tell us which bytes were its.
    const watched = [...filesOf(onManual), ...filesOf(onStrava)];

    expect(autoMergeActivityDuplicates(profileId)).toBe(1);

    const survivors = db
      .prepare("SELECT id FROM activities WHERE profile_id = ?")
      .all(profileId) as { id: number }[];
    expect(survivors).toHaveLength(1);
    const keeper = survivors[0].id;
    expect(keeper).toBe(strava);

    // BOTH facts in ONE assertion, deliberately: `expect` stops at the first failure,
    // and asserting them separately would let the row check mask the file check
    // forever. Before the fix this reports a lost photo AND the bytes it left behind.
    expect({
      photos: photoCount(),
      owners: [ownerOf(onManual), ownerOf(onStrava)],
      ...fileState(watched),
    }).toEqual({
      photos: 2,
      owners: [keeper, keeper],
      orphaned: [],
      missing: [],
    });
  });
});

describe("the Review resolver's permanent merge (#5481 — no undo behind it)", () => {
  it("keeps the dropped session's photos when the bare DELETE cascades", () => {
    const keepId = insertActivity({ title: "keeper" });
    const dropId = insertActivity({ title: "drop", avg_hr: 148 });
    const kept = photographSession(keepId, "keeper-shot");
    const dropped = photographSession(dropId, "dropped-shot");
    const watched = [...filesOf(kept), ...filesOf(dropped)];

    // Exactly what review-actions.ts does at :178 and :230 — the shared fold, then a
    // bare DELETE with no capture. The cascade is live (foreign_keys is ON).
    writeActivityFold(profileId, keepId, fullRow(keepId), [fullRow(dropId)]);
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      dropId,
      profileId
    );

    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(dropId)
    ).toBeUndefined();
    expect({
      photos: photoCount(),
      owners: [ownerOf(kept), ownerOf(dropped)],
      ...fileState(watched),
    }).toEqual({
      photos: 2,
      owners: [keepId, keepId],
      orphaned: [],
      missing: [],
    });
  });
});

describe("the undoable Training Log merge (#5481)", () => {
  it("moves the photo before the capture, so the merged session holds it", () => {
    const keepId = insertActivity({ title: "keeper" });
    const dropId = insertActivity({ title: "drop", max_hr: 170 });
    const dropped = photographSession(dropId, "log-path-shot");
    // On THIS path alone an unmoved photo would be restorable — the capture holds the
    // row and #1290 keeps its file for the restore window — so `orphaned` here means
    // "no LIVE row claims it", which is what leaving the merged session looks like.
    const watched = filesOf(dropped);

    // activity-actions.ts:302's shape: snapshot, fold, then captureDelete instead of a
    // bare DELETE. The photo has already moved by the time the capture runs, exactly as
    // a form-check clip has, so it follows the merged session rather than the deleted
    // row.
    snapshotKeeperFold(fullRow(keepId));
    writeActivityFold(profileId, keepId, fullRow(keepId), [fullRow(dropId)]);
    captureDelete("activity", profileId, dropId);

    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(dropId)
    ).toBeUndefined();
    expect({
      photos: photoCount(),
      owner: ownerOf(dropped),
      ...fileState(watched),
    }).toEqual({ photos: 1, owner: keepId, orphaned: [], missing: [] });
  });
});

describe("the per-profile content-hash dedup (#5481, question 1)", () => {
  it("cannot collide on the move: identical bytes are one row before the merge", () => {
    const keepId = insertActivity({ title: "keeper" });
    const dropId = insertActivity({ title: "drop" });
    const first = photographSession(keepId, "same-bytes");
    const watched = filesOf(first);

    // The write core dedups on (profile_id, content_hash) across the WHOLE table, not
    // per owner — so the second upload of identical bytes onto the other session is
    // refused as a duplicate and never becomes a second row. There is therefore no pair
    // of rows the move could bring into conflict, and `activity_id` is not a column of
    // that unique index anyway, so re-parenting cannot move a row within it.
    const again = addTrainingPhotoCore(
      profileId,
      { kind: "activity", activityId: dropId },
      processed("same-bytes")
    );
    expect(again).toEqual({ kind: "duplicate", id: first });
    expect(photoCount()).toBe(1);

    // A plain UPDATE — not UPDATE OR IGNORE — therefore moves everything, and the merge
    // is clean.
    writeActivityFold(profileId, keepId, fullRow(keepId), [fullRow(dropId)]);
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      dropId,
      profileId
    );
    expect({
      photos: photoCount(),
      owner: ownerOf(first),
      ...fileState(watched),
    }).toEqual({ photos: 1, owner: keepId, orphaned: [], missing: [] });
  });
});
