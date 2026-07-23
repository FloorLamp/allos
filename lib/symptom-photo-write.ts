// Auth-blind write cores + gather for symptom photos (issue #859 item 4). profileId-
// first, never imports lib/auth — the Server Action owns the gate + revalidation. Rides
// the medical-uploads posture (per-profile dirs, sha256 dedup, path-contained serving)
// but its OWN table + files dir, so a rash photo never enters the medical-document
// pipeline / passport. A photo binds to a symptom-DAY by `date` (membership-by-date,
// like every other illness ingredient); `symptom` optionally pins a specific
// symptom-day. Every statement is profile-scoped.
//
// PHI POSTURE: nothing here is read by the episode share/print path
// (assembleIllnessEpisode) — the exclusion of photos from shares/printables is
// structural (the safe default), not a flag.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, writeTx } from "./db";
import { isRealIsoDate } from "./date";
// The upload byte cap + magic-byte sniff are shared photo-capture policy (#1284) —
// one definition in lib/photo/policy.ts so this domain, lib/skin-photo-write.ts, and
// the shared lib/photo/ingest.ts can never disagree on size/type acceptance.
import { MAX_PHOTO_BYTES, sniffImageMime } from "./photo/policy";

// The ONLY directory symptom photos are stored under (per-profile subdirs). A served
// path must resolve inside this dir (the serve route's path-traversal guard).
export const SYMPTOM_PHOTO_DIR = path.join(
  process.cwd(),
  "data",
  "uploads",
  "symptom-photos"
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

export type SymptomPhotoOutcome =
  | { kind: "attached"; id: number }
  | { kind: "duplicate"; id: number }
  | { kind: "invalid"; error: string };

export interface SymptomPhotoRow {
  id: number;
  date: string;
  symptom: string | null;
  mime_type: string | null;
  caption: string | null;
  created_at: string;
}

// Attach a photo to a symptom-day. Validates the date + image bytes, dedups per-profile
// on the content hash, writes the file under data/uploads/symptom-photos/<profileId>/,
// and inserts the row. Returns a typed outcome so the caller never unconditionally
// confirms. `symptom`/`caption` are optional.
export function attachSymptomPhotoCore(
  profileId: number,
  date: string,
  buffer: Buffer,
  originalName: string,
  symptom: string | null = null,
  caption: string | null = null
): SymptomPhotoOutcome {
  if (!isRealIsoDate(date))
    return { kind: "invalid", error: "Enter a valid date." };
  if (buffer.length === 0) return { kind: "invalid", error: "Empty file." };
  if (buffer.length > MAX_PHOTO_BYTES)
    return { kind: "invalid", error: "That image is too large (max 15 MB)." };
  const mime = sniffImageMime(buffer);
  if (!mime)
    return { kind: "invalid", error: "That file isn't a supported image." };

  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const sym = symptom?.trim() ? symptom.trim() : null;
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;

  // Per-profile dedup: a re-upload of the identical image reuses the existing row.
  const existing = db
    .prepare(
      `SELECT id FROM symptom_photos WHERE profile_id = ? AND content_hash = ?`
    )
    .get(profileId, contentHash) as { id: number } | undefined;
  if (existing) return { kind: "duplicate", id: existing.id };

  const profileDir = path.join(SYMPTOM_PHOTO_DIR, String(profileId));
  fs.mkdirSync(profileDir, { recursive: true });
  const ext = EXT_FOR_MIME[mime] ?? "";
  const base = safeName(originalName.replace(/\.[a-zA-Z0-9]+$/, "")) + ext;
  const fileName = `${contentHash.slice(0, 16)}-${base}`;
  const abs = path.join(profileDir, fileName);
  const storedPath = path.join(
    "data",
    "uploads",
    "symptom-photos",
    String(profileId),
    fileName
  );

  return writeTx(() => {
    fs.writeFileSync(abs, buffer);
    const info = db
      .prepare(
        `INSERT INTO symptom_photos
           (profile_id, date, symptom, stored_path, content_hash, mime_type, size_bytes, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        date,
        sym,
        storedPath,
        contentHash,
        mime,
        buffer.length,
        cap
      );
    return { kind: "attached" as const, id: Number(info.lastInsertRowid) };
  });
}

// The photos attached in a date window (episode strip). Newest first. Profile-scoped.
export function getSymptomPhotosInRange(
  profileId: number,
  from: string,
  to: string
): SymptomPhotoRow[] {
  return db
    .prepare(
      `SELECT id, date, symptom, mime_type, caption, created_at
         FROM symptom_photos
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, from, to) as SymptomPhotoRow[];
}

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

// Delete one symptom photo — the row AND its on-disk file (row-op side-state #199).
// Path-contained: only a file under SYMPTOM_PHOTO_DIR is unlinked. Idempotent.
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
    const abs = path.resolve(process.cwd(), row.stored_path);
    const root = path.resolve(SYMPTOM_PHOTO_DIR);
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
