import crypto from "node:crypto";

// Pure token crypto + TTL math for the login-lifecycle auth tokens (issue #985),
// split out of lib/auth-tokens.ts (which touches the DB) so these deterministic
// helpers are unit-testable without a DB — the lib/share-token.ts precedent
// (hashShareToken split from the DB-backed lib/settings/calendar-feed). No DB, no
// network, clock injected.

export type AuthTokenKind = "invite" | "reset";

// Invites are couriered by a human admin (may sit in an inbox a day); a reset is a
// live self-service flow, so it expires fast.
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const RESET_TTL_MS = 60 * 60 * 1000; // 1h

export function ttlForKind(kind: AuthTokenKind): number {
  return kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS;
}

// SHA-256 of a raw token — the at-rest form (lib/auth's hashToken / hashShareToken
// precedent), so a DB leak yields no usable link.
export function hashAuthToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// The absolute expiry instant (ISO 8601 UTC) for a freshly minted token of `kind`.
export function authTokenExpiresAt(kind: AuthTokenKind, nowMs: number): string {
  return new Date(nowMs + ttlForKind(kind)).toISOString();
}
