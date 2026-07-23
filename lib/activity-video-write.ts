// Auth-blind write cores + gather for TRAINING form-check video clips (#1224
// phase 1). profileId-first, never imports lib/auth — the Server Action owns the
// gate + revalidation. A clip attaches to an ACTIVITY (a logged lift/movement),
// with an optional `exercise` name for per-lift filtering; surfaced on the Journal
// card. Its OWN table + files dir (data/uploads/activity-videos/<profileId>/), the
// symptom-video / photo-core store posture. Every statement is profile-scoped.
//
// Bytes arrive here ALREADY validated by lib/video/ingest.ts and the poster
// ALREADY EXIF-stripped by the #1119 photo ingest — this module owns the domain
// row + per-profile dedup + the file store. The ORIGINAL clip is stored AS-IS.
//
// ROW-OPS side-state (#199/#200): activity_videos.activity_id carries ON DELETE
// CASCADE, so a plain activity delete removes its clips; the rows are captured into
// the undo buffer first (UNDO_KINDS.activity) so a mis-tap is undoable, and a merge
// re-parents them onto the keeper (writeActivityFold) so a merge never loses a clip.

import { db, writeTx } from "./db";
import type { IngestedVideo } from "./video/ingest";
import { storeVideoFiles, unlinkVideoFiles } from "./video/store";

export interface ActivityVideoRow {
  id: number;
  activity_id: number;
  exercise: string | null;
  caption: string | null;
  kind: string;
  duration_sec: number | null;
  has_location: number;
  poster_path: string | null;
  created_at: string;
}

export type ActivityVideoOutcome =
  | { kind: "added"; id: number }
  | { kind: "duplicate"; id: number }
  | { kind: "invalid"; error: string };

// Attach a validated clip to one of the profile's activities. Verifies the
// activity belongs to the profile (a forged cross-profile activity id is
// rejected), dedups per-profile on the clip's content hash, stores the clip +
// optional poster, and inserts the row. Returns a typed outcome.
export function addActivityVideoCore(
  profileId: number,
  input: {
    activityId: number;
    exercise: string | null;
    caption: string | null;
  },
  video: IngestedVideo,
  poster: Buffer | null
): ActivityVideoOutcome {
  if (!input.activityId)
    return { kind: "invalid", error: "That activity is no longer available." };
  const exercise = input.exercise?.trim()
    ? input.exercise.trim().slice(0, 120)
    : null;
  const cap = input.caption?.trim() ? input.caption.trim().slice(0, 500) : null;

  return writeTx(() => {
    const activity = db
      .prepare(`SELECT id FROM activities WHERE id = ? AND profile_id = ?`)
      .get(input.activityId, profileId) as { id: number } | undefined;
    if (!activity)
      return {
        kind: "invalid" as const,
        error: "That activity is no longer available.",
      };

    const existing = db
      .prepare(
        `SELECT id FROM activity_videos WHERE profile_id = ? AND content_hash = ?`
      )
      .get(profileId, video.contentHash) as { id: number } | undefined;
    if (existing) return { kind: "duplicate" as const, id: existing.id };

    const { storedPath, posterPath } = storeVideoFiles("activity", profileId, {
      contentHash: video.contentHash,
      mime: video.mime,
      bytes: video.bytes,
      poster,
    });
    const info = db
      .prepare(
        `INSERT INTO activity_videos
           (profile_id, activity_id, exercise, stored_path, poster_path,
            content_hash, mime_type, kind, duration_sec, size_bytes,
            has_location, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        input.activityId,
        exercise,
        storedPath,
        posterPath,
        video.contentHash,
        video.mime,
        video.kind,
        video.durationSec,
        video.sizeBytes,
        video.hasLocation ? 1 : 0,
        cap
      );
    return { kind: "added" as const, id: Number(info.lastInsertRowid) };
  });
}

// Clips attached to a single activity, newest first. Profile-scoped.
export function getActivityVideos(
  profileId: number,
  activityId: number
): ActivityVideoRow[] {
  return db
    .prepare(
      `SELECT id, activity_id, exercise, caption, kind, duration_sec,
              has_location, poster_path, created_at
         FROM activity_videos
        WHERE profile_id = ? AND activity_id = ?
        ORDER BY id DESC`
    )
    .all(profileId, activityId) as ActivityVideoRow[];
}

// Clips for a set of activities → Map<activityId, rows>, for the Journal feed
// (one query per page, then bucketed). Profile-scoped. An empty id list returns an
// empty map without touching the DB.
export function getActivityVideosForActivities(
  profileId: number,
  activityIds: readonly number[]
): Map<number, ActivityVideoRow[]> {
  const out = new Map<number, ActivityVideoRow[]>();
  if (activityIds.length === 0) return out;
  const placeholders = activityIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, activity_id, exercise, caption, kind, duration_sec,
              has_location, poster_path, created_at
         FROM activity_videos
        WHERE profile_id = ? AND activity_id IN (${placeholders})
        ORDER BY id DESC`
    )
    .all(profileId, ...activityIds) as ActivityVideoRow[];
  for (const r of rows) {
    const list = out.get(r.activity_id);
    if (list) list.push(r);
    else out.set(r.activity_id, [r]);
  }
  return out;
}

// Update only the user-authored caption. Empty text clears it. Profile-scoped by id.
export function updateActivityVideoCaptionCore(
  profileId: number,
  id: number,
  caption: string | null
): boolean {
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;
  return (
    db
      .prepare(
        `UPDATE activity_videos SET caption = ? WHERE id = ? AND profile_id = ?`
      )
      .run(cap, id, profileId).changes > 0
  );
}

// Delete one activity clip — the row AND its on-disk files (clip + poster), path-
// contained. Idempotent; profile-scoped by id.
export function deleteActivityVideoCore(
  profileId: number,
  id: number
): boolean {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT stored_path, poster_path FROM activity_videos
          WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as
      { stored_path: string; poster_path: string | null } | undefined;
    if (!row) return false;
    db.prepare(
      `DELETE FROM activity_videos WHERE id = ? AND profile_id = ?`
    ).run(id, profileId);
    unlinkVideoFiles("activity", [row.stored_path, row.poster_path]);
    return true;
  });
}
