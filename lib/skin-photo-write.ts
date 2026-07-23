// Auth-blind write cores + gather for LESION photos (issue #715). profileId-first,
// never imports lib/auth — the Server Action owns the gate + revalidation. Rides the
// medical-uploads posture (per-profile dirs, sha256 dedup, path-contained serving) —
// the symptom_photos precedent (lib/symptom-photo-write.ts) — but its OWN table + files
// dir, so a lesion photo never enters the medical-document pipeline / passport. A photo
// binds to a lesion by `lesion_id` (re-checked under profile_id, so a forged id can't
// attach to another profile's lesion) and is dated by `date`, so a side-by-side "is
// this mole changing?" comparison reads chronologically. Every statement is
// profile-scoped.
//
// SCOPE BOUNDARY (#715): the photos are for the USER'S OWN serial comparison and their
// dermatologist — nothing here assesses a lesion.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, writeTx } from "./db";
import { isRealIsoDate } from "./date";
import { sniffImageMime, MAX_PHOTO_BYTES } from "./photo/policy";

// The ONLY directory lesion photos are stored under (per-profile subdirs). A served
// path must resolve inside this dir (the serve route's path-traversal guard).
export const LESION_PHOTO_DIR = path.join(
  process.cwd(),
  "data",
  "uploads",
  "lesion-photos"
);

function safeName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "photo"
  );
}

const EXT_FOR_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

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

// Attach a photo to a lesion. Re-checks the lesion belongs to the profile, validates
// the date + image bytes (mime is SERVER-sniffed, never the client-declared type), dedups
// per-profile on the content hash, writes the file under
// data/uploads/lesion-photos/<profileId>/, and inserts the row. Returns a typed outcome
// so the caller never unconditionally confirms. `caption` is optional.
export function attachLesionPhotoCore(
  profileId: number,
  lesionId: number,
  date: string,
  buffer: Buffer,
  originalName: string,
  caption: string | null = null
): LesionPhotoOutcome {
  const lesion = db
    .prepare(`SELECT id FROM skin_lesions WHERE id = ? AND profile_id = ?`)
    .get(lesionId, profileId) as { id: number } | undefined;
  if (!lesion)
    return { kind: "invalid", error: "That lesion is no longer available." };
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (buffer.length === 0) return { kind: "invalid", error: "Empty file." };
  if (buffer.length > MAX_PHOTO_BYTES)
    return { kind: "invalid", error: "That image is too large (max 15 MB)." };
  const mime = sniffImageMime(buffer);
  if (!mime)
    return { kind: "invalid", error: "That file isn't a supported image." };

  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;

  // Per-profile dedup: a re-upload of the identical image reuses the existing row.
  const existing = db
    .prepare(
      `SELECT id FROM lesion_photos WHERE profile_id = ? AND content_hash = ?`
    )
    .get(profileId, contentHash) as { id: number } | undefined;
  if (existing) return { kind: "duplicate", id: existing.id };

  const profileDir = path.join(LESION_PHOTO_DIR, String(profileId));
  fs.mkdirSync(profileDir, { recursive: true });
  const ext = EXT_FOR_MIME[mime] ?? "";
  const base = safeName(originalName.replace(/\.[a-zA-Z0-9]+$/, "")) + ext;
  const fileName = `${contentHash.slice(0, 16)}-${base}`;
  const abs = path.join(profileDir, fileName);
  const storedPath = path.join(
    "data",
    "uploads",
    "lesion-photos",
    String(profileId),
    fileName
  );

  return writeTx(() => {
    fs.writeFileSync(abs, buffer);
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
        contentHash,
        mime,
        buffer.length,
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

// Delete one lesion photo — the row AND its on-disk file (row-op side-state #199).
// Path-contained: only a file under LESION_PHOTO_DIR is unlinked. Idempotent.
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
    const abs = path.resolve(process.cwd(), row.stored_path);
    const root = path.resolve(LESION_PHOTO_DIR);
    if (abs.startsWith(root + path.sep) && fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs);
      } catch {
        // A missing/locked file must not fail the row delete.
      }
    }
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
    const root = path.resolve(LESION_PHOTO_DIR);
    for (const r of rows) {
      const abs = path.resolve(process.cwd(), r.stored_path);
      if (abs.startsWith(root + path.sep) && fs.existsSync(abs)) {
        try {
          fs.unlinkSync(abs);
        } catch {
          // A missing/locked file must not fail the row delete.
        }
      }
    }
    return rows.length;
  });
}
