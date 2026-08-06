// Auth-blind write cores + gather for LESION photos (issue #715). profileId-first,
// never imports lib/auth — the Server Action owns the gate + revalidation. Its OWN
// table + files dir, so a lesion photo never enters the medical-document pipeline /
// passport. A photo binds to a lesion by `lesion_id` (re-checked under profile_id, so a
// forged id can't attach to another profile's lesion) and is dated by `date`, so a
// side-by-side "is this mole changing?" comparison reads chronologically. Every
// statement is profile-scoped.
//
// PHOTO CORE (#1844, phase 3): bytes arrive here ALREADY processed by
// lib/photo/ingest.ts processPhoto() — magic-byte sniffed, EXIF-harvested-then-
// STRIPPED, auto-oriented, downscaled, thumbnailed — so this module owns only the
// domain row, the per-profile dedup on the PROCESSED content hash, and the file store
// (lib/photo/store.ts). Before phase 3 this domain wrote the uploaded bytes verbatim:
// a dermatology close-up kept its GPS and device metadata on disk. Nothing in this
// module may re-open that path — the strip is not a domain choice, it is the core's.
//
// SCOPE BOUNDARY (#715): the photos are for the USER'S OWN serial comparison and their
// dermatologist — nothing here assesses a lesion.

import { db, writeTx } from "./db";
import { isRealIsoDate } from "./date";
import type { ProcessedPhoto } from "./photo/ingest";
import {
  photoDomainRoot,
  storeProcessedPhoto,
  thumbSiblingPath,
  unlinkPhotoFiles,
} from "./photo/store";

// The ONLY directory lesion photos are stored under (per-profile subdirs). A served
// path must resolve inside this dir (the serve route's path-traversal guard). Read out
// of the core store's OWN mapping so a dir rename can't leave a containment check
// silently pointing at the wrong root.
export const LESION_PHOTO_DIR = photoDomainRoot("lesion");

export type LesionPhotoOutcome =
  | { kind: "attached"; id: number }
  | { kind: "duplicate"; id: number }
  | { kind: "invalid"; error: string };

export interface LesionPhotoRow {
  id: number;
  lesion_id: number;
  date: string;
  mime_type: string | null;
  caption: string | null;
  created_at: string;
}

// Attach a processed photo to a lesion. Re-checks the lesion belongs to the profile,
// validates the date, dedups per-profile on the PROCESSED content hash (a re-upload of
// the identical capture reuses the existing row), stores the stripped file + its
// thumbnail under data/uploads/lesion-photos/<profileId>/, and inserts the row. Returns
// a typed outcome so the caller never unconditionally confirms. `caption` is optional.
export function attachLesionPhotoCore(
  profileId: number,
  lesionId: number,
  date: string,
  photo: ProcessedPhoto,
  caption: string | null = null
): LesionPhotoOutcome {
  const lesion = db
    .prepare(`SELECT id FROM skin_lesions WHERE id = ? AND profile_id = ?`)
    .get(lesionId, profileId) as { id: number } | undefined;
  if (!lesion)
    return { kind: "invalid", error: "That lesion is no longer available." };
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };

  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;

  return writeTx(() => {
    // Per-profile dedup: a re-upload of the identical image reuses the existing row.
    const existing = db
      .prepare(
        `SELECT id FROM lesion_photos WHERE profile_id = ? AND content_hash = ?`
      )
      .get(profileId, photo.contentHash) as { id: number } | undefined;
    if (existing) return { kind: "duplicate" as const, id: existing.id };

    const { storedPath } = storeProcessedPhoto("lesion", profileId, photo);
    const info = db
      .prepare(
        `INSERT INTO lesion_photos
           (profile_id, lesion_id, date, stored_path, content_hash, mime_type, size_bytes, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        lesionId,
        date,
        storedPath,
        photo.contentHash,
        photo.mime,
        photo.sizeBytes,
        cap
      );
    return { kind: "attached" as const, id: Number(info.lastInsertRowid) };
  });
}

// Every photo for a profile (all lesions), newest first — the page maps them per
// lesion + per #482 identity in JS for the serial comparison strip. Profile-scoped.
export function getLesionPhotos(profileId: number): LesionPhotoRow[] {
  return db
    .prepare(
      `SELECT id, lesion_id, date, mime_type, caption, created_at
         FROM lesion_photos
        WHERE profile_id = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId) as LesionPhotoRow[];
}

// Delete one lesion photo — the row AND its on-disk files (row-op side-state #199):
// the photo and the thumbnail derived beside it. Path-contained by the core store: a
// path resolving outside the lesion root is skipped, never followed. Idempotent.
export function deleteLesionPhotoCore(profileId: number, id: number): boolean {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT stored_path FROM lesion_photos WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as { stored_path: string } | undefined;
    if (!row) return false;
    db.prepare(`DELETE FROM lesion_photos WHERE id = ? AND profile_id = ?`).run(
      id,
      profileId
    );
    unlinkPhotoFiles("lesion", [
      row.stored_path,
      thumbSiblingPath(row.stored_path),
    ]);
    return true;
  });
}

// Delete every photo of a lesion (row + on-disk file), called BEFORE a skin_lesions
// DELETE so the lesion_photos.lesion_id REFERENCES FK doesn't trip (row-ops side-state
// #199-#203). Profile-scoped. Returns the count removed.
export function deleteLesionPhotosForLesion(
  profileId: number,
  lesionId: number
): number {
  return writeTx(() => {
    const rows = db
      .prepare(
        `SELECT id, stored_path FROM lesion_photos
          WHERE profile_id = ? AND lesion_id = ?`
      )
      .all(profileId, lesionId) as { id: number; stored_path: string }[];
    db.prepare(
      `DELETE FROM lesion_photos WHERE profile_id = ? AND lesion_id = ?`
    ).run(profileId, lesionId);
    unlinkPhotoFiles(
      "lesion",
      rows.flatMap((r) => [r.stored_path, thumbSiblingPath(r.stored_path)])
    );
    return rows.length;
  });
}
