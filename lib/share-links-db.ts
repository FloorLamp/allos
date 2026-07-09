import crypto from "node:crypto";
import { db } from "./db";
import { serializeShareFields, type ShareField } from "./share-links";
import { hashShareToken } from "./share-token";

// DB read/write for the passport share links (issue #105). The pure logic
// (validity, scope, hashing) lives in lib/share-links.ts; this is the thin data
// layer. Every profile-owned query is scoped by profile_id — EXCEPT
// getShareLinkByToken, the single unauthenticated entry point, which must look up
// by the unguessable token's hash (the caller has no profile yet); the returned
// row's profile_id then scopes all downstream reads. That exception is registered
// in lib/__tests__/profile-scoping.test.ts.

export interface ShareLinkRow {
  id: number;
  profile_id: number;
  fields: string; // JSON array (parse with parseShareFields)
  expires_at: string; // ISO 8601 UTC
  revoked_at: string | null; // ISO 8601 UTC, or null
  created_at: string;
}

const COLS = "id, profile_id, fields, expires_at, revoked_at, created_at";

// Create a share link for a profile and return the RAW token (shown to the
// creator once; never stored). token_hash is a SHA-256 of a random 256-bit value.
export function createShareLink(
  profileId: number,
  createdBy: number | null,
  fields: readonly ShareField[],
  expiresAtISO: string
): { id: number; token: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const info = db
    .prepare(
      `INSERT INTO profile_share_links
         (profile_id, token_hash, fields, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      profileId,
      hashShareToken(token),
      serializeShareFields(fields),
      expiresAtISO,
      createdBy
    );
  return { id: Number(info.lastInsertRowid), token };
}

// A profile's share links, newest first (for the management UI).
export function listShareLinks(profileId: number): ShareLinkRow[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM profile_share_links
       WHERE profile_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(profileId) as ShareLinkRow[];
}

// Revoke a link (idempotent). Scoped by profile_id AND id, so a login can only
// revoke a link belonging to the profile it's acting as. Returns true if a row
// was actually revoked.
export function revokeShareLink(profileId: number, id: number): boolean {
  const res = db
    .prepare(
      `UPDATE profile_share_links SET revoked_at = ?
       WHERE id = ? AND profile_id = ? AND revoked_at IS NULL`
    )
    .run(new Date().toISOString(), id, profileId);
  return res.changes > 0;
}

// Look up a link by its raw token (the ONLY entry point for the public share
// route). Constant-work: we hash the caller-supplied token and match the indexed
// token_hash column — the attacker controls only the raw token, never the hash,
// and the DB never returns a row for a non-matching hash, so there is no
// value-dependent timing on the secret. Returns undefined for any miss.
export function getShareLinkByToken(token: string): ShareLinkRow | undefined {
  if (!token) return undefined;
  return db
    .prepare(`SELECT ${COLS} FROM profile_share_links WHERE token_hash = ?`)
    .get(hashShareToken(token)) as ShareLinkRow | undefined;
}
