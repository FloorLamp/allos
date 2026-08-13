// Auth-blind write cores + gather for symptom photos (issue #859 item 4). profileId-
// first, never imports lib/auth — the Server Action owns the gate + revalidation. Its
// OWN table + files dir, so a rash photo never enters the medical-document pipeline /
// passport. A photo binds to a symptom-DAY by `date` (membership-by-date, like every
// other illness ingredient); `symptom` optionally pins a specific symptom-day. Every
// statement is profile-scoped.
//
// PHOTO CORE (#1844, phase 3): bytes arrive here ALREADY processed by
// lib/photo/ingest.ts processPhoto() — magic-byte sniffed, EXIF-harvested-then-
// STRIPPED, auto-oriented, downscaled, thumbnailed — so this module owns only the
// domain row, the per-profile dedup on the PROCESSED content hash, and the file store
// (lib/photo/store.ts). Before phase 3 this domain wrote the uploaded bytes verbatim:
// a photo of a child's rash kept its GPS and device metadata on disk. The strip is the
// core's job, not a per-domain one — nothing here may write unprocessed bytes.
//
// PHI POSTURE: nothing here is read by the episode share/print path
// (assembleIllnessEpisode) — the exclusion of photos from shares/printables is
// structural (the safe default), not a flag.

import { db, writeTx } from "./db";
import { isRealIsoDate } from "./date";
import type { ProcessedPhoto } from "./photo/ingest";
import {
  photoDomainRoot,
  storeProcessedPhoto,
  thumbSiblingPath,
  unlinkPhotoFiles,
} from "./photo/store";

// The ONLY directory symptom photos are stored under (per-profile subdirs). A served
// path must resolve inside this dir (the serve route's path-traversal guard). Read out
// of the core store's OWN mapping so a dir rename can't leave a containment check
// silently pointing at the wrong root.
export const SYMPTOM_PHOTO_DIR = photoDomainRoot("symptom");

export type SymptomPhotoOutcome =
  | { kind: "attached"; id: number }
  | { kind: "duplicate"; id: number }
  | { kind: "invalid"; error: string };

export interface SymptomPhotoRow {
  id: number;
  date: string;
  symptom: string | null;
  symptom_log_id: number | null;
  mime_type: string | null;
  caption: string | null;
  created_at: string;
}

// Attach a processed photo to a symptom-day. Validates the date, dedups per-profile on
// the PROCESSED content hash, writes the stripped file + its thumbnail under
// data/uploads/symptom-photos/<profileId>/, and inserts the row. Returns a typed
// outcome so the caller never unconditionally confirms. `symptom`/`caption` are
// optional.
export function attachSymptomPhotoCore(
  profileId: number,
  date: string,
  photo: ProcessedPhoto,
  symptom: string | null = null,
  caption: string | null = null
): SymptomPhotoOutcome {
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };

  const sym = symptom?.trim() ? symptom.trim() : null;
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;

  // #1093: bind the photo to the SPECIFIC symptom-day log it illustrates when one is
  // named AND already logged for this (profile, date) — so two symptoms logged the same
  // day keep DISTINCT photo sets. A whole-day photo (no symptom) or a not-yet-logged
  // symptom carries a NULL link; the `date` still places it on the day.
  const logId = sym
    ? ((
        db
          .prepare(
            `SELECT id FROM symptom_logs
              WHERE profile_id = ? AND date = ? AND symptom = ?`
          )
          .get(profileId, date, sym) as { id: number } | undefined
      )?.id ?? null)
    : null;

  return writeTx(() => {
    // Per-profile dedup: a re-upload of the identical image reuses the existing row.
    const existing = db
      .prepare(
        `SELECT id FROM symptom_photos WHERE profile_id = ? AND content_hash = ?`
      )
      .get(profileId, photo.contentHash) as { id: number } | undefined;
    if (existing) return { kind: "duplicate" as const, id: existing.id };

    const { storedPath } = storeProcessedPhoto("symptom", profileId, photo);
    const info = db
      .prepare(
        `INSERT INTO symptom_photos
           (profile_id, date, symptom, symptom_log_id, stored_path, content_hash, mime_type, size_bytes, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        date,
        sym,
        logId,
        storedPath,
        photo.contentHash,
        photo.mime,
        photo.sizeBytes,
        cap
      );
    return { kind: "attached" as const, id: Number(info.lastInsertRowid) };
  });
}

// The photos attached in a date window (episode strip). Newest first. Profile-scoped.
// Carries `symptom_log_id` (#1093) so the strip can label a photo with the symptom it
// documents and two same-day symptoms show apart.
export function getSymptomPhotosInRange(
  profileId: number,
  from: string,
  to: string
): SymptomPhotoRow[] {
  return db
    .prepare(
      `SELECT id, date, symptom, symptom_log_id, mime_type, caption, created_at
         FROM symptom_photos
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, from, to) as SymptomPhotoRow[];
}

// The photos bound to ONE symptom-day log (#1093 reverse query). Newest first. Two
// symptoms logged the same day resolve to DISTINCT sets — the payoff of the specific
// symptom_log_id link over the old profile+date-only key. Profile-scoped.
export function getSymptomPhotosForLog(
  profileId: number,
  symptomLogId: number
): SymptomPhotoRow[] {
  return db
    .prepare(
      `SELECT id, date, symptom, symptom_log_id, mime_type, caption, created_at
         FROM symptom_photos
        WHERE profile_id = ? AND symptom_log_id = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, symptomLogId) as SymptomPhotoRow[];
}

// A symptom-DAY's photos are taken by the `symptom-day` undo kind now (#2124), not by a
// helper here. The removed `deletePhotosForSymptomLog` deleted the rows AND unlinked the
// files in one breath, which is exactly what made the bar's one-tap × unrecoverable
// off-DB. captureDelete removes the photo rows as declared `deleteExplicitly` children
// (their FK carries no ON DELETE, so they must go before the log row) and LEAVES THE
// FILES: they are content-named, a restored row re-points at the same bytes, and the
// undo purge reclaims them if no undo ever came.
//
// A per-PHOTO delete still unlinks immediately — deleteSymptomPhotoCore below is a user
// saying "remove this photo", not "remove this day".

// Update only the user-authored caption. Empty text clears it; the same 500-character
// ceiling used at upload keeps both write paths consistent. Profile-scoped by id.
export function updateSymptomPhotoCaptionCore(
  profileId: number,
  id: number,
  caption: string | null
): boolean {
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;
  return (
    db
      .prepare(
        `UPDATE symptom_photos
            SET caption = ?
          WHERE id = ? AND profile_id = ?`
      )
      .run(cap, id, profileId).changes > 0
  );
}

// Delete one symptom photo — the row AND its on-disk files (row-op side-state #199):
// the photo and the thumbnail derived beside it. Path-contained by the core store: a
// path resolving outside the symptom root is skipped, never followed. Idempotent.
export function deleteSymptomPhotoCore(profileId: number, id: number): boolean {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT stored_path FROM symptom_photos WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as { stored_path: string } | undefined;
    if (!row) return false;
    db.prepare(
      `DELETE FROM symptom_photos WHERE id = ? AND profile_id = ?`
    ).run(id, profileId);
    unlinkPhotoFiles("symptom", [
      row.stored_path,
      thumbSiblingPath(row.stored_path),
    ]);
    return true;
  });
}
