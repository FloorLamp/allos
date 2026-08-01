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

// WHAT "ALLOS HOLDS THESE BYTES" MEANS, in one place.
//
// A document row is not automatically a held document: the engine also lands MARKER rows
// that carry a content hash but no file — the 'skipped' duplicate marker and the
// 'failed' rejection. Those must never count as held, or a client diffing against the
// inventory (#1776) would conclude allos has a document it does not, and stop sending
// it forever.
//
// The in-flight case is the subtle one and is deliberately included: a row still
// 'processing'/'pending' has no stored_path yet but its bytes ARE on their way, so
// treating it as not-held would let a second upload of the same file race in beside it.
//
// Shared verbatim by the dedup probe and the inventory list, so "what does allos hold"
// can never mean two different things on the two paths that ask it.
const HELD_PREDICATE = `(
            (stored_path IS NOT NULL AND stored_path <> '')
            OR extraction_status IN ('processing', 'pending')
          )`;

export function findDedupTarget(
  profileId: number,
  contentHash: string
): DedupTarget | undefined {
  return db
    .prepare(
      `SELECT id, filename, extraction_status AS status, stored_path
         FROM medical_documents
        WHERE content_hash = ? AND profile_id = ?
          AND ${HELD_PREDICATE}
        ORDER BY (stored_path IS NULL OR stored_path = ''), id
        LIMIT 1`
    )
    .get(contentHash, profileId) as DedupTarget | undefined;
}

// Every content hash this profile currently HOLDS — the `held` half of #1776's inventory
// answer, and nothing else reads it.
//
// DISTINCT because a hash can legitimately appear on several rows (the original plus a
// later duplicate marker), and the inventory is a SET question: the client asks "do you
// have these bytes", not "how many rows mention them". Sorted so the response is stable
// across calls, which makes a client's own diff/caching honest.
//
// Profile-scoped like every other document read; the endpoint additionally authorizes
// the profile before calling.
export function heldDocumentHashes(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT content_hash AS hash
           FROM medical_documents
          WHERE profile_id = ?
            AND content_hash IS NOT NULL AND content_hash <> ''
            AND ${HELD_PREDICATE}
          ORDER BY content_hash`
      )
      .all(profileId) as { hash: string }[]
  ).map((r) => r.hash);
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
  originalStatus: string,
  // Acquired-by provenance (#1748) — NULL on every human path. A duplicate marker
  // carries it too: "the portal pushed this again" is exactly the fact a reviewer
  // comparing two portals wants to read off the row.
  acquiredPortalId: number | null = null
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
      `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, content_hash, extraction_status, extraction_error, uploaded_at, profile_id, acquired_portal_id)
       VALUES (?,?,?,?,?, 'skipped', ?, ?, ?, ?)`
    )
    // uploaded_at from the clock seam (#1534) — `date(uploaded_at)` is the document's
    // episode-window / Timeline day. Same seam as the primary insert in
    // lib/medical-pipeline.ts, so sibling rows can't straddle two clocks.
    .run(
      filename,
      "",
      mime,
      size,
      contentHash,
      error,
      sqlNow(),
      profileId,
      acquiredPortalId
    );
  return Number(info.lastInsertRowid);
}

export function insertFailedDoc(
  profileId: number,
  filename: string,
  mime: string,
  size: number,
  error: string,
  // Acquired-by provenance (#1748) — see insertDuplicateDoc. A portal upload that was
  // refused for its type or size still records where it came from, so Review can show
  // that the tool is pushing something allos will not take.
  acquiredPortalId: number | null = null
): number {
  const info = db
    .prepare(
      `INSERT INTO medical_documents (filename, stored_path, mime_type, size_bytes, extraction_status, extraction_error, uploaded_at, profile_id, acquired_portal_id)
       VALUES (?,?,?,?, 'failed', ?, ?, ?, ?)`
    )
    // uploaded_at from the clock seam (#1534) — see insertSkippedDuplicate above.
    .run(
      filename,
      "",
      mime,
      size,
      error,
      sqlNow(),
      profileId,
      acquiredPortalId
    );
  return Number(info.lastInsertRowid);
}
