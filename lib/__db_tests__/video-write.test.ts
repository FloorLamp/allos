// DB INTEGRATION TIER — the video-capture domains over the shared video core
// (#1224 phase 1). Drives the REAL pipeline: synthetic container fixtures
// (lib/video/fixture.ts — no real recording) → ingestVideo (sniff, caps, hash) →
// the domain write cores (dedup, file store, row insert) against the real temp-DB
// schema (migration 098 replayed by setup).
//
// The pins the pure tier can't see live here: the STORED FILE on disk, per-profile
// dedup, the has_location flag persisting, the activity-ownership gate, the
// activity_id ON DELETE CASCADE, and path-contained unlink on delete.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, today } from "@/lib/db";
import { ingestVideo, type IngestedVideo } from "@/lib/video/ingest";
import { videoDomainRoot } from "@/lib/video/store";
import {
  buildMp4Fixture,
  buildM4aFixture,
  buildWebmFixture,
} from "@/lib/video/fixture";
import { MAX_VIDEO_BYTES } from "@/lib/video/policy";
import {
  attachSymptomVideoCore,
  getSymptomVideosInRange,
  deleteSymptomVideoCore,
  updateSymptomVideoCaptionCore,
} from "@/lib/symptom-video-write";
import {
  addActivityVideoCore,
  getActivityVideos,
  getActivityVideosForActivities,
  deleteActivityVideoCore,
} from "@/lib/activity-video-write";
import { captureDelete, sweepDeletedRows } from "@/lib/undo-delete-db";

let profileId: number;
let activityId: number;

function ingested(bytes: Buffer): IngestedVideo {
  const out = ingestVideo(bytes);
  if (out.kind !== "ingested") throw new Error(`unexpected: ${out.kind}`);
  return out.video;
}

beforeAll(() => {
  profileId = Number(
    db.prepare(`INSERT INTO profiles (name) VALUES ('Video Fixture')`).run()
      .lastInsertRowid
  );
  activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, type, title, date) VALUES (?, 'strength', 'Squat day', ?)`
      )
      .run(profileId, today(profileId)).lastInsertRowid
  );
});

afterAll(() => {
  for (const d of ["symptom", "activity"] as const)
    fs.rmSync(path.join(videoDomainRoot(d), String(profileId)), {
      recursive: true,
      force: true,
    });
});

describe("ingestVideo — sniff + caps", () => {
  it("ingests a valid MP4 with server-derived mime/kind/duration + content hash", () => {
    const v = ingested(
      buildMp4Fixture({ durationSec: 10, creationDate: "2026-03-14" })
    );
    expect(v.mime).toBe("video/mp4");
    expect(v.kind).toBe("video");
    expect(v.durationSec).toBe(10);
    expect(v.creationDate).toBe("2026-03-14");
    expect(v.contentHash).toHaveLength(64);
  });

  it("distinguishes an audio-only clip (kind=audio)", () => {
    expect(ingested(buildM4aFixture()).kind).toBe("audio");
    expect(ingested(buildWebmFixture({ trackType: 2 })).kind).toBe("audio");
  });

  it("rejects a non-container, an oversize clip, and an overlong clip", () => {
    expect(ingestVideo(Buffer.from("not a video")).kind).toBe("invalid");
    expect(ingestVideo(Buffer.alloc(0)).kind).toBe("invalid");
    // Oversize: a header that sniffs fine but exceeds the byte cap.
    const big = Buffer.concat([
      buildMp4Fixture({ durationSec: 5 }),
      Buffer.alloc(MAX_VIDEO_BYTES + 1),
    ]);
    expect(ingestVideo(big).kind).toBe("invalid");
    // Overlong: a 75s clip is past the 60s cap.
    expect(ingestVideo(buildMp4Fixture({ durationSec: 75 })).kind).toBe(
      "invalid"
    );
  });
});

describe("attachSymptomVideoCore / read / delete", () => {
  it("stores the clip + poster on disk, persists the location flag, and dedups per-profile", () => {
    const v = ingested(
      buildMp4Fixture({
        durationSec: 8,
        creationDate: "2026-05-01",
        location: true,
      })
    );
    expect(v.hasLocation).toBe(true);
    const poster = Buffer.from("SYNTHETIC-POSTER-BYTES");
    const out = attachSymptomVideoCore(
      profileId,
      { date: "2026-05-01", symptom: "tremor", caption: "  left hand  " },
      v,
      poster
    );
    expect(out.kind).toBe("attached");
    if (out.kind !== "attached") return;

    const stored = db
      .prepare(
        `SELECT stored_path, poster_path, kind, duration_sec, has_location, caption
           FROM symptom_videos WHERE id = ? AND profile_id = ?`
      )
      .get(out.id, profileId) as {
      stored_path: string;
      poster_path: string;
      kind: string;
      duration_sec: number;
      has_location: number;
      caption: string;
    };
    expect(stored.kind).toBe("video");
    expect(stored.duration_sec).toBe(8);
    expect(stored.has_location).toBe(1);
    expect(stored.caption).toBe("left hand");
    expect(stored.stored_path).toContain(
      `symptom-videos${path.sep}${profileId}${path.sep}`
    );
    expect(fs.existsSync(path.resolve(process.cwd(), stored.stored_path))).toBe(
      true
    );
    expect(fs.existsSync(path.resolve(process.cwd(), stored.poster_path))).toBe(
      true
    );

    // Re-uploading the identical clip reuses the existing row.
    const again = attachSymptomVideoCore(
      profileId,
      { date: "2026-05-01", symptom: null, caption: null },
      v,
      poster
    );
    expect(again).toEqual({ kind: "duplicate", id: out.id });
  });

  it("gathers clips in a date window and edits captions, profile-scoped", () => {
    const v = ingested(
      buildMp4Fixture({ durationSec: 3, creationDate: "2026-05-05" })
    );
    const out = attachSymptomVideoCore(
      profileId,
      { date: "2026-05-05", symptom: null, caption: null },
      v,
      null
    );
    expect(out.kind).toBe("attached");
    if (out.kind !== "attached") return;

    const inRange = getSymptomVideosInRange(
      profileId,
      "2026-05-01",
      "2026-05-31"
    );
    expect(inRange.length).toBeGreaterThanOrEqual(2);
    expect(
      getSymptomVideosInRange(profileId, "2026-01-01", "2026-01-31")
    ).toHaveLength(0);

    expect(updateSymptomVideoCaptionCore(profileId, out.id, "swaying")).toBe(
      true
    );
    // Forged cross-profile caption edit is a no-op.
    expect(updateSymptomVideoCaptionCore(profileId + 9999, out.id, "x")).toBe(
      false
    );
  });

  it("delete removes the row AND both files, path-contained + idempotent", () => {
    const v = ingested(
      buildMp4Fixture({ durationSec: 4, creationDate: "2026-06-02" })
    );
    const out = attachSymptomVideoCore(
      profileId,
      { date: "2026-06-02", symptom: null, caption: null },
      v,
      Buffer.from("POSTER-2")
    );
    expect(out.kind).toBe("attached");
    if (out.kind !== "attached") return;
    const row = db
      .prepare(
        `SELECT stored_path, poster_path FROM symptom_videos WHERE id = ? AND profile_id = ?`
      )
      .get(out.id, profileId) as { stored_path: string; poster_path: string };

    // Forged cross-profile delete is a no-op.
    expect(deleteSymptomVideoCore(profileId + 9999, out.id)).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), row.stored_path))).toBe(
      true
    );

    expect(deleteSymptomVideoCore(profileId, out.id)).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), row.stored_path))).toBe(
      false
    );
    expect(fs.existsSync(path.resolve(process.cwd(), row.poster_path))).toBe(
      false
    );
    expect(deleteSymptomVideoCore(profileId, out.id)).toBe(false);
  });
});

describe("addActivityVideoCore — activity ownership + cascade", () => {
  it("attaches to an owned activity and rejects a forged activity id", () => {
    const v = ingested(
      buildMp4Fixture({ durationSec: 6, creationDate: "2026-06-10" })
    );
    const out = addActivityVideoCore(
      profileId,
      { activityId, exercise: "Back Squat", caption: "depth check" },
      v,
      Buffer.from("A-POSTER")
    );
    expect(out.kind).toBe("added");

    // An activity id that isn't this profile's is rejected.
    const forged = addActivityVideoCore(
      profileId,
      { activityId: 999999, exercise: null, caption: null },
      ingested(buildMp4Fixture({ durationSec: 6, creationDate: "2026-06-11" })),
      null
    );
    expect(forged.kind).toBe("invalid");
  });

  it("buckets clips per activity and cascade-deletes with the activity (FK)", () => {
    const rows = getActivityVideos(profileId, activityId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const map = getActivityVideosForActivities(profileId, [activityId, 424242]);
    expect(map.get(activityId)!.length).toBe(rows.length);
    expect(map.has(424242)).toBe(false);

    // A dedicated throwaway activity → clip → DELETE FROM activities cascades the
    // clip row (activity_videos.activity_id ON DELETE CASCADE).
    const tmpAct = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, type, title, date) VALUES (?, 'strength', 'Temp', ?)`
        )
        .run(profileId, today(profileId)).lastInsertRowid
    );
    const clip = addActivityVideoCore(
      profileId,
      { activityId: tmpAct, exercise: null, caption: null },
      ingested(buildMp4Fixture({ durationSec: 2, creationDate: "2026-06-12" })),
      null
    );
    expect(clip.kind).toBe("added");
    db.prepare(`DELETE FROM activities WHERE id = ? AND profile_id = ?`).run(
      tmpAct,
      profileId
    );
    expect(getActivityVideos(profileId, tmpAct)).toHaveLength(0);
  });

  // #1290: deleting an activity captures its cascaded clip rows into the undo buffer
  // and leaves the files on disk (so undo can restore them). When that buffer entry
  // PURGES without a restore, the now-orphaned files must be unlinked — unless a live
  // row still references the same content-named file (dedup re-upload).
  describe("undo-buffer purge unlinks orphaned clip files (#1290)", () => {
    const abs = (rel: string) => path.resolve(process.cwd(), rel);
    const newActivity = (title: string): number =>
      Number(
        db
          .prepare(
            `INSERT INTO activities (profile_id, type, title, date) VALUES (?, 'strength', ?, ?)`
          )
          .run(profileId, title, today(profileId)).lastInsertRowid
      );
    const backdate = (undoId: number) =>
      db
        .prepare(
          `UPDATE deleted_rows SET deleted_at = datetime('now', '-2 days') WHERE id = ?`
        )
        .run(undoId);

    it("purging a captured activity delete unlinks its clip + poster files", () => {
      const act = newActivity("Purge me");
      const v = ingested(
        buildMp4Fixture({ durationSec: 3, creationDate: "2026-07-01" })
      );
      const out = addActivityVideoCore(
        profileId,
        { activityId: act, exercise: null, caption: null },
        v,
        Buffer.from("PURGE-POSTER")
      );
      expect(out.kind).toBe("added");
      const row = db
        .prepare(
          `SELECT stored_path, poster_path FROM activity_videos WHERE activity_id = ?`
        )
        .get(act) as { stored_path: string; poster_path: string };
      expect(fs.existsSync(abs(row.stored_path))).toBe(true);

      // Delete the activity into the undo buffer — files deliberately survive.
      const undoId = captureDelete("activity", profileId, act)!;
      expect(undoId).toBeTruthy();
      expect(fs.existsSync(abs(row.stored_path))).toBe(true);
      expect(fs.existsSync(abs(row.poster_path))).toBe(true);

      // A fresh sweep leaves the buffered entry (and its files) alone.
      sweepDeletedRows(24);
      expect(fs.existsSync(abs(row.stored_path))).toBe(true);

      // Backdate past the window → purge unlinks the now-unreferenced files.
      backdate(undoId);
      sweepDeletedRows(24);
      expect(fs.existsSync(abs(row.stored_path))).toBe(false);
      expect(fs.existsSync(abs(row.poster_path))).toBe(false);
    });

    it("does NOT unlink a file a live row still references (content-hash dedup)", () => {
      const act = newActivity("Dedup source");
      const v = ingested(
        buildMp4Fixture({ durationSec: 4, creationDate: "2026-07-02" })
      );
      const out = addActivityVideoCore(
        profileId,
        { activityId: act, exercise: null, caption: null },
        v,
        null
      );
      expect(out.kind).toBe("added");
      const storedPath = (
        db
          .prepare(
            `SELECT stored_path FROM activity_videos WHERE activity_id = ?`
          )
          .get(act) as { stored_path: string }
      ).stored_path;

      // Capture-delete the activity (row gone, file stays, payload references it).
      const undoId = captureDelete("activity", profileId, act)!;

      // Re-upload the IDENTICAL clip to a different live activity → a live row now
      // points at the SAME content-named file (dedup: store overwrote in place).
      const keeper = newActivity("Dedup keeper");
      const re = addActivityVideoCore(
        profileId,
        { activityId: keeper, exercise: null, caption: null },
        ingested(
          buildMp4Fixture({ durationSec: 4, creationDate: "2026-07-02" })
        ),
        null
      );
      expect(re.kind).toBe("added");
      const keeperPath = (
        db
          .prepare(
            `SELECT stored_path FROM activity_videos WHERE activity_id = ?`
          )
          .get(keeper) as { stored_path: string }
      ).stored_path;
      expect(keeperPath).toBe(storedPath); // same file, shared by dedup
      expect(fs.existsSync(abs(storedPath))).toBe(true);

      // Purge the stale capture — the file must SURVIVE (a live row references it).
      backdate(undoId);
      sweepDeletedRows(24);
      expect(fs.existsSync(abs(storedPath))).toBe(true);
      expect(getActivityVideos(profileId, keeper)).toHaveLength(1);
    });
  });

  it("delete removes the row + files, profile-scoped by id", () => {
    const v = ingested(
      buildMp4Fixture({ durationSec: 5, creationDate: "2026-06-20" })
    );
    const out = addActivityVideoCore(
      profileId,
      { activityId, exercise: null, caption: null },
      v,
      null
    );
    expect(out.kind).toBe("added");
    if (out.kind !== "added") return;
    const row = db
      .prepare(
        `SELECT stored_path FROM activity_videos WHERE id = ? AND profile_id = ?`
      )
      .get(out.id, profileId) as { stored_path: string };
    expect(deleteActivityVideoCore(profileId + 1, out.id)).toBe(false);
    expect(deleteActivityVideoCore(profileId, out.id)).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), row.stored_path))).toBe(
      false
    );
  });
});
