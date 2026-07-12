// Server-side data layer for optional TOTP 2FA (issue #23). Owns the DB state
// the pure lib/totp.ts + lib/recovery-codes.ts modules deliberately don't: the
// per-login secret + enabled flag + replay-guard step (columns on `logins`), the
// one-time recovery codes (`login_recovery_codes`), and the short-lived
// second-factor login challenges (`login_totp_challenges`). All three tables are
// GLOBAL (login-owned, not profile-owned), so none are covered by the
// profile-scoping leak test. This module is server-only (uses the sync SQLite
// handle); it performs NO auth checks — callers (the login flow, the settings
// actions) own authorization and auditing.

import crypto from "node:crypto";
import { db, writeTx } from "./db";
import { base32Encode, otpauthURL, verifyTotp, TOTP_WINDOW } from "./totp";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  isRecoveryCodeShape,
} from "./recovery-codes";

// Issuer shown in the authenticator app entry.
const TOTP_ISSUER = "Allos";
// Secret length: 20 bytes = 160 bits, the SHA-1 HMAC block-friendly size the RFC
// uses and what most apps expect.
const SECRET_BYTES = 20;
// A second-factor challenge is valid for 5 minutes — long enough to open the
// authenticator, short enough that a leaked challenge cookie is near-useless.
const CHALLENGE_TTL_MIN = 5;

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export interface LoginTotpState {
  enabled: boolean;
  secret: string | null;
  lastStep: number | null;
}

// Read a login's raw 2FA state. `enabled` is the enforced flag; a secret with
// enabled=0 is a half-finished enrollment (never enforced at login).
export function getLoginTotpState(loginId: number): LoginTotpState {
  const row = db
    .prepare(
      "SELECT totp_secret AS secret, totp_enabled AS enabled, totp_last_step AS lastStep FROM logins WHERE id = ?"
    )
    .get(loginId) as
    | { secret: string | null; enabled: number; lastStep: number | null }
    | undefined;
  return {
    enabled: !!row?.enabled,
    secret: row?.secret ?? null,
    lastStep: row?.lastStep ?? null,
  };
}

// Whether 2FA is active (enforced) for a login — the gate the login flow checks
// after a correct password.
export function isTotpEnabled(loginId: number): boolean {
  return getLoginTotpState(loginId).enabled;
}

// Start (or restart) enrollment: mint a fresh secret, store it with enabled=0,
// and clear any stale replay-guard step. Returns the secret + the otpauth:// URI
// for the app to import. Overwriting a prior pending secret is intentional — a
// user who bailed mid-enrollment just gets a new one.
export function beginTotpEnrollment(
  loginId: number,
  username: string
): { secret: string; otpauthUrl: string } {
  const secret = base32Encode(crypto.randomBytes(SECRET_BYTES));
  db.prepare(
    "UPDATE logins SET totp_secret = ?, totp_enabled = 0, totp_last_step = NULL WHERE id = ?"
  ).run(secret, loginId);
  return {
    secret,
    otpauthUrl: otpauthURL({ secret, account: username, issuer: TOTP_ISSUER }),
  };
}

// Verify the first code against the PENDING secret and, on success, flip
// enabled=1 and record the used step. Returns false if there's no pending secret
// or the code is wrong. Does NOT generate recovery codes — the caller does that
// separately so it controls the show-once presentation.
export function activateTotp(
  loginId: number,
  token: string,
  timeMs: number = Date.now()
): boolean {
  const state = getLoginTotpState(loginId);
  if (!state.secret) return false;
  const res = verifyTotp(state.secret, token, {
    timeMs,
    window: TOTP_WINDOW,
    lastStep: state.lastStep,
  });
  if (!res.ok) return false;
  db.prepare(
    "UPDATE logins SET totp_enabled = 1, totp_last_step = ? WHERE id = ?"
  ).run(res.step ?? null, loginId);
  return true;
}

// Turn 2FA off completely: drop the secret, the enabled flag, the replay step,
// and every recovery code. Used by the self-service disable (after re-auth) and
// by the env-var bootstrap override.
export function disableTotp(loginId: number): void {
  writeTx(() => {
    db.prepare(
      "UPDATE logins SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?"
    ).run(loginId);
    db.prepare("DELETE FROM login_recovery_codes WHERE login_id = ?").run(
      loginId
    );
  });
}

// Replace this login's recovery codes with a fresh set and return the plaintext
// codes to show ONCE. Only the SHA-256 of each is stored.
export function regenerateRecoveryCodes(loginId: number): string[] {
  const codes = generateRecoveryCodes();
  writeTx(() => {
    db.prepare("DELETE FROM login_recovery_codes WHERE login_id = ?").run(
      loginId
    );
    const ins = db.prepare(
      "INSERT INTO login_recovery_codes (login_id, code_hash) VALUES (?, ?)"
    );
    for (const c of codes) ins.run(loginId, hashRecoveryCode(c));
  });
  return codes;
}

// How many unused recovery codes remain (shown in Settings so a user knows to
// regenerate before they run out).
export function countUnusedRecoveryCodes(loginId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM login_recovery_codes WHERE login_id = ? AND used_at IS NULL"
      )
      .get(loginId) as { n: number }
  ).n;
}

// Redeem one unused recovery code (constant work regardless of match: we hash the
// input then look for an unused row). Marks it used so it can never be reused.
// Returns true if a code was consumed.
export function consumeRecoveryCode(loginId: number, raw: string): boolean {
  if (!isRecoveryCodeShape(raw)) return false;
  const hash = hashRecoveryCode(raw);
  const info = db
    .prepare(
      "UPDATE login_recovery_codes SET used_at = datetime('now') WHERE login_id = ? AND code_hash = ? AND used_at IS NULL"
    )
    .run(loginId, hash);
  return info.changes > 0;
}

export interface TotpVerifyOutcome {
  ok: boolean;
  // True when the code redeemed was a one-time recovery code (so the caller can
  // audit it distinctly and warn the user a code was spent).
  viaRecovery: boolean;
}

// The shared second-factor check used at login step-up: try the submitted value
// as a TOTP first (recording the step on success for the replay guard), then as a
// recovery code. Returns whether it passed and by which path.
export function verifyLoginSecondFactor(
  loginId: number,
  submitted: string,
  timeMs: number = Date.now()
): TotpVerifyOutcome {
  const state = getLoginTotpState(loginId);
  if (!state.enabled || !state.secret) return { ok: false, viaRecovery: false };
  const totpRes = verifyTotp(state.secret, submitted, {
    timeMs,
    window: TOTP_WINDOW,
    lastStep: state.lastStep,
  });
  if (totpRes.ok) {
    db.prepare("UPDATE logins SET totp_last_step = ? WHERE id = ?").run(
      totpRes.step ?? null,
      loginId
    );
    return { ok: true, viaRecovery: false };
  }
  if (consumeRecoveryCode(loginId, submitted)) {
    return { ok: true, viaRecovery: true };
  }
  return { ok: false, viaRecovery: false };
}

// ---- Second-factor login challenges ----

export interface TotpChallenge {
  loginId: number;
  username: string;
  nextPath: string | null;
}

// Create a challenge for a login whose password just verified but who has 2FA on.
// Returns the RAW token (the caller sets it as the short-lived cookie); the DB
// stores only its SHA-256.
export function createTotpChallenge(
  loginId: number,
  username: string,
  nextPath: string | null
): { token: string; maxAgeSec: number } {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    `INSERT INTO login_totp_challenges (token_hash, login_id, username, next_path, created_at, expires_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now', ?))`
  ).run(
    sha256(token),
    loginId,
    username,
    nextPath,
    `+${CHALLENGE_TTL_MIN} minutes`
  );
  return { token, maxAgeSec: CHALLENGE_TTL_MIN * 60 };
}

// Resolve a raw challenge token to its login, or null if unknown/expired.
export function getTotpChallenge(rawToken: string): TotpChallenge | null {
  const row = db
    .prepare(
      `SELECT login_id AS loginId, username, next_path AS nextPath
         FROM login_totp_challenges
        WHERE token_hash = ? AND expires_at > datetime('now')`
    )
    .get(sha256(rawToken)) as TotpChallenge | undefined;
  return row ?? null;
}

// Consume (delete) a challenge — called once the second factor succeeds so the
// token can't be reused.
export function deleteTotpChallenge(rawToken: string): void {
  db.prepare("DELETE FROM login_totp_challenges WHERE token_hash = ?").run(
    sha256(rawToken)
  );
}

// Opportunistic prune of expired challenge rows, called at login alongside the
// existing expired-session/attempt prunes.
export function purgeExpiredTotpChallenges(): void {
  db.prepare(
    "DELETE FROM login_totp_challenges WHERE expires_at <= datetime('now')"
  ).run();
}

// ---- Bootstrap safety: env-var override ----

// ALLOS_DISABLE_2FA is a comma-separated list of usernames whose 2FA is bypassed
// at login (a locked-out admin who lost their authenticator can be let back in by
// the operator). Honored at LOGIN time (case-insensitive), always logged loudly
// and audited by the caller. Absent/empty → no bypass.
export function is2faBypassed(username: string): boolean {
  const raw = process.env.ALLOS_DISABLE_2FA;
  if (!raw) return false;
  const target = username.trim().toLowerCase();
  return raw
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}
