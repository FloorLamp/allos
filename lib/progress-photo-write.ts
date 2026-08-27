// Auth-blind write cores + gather for physique PROGRESS photos (#1119 phase 2).
// profileId-first, never imports lib/auth — the Server Action owns the gate +
// revalidation. First domain on the shared photo core: bytes arrive here ALREADY
// processed by lib/photo/ingest.ts processPhoto() (EXIF-stripped, auto-oriented,
// downscaled, thumbnailed), so this module only owns the domain row + the
// per-profile dedup + the file store. Every statement is profile-scoped.
//
// SCOPE BOUNDARY (#1119, product-decided): capture, tag (pose), compare, browse —
// nothing here scores a physique (no body-fat estimate, no AI). The
// weight_kg_snapshot is a FACTUAL display snapshot of the existing body_metrics
// weight near the photo's date (one computation, write-time), never a second
// weight store and never a judgment.
//
// PHI POSTURE (strictest tier): progress photos are excluded from share links,
// the emergency card, and the full data export STRUCTURALLY (none of those paths
// read this table or its files) — the symptom_photos precedent.

import { db, writeTx } from "./db";
import { isRealIsoDate, shiftDateStr } from "./date";
import { normalizePose } from "./progress-photos";
import type { ProcessedPhoto } from "./photo/ingest";
import { storeProcessedPhoto, unlinkPhotoFiles } from "./photo/store";
import type { ProgressPose } from "./progress-photos";

export interface ProgressPhotoRow {
  id: number;
  date: string;
  pose: ProgressPose;
  caption: string | null;
  weight_kg_snapshot: number | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

export type AddProgressPhotoOutcome =
  | { kind: "added"; id: number }
  | { kind: "duplicate"; id: number }
  | { kind: "invalid"; error: string };

// How far back (days) the weight snapshot may look. A photo without a weigh-in
// that week just carries no snapshot — never a stale one.
const WEIGHT_SNAPSHOT_WINDOW_DAYS = 7;

// The most recent body_metrics weight on/before `date`, within the window.
// Exported for the DB-tier test; read-only.
export function weightSnapshotForDate(
  profileId: number,
  date: string
): number | null {
  const floor = shiftDateStr(date, -WEIGHT_SNAPSHOT_WINDOW_DAYS);
  const row = db
    .prepare(
      `SELECT weight_kg FROM body_metrics
        WHERE profile_id = ? AND weight_kg IS NOT NULL
          AND date <= ? AND date >= ?
        ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId, date, floor) as { weight_kg: number } | undefined;
  return row?.weight_kg ?? null;
}

// Insert a processed progress photo: validates pose + date, dedups per-profile
// on the processed content hash (a re-upload of the identical capture reuses the
// existing row), stores the file + thumbnail, snapshots the nearby weight.
// Returns a typed outcome so the caller never unconditionally confirms.
export function addProgressPhotoCore(
  profileId: number,
  input: { date: string; pose: string; caption: string | null },
  photo: ProcessedPhoto
): AddProgressPhotoOutcome {
  const pose = normalizePose(input.pose);
  if (!pose) return { kind: "invalid", error: "Pick a pose for the photo." };
  if (!isRealIsoDate(input.date))
    return { kind: "invalid", error: "Enter a valid date." };
  const caption = input.caption?.trim()
    ? input.caption.trim().slice(0, 500)
    : null;

  return writeTx(() => {
    const existing = db
      .prepare(
        `SELECT id FROM progress_photos WHERE profile_id = ? AND content_hash = ?`
      )
      .get(profileId, photo.contentHash) as { id: number } | undefined;
    if (existing) return { kind: "duplicate" as const, id: existing.id };

    const { storedPath, thumbPath } = storeProcessedPhoto(
      "progress",
      profileId,
      photo
    );
    const info = db
      .prepare(
        `INSERT INTO progress_photos
           (profile_id, date, pose, stored_path, thumb_path, content_hash,
            mime_type, size_bytes, caption, weight_kg_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        input.date,
        pose,
        storedPath,
        thumbPath,
        photo.contentHash,
        photo.mime,
        photo.sizeBytes,
        caption,
        weightSnapshotForDate(profileId, input.date)
      );
    return { kind: "added" as const, id: Number(info.lastInsertRowid) };
  });
}

// The typed result of a metadata correction (issue #1934):
//   updated    — the row's date/pose/caption changed; the stored artifacts did not.
//   not-found  — no such photo for this profile (a forged/stale id, or another
//                profile's row — the statement is id + profile_id scoped).
//   invalid    — off-vocabulary pose or an unreal date; nothing written.
export type UpdateProgressPhotoOutcome =
  | { kind: "updated"; id: number }
  | { kind: "not-found" }
  | { kind: "invalid"; error: string };

// Correct one progress photo's METADATA in place (issue #1934). The image BYTES are
// immutable content and stay that way: `stored_path`, `thumb_path`, `content_hash`,
// `mime_type` and `size_bytes` are absent from the SET list, so a correction can never
// re-point a row at different pixels, and the per-profile content-hash dedup keeps
// meaning exactly what it meant before. Only the three fields a human can get wrong —
// date, pose, caption — are editable, which is why delete-and-re-upload (the only
// repair before this) is the wrong shape: it discards the original file and its place
// in the series.
//
// `pose` goes through the same strict normalizePose the insert uses, so the CHECK enum
// can only ever see a member of PROGRESS_POSES. A `date` change re-sorts the series
// (browse groups by date, compare reads date order) — nothing else is keyed on the old
// date: the gallery/timeline derive their order from the rows themselves, the serve
// route is keyed on id + profile_id, and the files live at content-addressed paths, so
// no comparison or side-state is orphaned.
//
// The weight snapshot is re-derived ONLY when the date actually moves. It is the
// factual body_metrics weight near the photo's date (write-time, one computation), so
// leaving it pinned to the wrong day would be a stale fact; a caption typo fix, by
// contrast, must not churn it.
export function updateProgressPhotoCore(
  profileId: number,
  id: number,
  input: { date: string; pose: string; caption: string | null }
): UpdateProgressPhotoOutcome {
  const pose = normalizePose(input.pose);
  if (!pose) return { kind: "invalid", error: "Pick a pose for the photo." };
  if (!isRealIsoDate(input.date))
    return { kind: "invalid", error: "Enter a valid date." };
  const caption = input.caption?.trim()
    ? input.caption.trim().slice(0, 500)
    : null;

  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT date FROM progress_photos WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as { date: string } | undefined;
    if (!row) return { kind: "not-found" as const };
    const snapshot =
      row.date === input.date
        ? undefined
        : weightSnapshotForDate(profileId, input.date);
    if (snapshot === undefined) {
      db.prepare(
        `UPDATE progress_photos SET date = ?, pose = ?, caption = ?
          WHERE id = ? AND profile_id = ?`
      ).run(input.date, pose, caption, id, profileId);
    } else {
      db.prepare(
        `UPDATE progress_photos
            SET date = ?, pose = ?, caption = ?, weight_kg_snapshot = ?
          WHERE id = ? AND profile_id = ?`
      ).run(input.date, pose, caption, snapshot, id, profileId);
    }
    return { kind: "updated" as const, id };
  });
}

// Every progress photo for a profile, newest first. The page derives per-pose
// series / gallery grouping in JS (lib/photo/gallery-model.ts).
export function getProgressPhotos(profileId: number): ProgressPhotoRow[] {
  return db
    .prepare(
      `SELECT id, date, pose, caption, weight_kg_snapshot, mime_type, size_bytes, created_at
         FROM progress_photos
        WHERE profile_id = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId) as ProgressPhotoRow[];
}

// Delete one progress photo — the row AND its on-disk files (row-op side-state
// #199/#203; path-contained). Idempotent; profile-scoped by id.
export function deleteProgressPhotoCore(
  profileId: number,
  id: number
): boolean {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT stored_path, thumb_path FROM progress_photos
          WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as
      { stored_path: string; thumb_path: string | null } | undefined;
    if (!row) return false;
    db.prepare(
      `DELETE FROM progress_photos WHERE id = ? AND profile_id = ?`
    ).run(id, profileId);
    unlinkPhotoFiles("progress", [row.stored_path, row.thumb_path]);
    return true;
  });
}
