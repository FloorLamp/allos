import crypto from "node:crypto";
import { db, writeTx } from "./db";
import {
  authTokenExpiresAt,
  hashAuthToken,
  type AuthTokenKind,
} from "./auth-token-crypto";

// Single-use, hash-at-rest auth tokens (issue #985) backing the two login-lifecycle
// flows: an INVITE link (admin creates a login → the person sets their own password)
// and a self-service password RESET. This module is AUTH-BLIND — it takes a loginId,
// never imports lib/auth, and holds no gate (the calling Server Actions own auth).
// The pure crypto/TTL helpers live in lib/auth-token-crypto (unit-tested without a
// DB); this module owns the row operations.
//
// Security posture (decided in the issue):
//   • Only the SHA-256 of the raw token is stored (the session-token / share-link
//     precedent), so a DB leak yields no usable link.
//   • Single-use: consuming a token stamps consumed_at in ONE atomic UPDATE ...
//     RETURNING guarded on `consumed_at IS NULL`, so two concurrent redemptions can
//     never both win.
//   • TTL: an absolute expires_at, checked in the same consume statement — an
//     expired-but-unconsumed token is inert.
//   • A password change invalidates every outstanding token for that login
//     (invalidateAuthTokensForLogin), so a leaked-but-unused link dies on reset.

// Re-exported so existing importers keep resolving these from lib/auth-tokens.
export {
  authTokenExpiresAt,
  hashAuthToken,
  ttlForKind,
  INVITE_TTL_MS,
  RESET_TTL_MS,
  type AuthTokenKind,
} from "./auth-token-crypto";

interface TokenRow {
  loginId: number;
  kind: AuthTokenKind;
}

// Mint a token for `loginId`, store its hash + absolute expiry, and return the RAW
// token exactly once (for building the link — never stored, so it can't be shown
// again). Minting a new token of a kind retires any prior UNCONSUMED token of the
// same kind for that login, so only the latest link is live (a re-sent invite kills
// the old one). Also opportunistically purges globally-dead rows (consumed or
// expired) to keep the table from accumulating.
export function createAuthToken(
  loginId: number,
  kind: AuthTokenKind,
  nowMs: number = Date.now()
): string {
  const raw = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashAuthToken(raw);
  const expiresAt = authTokenExpiresAt(kind, nowMs);
  writeTx(() => {
    db.prepare(
      "DELETE FROM login_auth_tokens WHERE consumed_at IS NOT NULL OR datetime(expires_at) <= datetime('now')"
    ).run();
    db.prepare(
      "DELETE FROM login_auth_tokens WHERE login_id = ? AND kind = ? AND consumed_at IS NULL"
    ).run(loginId, kind);
    db.prepare(
      "INSERT INTO login_auth_tokens (login_id, kind, token_hash, expires_at) VALUES (?, ?, ?, ?)"
    ).run(loginId, kind, tokenHash, expiresAt);
  });
  return raw;
}

// Atomically consume a token: stamp consumed_at and return {loginId, kind}, or null
// if the token is unknown, already consumed, or expired. Single-use is guaranteed by
// the `consumed_at IS NULL` guard on the UPDATE — a lost race matches zero rows and
// returns null. Expiry is checked in the same statement so there is no TOCTOU gap.
export function consumeAuthToken(rawToken: string): TokenRow | null {
  if (!rawToken) return null;
  const row = db
    .prepare(
      `UPDATE login_auth_tokens
          SET consumed_at = datetime('now')
        WHERE token_hash = ?
          AND consumed_at IS NULL
          AND datetime(expires_at) > datetime('now')
      RETURNING login_id AS loginId, kind`
    )
    .get(hashAuthToken(rawToken)) as TokenRow | undefined;
  return row ?? null;
}

// Resolve a token WITHOUT consuming it — for the set-password page to render the
// right heading (invite vs reset) and detect an invalid/expired link before showing
// the form. Applies the same unconsumed + unexpired gate as consume.
export function peekAuthToken(rawToken: string): TokenRow | null {
  if (!rawToken) return null;
  const row = db
    .prepare(
      `SELECT login_id AS loginId, kind
         FROM login_auth_tokens
        WHERE token_hash = ?
          AND consumed_at IS NULL
          AND datetime(expires_at) > datetime('now')`
    )
    .get(hashAuthToken(rawToken)) as TokenRow | undefined;
  return row ?? null;
}

// Drop every token for a login — called when the password changes (reset/invite
// completion, admin reset), so any other outstanding link for that login dies at
// once (#985 security posture: tokens invalidated by any password change).
export function invalidateAuthTokensForLogin(loginId: number): void {
  db.prepare("DELETE FROM login_auth_tokens WHERE login_id = ?").run(loginId);
}

// Resolve a login id by email (NOCASE, unique-if-set), or null. Used by the reset
// request path; the caller answers enumeration-safely regardless of the result.
export function findLoginIdByEmail(email: string): number | null {
  const e = email.trim();
  if (!e) return null;
  const row = db
    .prepare("SELECT id FROM logins WHERE email = ? COLLATE NOCASE")
    .get(e) as { id: number } | undefined;
  return row?.id ?? null;
}
