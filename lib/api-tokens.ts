import { db, hoistedStatement, writeTx } from "./db";
import { hashPassword, verifyPassword } from "./password";
import type { Role, SessionLogin } from "./auth";
import {
  formatApiToken,
  generateApiTokenSecret,
  isApiTokenScope,
  parseApiToken,
  parseBearerHeader,
  scopeSatisfies,
  type ApiTokenScope,
} from "./api-token-format";

// API tokens (issue #1734) — the DB half of login-tied, capability-scoped bearer
// credentials, plus the ONE request-side helper every bearer route authenticates
// through. The pure vocabulary/wire-format/scope decisions live in
// lib/api-token-format.ts; nothing here re-implements them.
//
// ── WHAT THIS MODULE IS, AND IS NOT ──────────────────────────────────────────
//
// authenticateApiToken() AUTHENTICATES. It answers "which login is calling, and does
// its token carry the capability this endpoint demands?" — and stops there. It never
// answers "may that login write to profile N": that is AUTHORIZATION, it is
// profile-shaped, and it belongs to the calling route, which composes the same
// explicit write gate app/share-target/route.ts documents:
//
//     isDemoRestricted(isDemoMode(), login.role) ||
//     accessForProfile(login.id, login.role, profileId) !== "write"
//
// Keeping the two apart is the point of the whole design. A token is a way to PRESENT
// a login, not a way to be exempt from what that login may do. Authorization is
// DERIVED per request from the login's current role + login_profiles grants, never
// frozen onto the token row, so revoking a member's grant instantly revokes it from
// every token they hold.
//
// ── SECRECY ──────────────────────────────────────────────────────────────────
//
// The plaintext token exists in exactly two places for exactly two moments: the mint
// return value (shown once by the UI) and the inbound Authorization header. It is
// NEVER stored (only its scrypt hash is), NEVER returned by any list/read function,
// and NEVER logged — not by this module, and not by its callers, which log the token
// ID and login ID only. The failure results below carry generic messages for the same
// reason: nothing echoes back the credential that was presented.
//
// ── COST / DoS NOTE ──────────────────────────────────────────────────────────
//
// Verification is scrypt (~100ms of CPU and 64MB of memory per attempt, off-thread on
// libuv's pool via lib/password.ts's async helpers). That is deliberate against
// offline cracking, and it means an unauthenticated caller can make the server do real
// work. Every bearer ROUTE must therefore rate-limit BEFORE calling this helper —
// keyed on the presented credential's id, never its secret — exactly as
// app/api/integrations/health-connect/ingest does. The limiter lives at the route so
// each endpoint can size its own budget.

// A token as shown in the management UI. Carries no secret material of any kind —
// not the hash, not a prefix of the plaintext.
export interface ApiTokenSummary {
  id: number;
  loginId: number;
  // The owning login's username — the admin view lists every login's tokens.
  username: string;
  name: string;
  scope: ApiTokenScope;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TokenRow {
  id: number;
  loginId: number;
  username: string;
  name: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const LIST_COLUMNS = `t.id AS id, t.login_id AS loginId, a.username AS username,
                      t.name AS name, t.scope AS scope,
                      t.created_at AS createdAt, t.last_used_at AS lastUsedAt`;

const LIST_FOR_LOGIN_STMT = hoistedStatement(
  `SELECT ${LIST_COLUMNS}
     FROM api_tokens t JOIN logins a ON a.id = t.login_id
    WHERE t.login_id = ? AND t.revoked_at IS NULL
    ORDER BY t.id DESC`
);

const LIST_ALL_STMT = hoistedStatement(
  `SELECT ${LIST_COLUMNS}
     FROM api_tokens t JOIN logins a ON a.id = t.login_id
    WHERE t.revoked_at IS NULL
    ORDER BY t.id DESC`
);

// A revoked row is a TOMBSTONE, never shown: it stays only so its id is permanently
// spent and can't be re-minted onto. Both listings therefore filter revoked_at IS NULL,
// which is also what makes "revoke → gone from the list" true immediately.
function toSummary(row: TokenRow): ApiTokenSummary {
  return {
    id: row.id,
    loginId: row.loginId,
    username: row.username,
    name: row.name,
    // A stored scope always satisfies the column's CHECK, so this narrowing can't
    // fail in practice; fall back to the v1 scope rather than throwing in a listing.
    scope: isApiTokenScope(row.scope) ? row.scope : "upload:documents",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

// The caller's own live tokens (the member view).
export function listApiTokensForLogin(loginId: number): ApiTokenSummary[] {
  return (LIST_FOR_LOGIN_STMT.all(loginId) as TokenRow[]).map(toSummary);
}

// Every live token on the instance (the admin view). Admins already administer
// logins and grants, so seeing which credentials exist — names and last-used stamps,
// never secrets — is the same class of visibility.
export function listAllApiTokens(): ApiTokenSummary[] {
  return (LIST_ALL_STMT.all() as TokenRow[]).map(toSummary);
}

const ANY_LIVE_WITH_SCOPE_STMT = hoistedStatement(
  "SELECT 1 AS one FROM api_tokens WHERE scope = ? AND revoked_at IS NULL LIMIT 1"
);

// Does the instance hold ANY live token with this capability? A bare boolean — no id,
// no name, no owning login, not even a count — which is what keeps it safe to answer
// for a viewer who may not list the tokens themselves.
//
// It exists for the guided Patient portals page (#1826): the setup stage "the tool has
// no way to push anything in yet" turns on this and nothing else. The question is
// deliberately INSTANCE-wide rather than per-login, because the token belongs to the
// COMPUTER that runs the companion tool — often a different person's machine — so "do
// you personally hold one?" would strand a caregiver on the token card forever.
export function anyApiTokenWithScope(scope: ApiTokenScope): boolean {
  return ANY_LIVE_WITH_SCOPE_STMT.get(scope) !== undefined;
}

export interface MintedApiToken {
  id: number;
  // The full `<id>.<secret>` wire value. Returned exactly once, by this call, and
  // never recoverable afterwards.
  token: string;
}

// How many live tokens one login may hold. A soft sanity bound, not a security
// control: it keeps a runaway client (or a bored user) from filling the table, and
// each mint costs a scrypt hash.
export const MAX_TOKENS_PER_LOGIN = 20;

const COUNT_FOR_LOGIN_STMT = hoistedStatement(
  "SELECT COUNT(*) AS n FROM api_tokens WHERE login_id = ? AND revoked_at IS NULL"
);

export function countApiTokensForLogin(loginId: number): number {
  return (COUNT_FOR_LOGIN_STMT.get(loginId) as { n: number }).n;
}

// Mint a token for a login. Async because the scrypt hash must not block the request
// thread (lib/password.ts's request-path rule). Returns the plaintext ONCE; after this
// call the instance holds only the hash.
//
// The INSERT runs inside writeTx: minting a credential is an access-control-shaped
// write, so the count check and the insert observe one snapshot and the cap can't be
// raced past by two concurrent mints.
export async function createApiToken(
  loginId: number,
  name: string,
  scope: ApiTokenScope
): Promise<MintedApiToken> {
  const secret = generateApiTokenSecret();
  const secretHash = await hashPassword(secret);
  const id = writeTx((): number => {
    const info = db
      .prepare(
        `INSERT INTO api_tokens (login_id, name, scope, secret_hash, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .run(loginId, name, scope, secretHash);
    return Number(info.lastInsertRowid);
  });
  return { id, token: formatApiToken(id, secret) };
}

// Revoke a token. An access-control transition, so it is a COMPARE-AND-SWAP rather
// than a last-write-wins update: the row flips to revoked only if it is still live,
// and the boolean says whether THIS call is the one that revoked it. A second
// concurrent revoke (two tabs, a double-click) reports false instead of both claiming
// success and re-stamping the timestamp.
//
// Scoping is part of the statement, not a prior read: a member may only ever revoke a
// token whose login_id is their own. An admin — who can already delete the whole login
// — may revoke any token, so the ownership predicate is dropped for that role only.
export function revokeApiToken(
  tokenId: number,
  actorLoginId: number,
  actorRole: Role
): boolean {
  const changes =
    actorRole === "admin"
      ? db
          .prepare(
            "UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL"
          )
          .run(tokenId).changes
      : db
          .prepare(
            `UPDATE api_tokens SET revoked_at = datetime('now')
              WHERE id = ? AND login_id = ? AND revoked_at IS NULL`
          )
          .run(tokenId, actorLoginId).changes;
  return changes > 0;
}

// Drop every token belonging to a login. The FK is ON DELETE CASCADE, but deleteLogin
// deletes its siblings (sessions, grants, settings, auth tokens) explicitly so the
// teardown holds even with foreign_keys off — this keeps api_tokens in that same
// footprint rather than relying on the cascade alone.
export function deleteApiTokensForLogin(loginId: number): void {
  db.prepare("DELETE FROM api_tokens WHERE login_id = ?").run(loginId);
}

// ── Request path ─────────────────────────────────────────────────────────────

export type ApiTokenAuth =
  | {
      ok: true;
      // The authenticated login, in the same shape a cookie session carries — so the
      // route can hand it straight to accessForProfile/isDemoRestricted.
      login: SessionLogin;
      tokenId: number;
      scope: ApiTokenScope;
    }
  | { ok: false; status: 401 | 403; error: string };

const RESOLVE_STMT = hoistedStatement(
  `SELECT t.id AS id, t.secret_hash AS secretHash, t.scope AS scope,
          t.revoked_at AS revokedAt,
          a.id AS loginId, a.username AS username, a.role AS role
     FROM api_tokens t JOIN logins a ON a.id = t.login_id
    WHERE t.id = ?`
);

const TOUCH_STMT = hoistedStatement(
  "UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?"
);

// Authenticate an inbound request's bearer token and require a capability.
//
// Every refusal below answers with the SAME generic message for the same status, so
// nothing here is an oracle: "unknown id", "wrong secret", and "revoked" are
// indistinguishable to the caller. A scope mismatch is a distinct 403 on purpose —
// the caller demonstrably holds a valid credential at that point, so telling them
// their token lacks the capability reveals nothing they don't already know and turns
// an impossible-to-debug 401 into an actionable error.
//
// The revoked check is a read of the CURRENT row on every request, which is what makes
// revocation immediate: there is no cached token state anywhere.
export async function authenticateApiToken(
  req: Request,
  demanded: ApiTokenScope
): Promise<ApiTokenAuth> {
  const unauthorized = {
    ok: false,
    status: 401,
    error: "invalid or missing API token",
  } as const;

  const parsed = parseApiToken(
    parseBearerHeader(req.headers.get("authorization"))
  );
  // Malformed or absent — refused without touching the database, so a header flood
  // costs nothing.
  if (!parsed) return unauthorized;

  const row = RESOLVE_STMT.get(parsed.id) as
    | {
        id: number;
        secretHash: string;
        scope: string;
        revokedAt: string | null;
        loginId: number;
        username: string;
        role: Role;
      }
    | undefined;
  if (!row || row.revokedAt) return unauthorized;

  // Constant-time comparison lives inside verifyPassword (timingSafeEqual over the
  // derived key), and a malformed stored hash verifies false rather than throwing.
  const valid = await verifyPassword(parsed.secret, row.secretHash);
  if (!valid) return unauthorized;

  if (!isApiTokenScope(row.scope) || !scopeSatisfies(row.scope, demanded)) {
    return {
      ok: false,
      status: 403,
      error: `this token does not carry the "${demanded}" capability`,
    };
  }

  // Last-used is stamped only after a FULLY successful authentication, so the column
  // reads as "when did this credential actually work" rather than "when was this id
  // last guessed at". Unthrottled: these are low-frequency, human-driven calls, and an
  // accurate stamp is the whole point of showing it in the management UI.
  TOUCH_STMT.run(row.id);

  return {
    ok: true,
    login: { id: row.loginId, username: row.username, role: row.role },
    tokenId: row.id,
    scope: row.scope,
  };
}
