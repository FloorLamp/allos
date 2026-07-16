import crypto from "node:crypto";
import { db } from "./db";
import { serializeShareFields, type ShareField } from "./share-links";
import { hashShareToken } from "./share-token";

// DB read/write for the passport share links. The pure logic
// (validity, scope, hashing) lives in lib/share-links.ts; this is the thin data
// layer. Every profile-owned query is scoped by profile_id — EXCEPT
// getShareLinkByToken, the single unauthenticated entry point, which must look up
// by the unguessable token's hash (the caller has no profile yet); the returned
// row's profile_id then scopes all downstream reads. That exception is registered
// in lib/__tests__/profile-scoping.test.ts.

export interface ShareLinkRow {
  id: number;
  profile_id: number;
  // 'passport' (the pre-existing behavior) or 'episode' (issue #801). The row shape
  // is shared; only the resolver differs — passport reads `fields`, an episode link
  // reads `episode_id` (#856, the stable anchor) with `episode_situation` +
  // `episode_anchor` as a graceful fallback, and re-derives the range at view time.
  kind: "passport" | "episode";
  fields: string; // JSON array (parse with parseShareFields) — '[]' for episode links
  episode_id: number | null; // #856: the stable episode row id (kind='episode')
  episode_situation: string | null; // set for kind='episode' (fallback resolver)
  episode_anchor: string | null; // a date INSIDE the shared episode (fallback resolver)
  expires_at: string; // ISO 8601 UTC
  revoked_at: string | null; // ISO 8601 UTC, or null
  created_at: string;
}

const COLS =
  "id, profile_id, kind, fields, episode_id, episode_situation, episode_anchor, " +
  "expires_at, revoked_at, created_at";

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

// Create an ILLNESS-EPISODE share link (issue #801), returning the RAW token once.
// The link pins the situation + an anchor date inside the episode; the range itself is
// re-derived at view time (episodeContainingDate), so an ongoing episode keeps growing.
// `fields` is stored empty ('[]') — an episode link scopes a single episode, not a set
// of passport sections. Rides the same profile_share_links table / token machinery.
export function createEpisodeShareLink(
  profileId: number,
  createdBy: number | null,
  situation: string,
  anchor: string | null,
  expiresAtISO: string,
  episodeId: number | null
): { id: number; token: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const info = db
    .prepare(
      `INSERT INTO profile_share_links
         (profile_id, token_hash, kind, fields, episode_id, episode_situation,
          episode_anchor, expires_at, created_by)
       VALUES (?, ?, 'episode', '[]', ?, ?, ?, ?, ?)`
    )
    .run(
      profileId,
      hashShareToken(token),
      episodeId,
      situation,
      anchor,
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
