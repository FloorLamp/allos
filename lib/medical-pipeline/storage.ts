import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { sqlNow } from "../clock";

export const UPLOAD_DIR = path.join(
  process.cwd(),
  "data",
  "uploads",
  "medical"
);

export interface DedupTarget {
  id: number;
  filename: string;
  status: string;
  stored_path: string | null;
}

export function findDedupTarget(
  profileId: number,
  contentHash: string
): DedupTarget | undefined {
  return db
    .prepare(
      `SELECT id, filename, extraction_status AS status, stored_path
         FROM medical_documents
        WHERE content_hash = ? AND profile_id = ?
          AND (
            (stored_path IS NOT NULL AND stored_path <> '')
            OR extraction_status IN ('processing', 'pending')
          )
        ORDER BY (stored_path IS NULL OR stored_path = ''), id
        LIMIT 1`
    )
    .get(contentHash, profileId) as DedupTarget | undefined;
}

function safeName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "upload"
  );
}

export function persistUploadedFile(
  profileId: number,
  docId: number,
  filename: string,
  buffer: Buffer
): string {
  const profileDir = path.join(UPLOAD_DIR, String(profileId));
  fs.mkdirSync(profileDir, { recursive: true });
  const stored = `${docId}-${safeName(filename)}`;
  fs.writeFileSync(path.join(profileDir, stored), buffer);

  const storedPath = path.join(
    "data",
    "uploads",
    "medical",
    String(profileId),
    stored
  );
  db.prepare(
    "UPDATE medical_documents SET stored_path = ? WHERE id = ? AND profile_id = ?"
  ).run(storedPath, docId, profileId);
  return storedPath;
}

export function insertDuplicateDoc(
  profileId: number,
  filename: string,
  mime: string,
  size: number,
  contentHash: string,
  originalName: string,
  originalStatus: string
): number {
  const target =
    filename === originalName
      ? "this file was already uploaded"
      : `identical contents to "${originalName}" (already uploaded)`;
  const advice =
    originalStatus === "done"
      ? "Skipped."
      : "Reprocess that document instead of re-uploading.";
  const error = `Duplicate upload — ${target}. ${advice}`;
  const info = db
    .prepare(
      `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, content_hash, extraction_status, extraction_error, uploaded_at, profile_id)
       VALUES (?,?,?,?,?, 'skipped', ?, ?, ?)`
    )
    // uploaded_at from the clock seam (#1534) — `date(uploaded_at)` is the document's
    // episode-window / Timeline day. Same seam as the primary insert in
    // lib/medical-pipeline.ts, so sibling rows can't straddle two clocks.
    .run(filename, "", mime, size, contentHash, error, sqlNow(), profileId);
  return Number(info.lastInsertRowid);
}

export function insertFailedDoc(
  profileId: number,
  filename: string,
  mime: string,
  size: number,
  error: string
): number {
  const info = db
    .prepare(
      `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, extraction_status, extraction_error, uploaded_at, profile_id)
       VALUES (?,?,?,?, 'failed', ?, ?, ?)`
    )
    // uploaded_at from the clock seam (#1534) — see insertSkippedDuplicate above.
    .run(filename, "", mime, size, error, sqlNow(), profileId);
  return Number(info.lastInsertRowid);
}
