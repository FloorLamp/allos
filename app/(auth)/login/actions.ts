"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { verifyPassword, hashPasswordSync } from "@/lib/password";
import {
  createSession,
  purgeExpiredSessions,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth";
import { safeNextPath, truncateUserAgent } from "@/lib/login-security";
import { TWO_FACTOR_COOKIE } from "@/lib/session-cookie";
import {
  evaluateLockout,
  USERNAME_LOCKOUT,
  GLOBAL_LOCKOUT,
  type LockoutInput,
} from "@/lib/login-lockout";
import {
  isTotpEnabled,
  is2faBypassed,
  createTotpChallenge,
  getTotpChallenge,
  deleteTotpChallenge,
  purgeExpiredTotpChallenges,
  verifyLoginSecondFactor,
} from "@/lib/two-factor";
import { createLogger } from "@/lib/log";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

const log = createLogger("login");

export interface LoginState {
  error?: string;
  // Set when the password was correct but the login has 2FA on: the form swaps to
  // the second-factor step. The intermediate state lives server-side (a challenge
  // row + short-lived cookie), NOT in a half-authenticated session.
  needsTotp?: boolean;
}

// Shared message for a failed/expired second factor — as opaque as the password
// one, so a prober learns nothing.
const INVALID_CODE = "Incorrect or expired code.";

// One message for every credential outcome — wrong password, unknown user, or
// throttled — so a prober learns nothing from the response. (The empty-field
// prompt below is not a credential check, so it stays distinct.)
const INVALID_CREDENTIALS = "Incorrect username or password.";

// A valid hash of a value no one knows, verified against when the username
// doesn't exist so an attacker can't distinguish "unknown user" from "wrong
// password" by response timing. Computed once at module load.
const DUMMY_HASH = hashPasswordSync(
  "unused-placeholder-for-constant-time-login"
);

// The sliding window both policies count over. Kept in one place so the SQL
// bound below and the policy objects agree.
const WINDOW_MIN = 15;

// Cap on the attacker-controlled strings we persist per attempt. A real username
// is 3–32 chars (USERNAME_RE in the family actions), so any submission past this
// can never match a login; capping keeps a hostile client from bloating the
// login_attempts table/index with megabyte-long usernames (the form body is not
// header-size-bounded). The ip token is likewise clamped as defense in depth.
const MAX_ATTEMPT_FIELD = 64;

function clampAttemptField(s: string): string {
  return s.length > MAX_ATTEMPT_FIELD ? s.slice(0, MAX_ATTEMPT_FIELD) : s;
}

async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}

// Turn a (count, most-recent-timestamp) pair from the DB into the pure policy's
// input. SQLite stores UTC "YYYY-MM-DD HH:MM:SS"; parse it as UTC to get the
// elapsed time. No prior failures → never locked out (Infinity since last).
function toLockoutInput(n: number, last: string | null): LockoutInput {
  if (n <= 0 || !last) {
    return { recentFailures: 0, msSinceLastFailure: Infinity };
  }
  const lastMs = Date.parse(last.replace(" ", "T") + "Z");
  const since = Number.isFinite(lastMs) ? Date.now() - lastMs : Infinity;
  return { recentFailures: n, msSinceLastFailure: Math.max(0, since) };
}

// Recent failures (count + latest time) for one username within the window.
function usernameAttempts(username: string): LockoutInput {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last
         FROM login_attempts
        WHERE username = ? AND created_at > datetime('now', ?)`
    )
    .get(username, `-${WINDOW_MIN} minutes`) as {
    n: number;
    last: string | null;
  };
  return toLockoutInput(row.n, row.last);
}

// Recent failures across ALL usernames within the window — the spray backstop.
function globalAttempts(): LockoutInput {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last
         FROM login_attempts
        WHERE created_at > datetime('now', ?)`
    )
    .get(`-${WINDOW_MIN} minutes`) as { n: number; last: string | null };
  return toLockoutInput(row.n, row.last);
}

function recordFailure(username: string, ip: string): void {
  db.prepare("INSERT INTO login_attempts (username, ip) VALUES (?, ?)").run(
    username,
    ip
  );
}

// Clear a username's attempt history after a successful login, so a legitimate
// user's past typos don't count against their next sign-in.
function clearAttempts(username: string): void {
  db.prepare("DELETE FROM login_attempts WHERE username = ?").run(username);
}

// Opportunistic prune of rows well past the window, so the table can't grow
// without bound. Retains a day (>> the 15-minute window) as a generous margin.
function pruneOldAttempts(): void {
  db.prepare(
    "DELETE FROM login_attempts WHERE created_at < datetime('now', '-1 day')"
  ).run();
}

export async function login(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(formData.get("next"));

  if (!username || !password) {
    return { error: "Enter your username and password." };
  }

  const usernameKey = clampAttemptField(username.toLowerCase());
  const ip = clampAttemptField(await clientIp());
  pruneOldAttempts();

  // Throttle BEFORE the (deliberately expensive) scrypt verify, keyed primarily
  // on the username with a coarser global cap as a spray backstop. A throttled
  // attempt is still recorded, so persistent hammering keeps extending its own
  // backoff — but we skip the hash work, so it can't be used as a CPU-DoS lever.
  const userDecision = evaluateLockout(
    usernameAttempts(usernameKey),
    USERNAME_LOCKOUT
  );
  const globalDecision = evaluateLockout(globalAttempts(), GLOBAL_LOCKOUT);
  if (userDecision.lockedOut || globalDecision.lockedOut) {
    recordFailure(usernameKey, ip);
    // Audit the throttle (username only — NEVER the password).
    recordAudit({ action: AUDIT_ACTIONS.loginThrottled, detail: usernameKey });
    log.warn("login throttled", {
      username: usernameKey,
      ip,
      scope: userDecision.lockedOut ? "username" : "global",
      retryAfterMs: Math.max(
        userDecision.retryAfterMs,
        globalDecision.retryAfterMs
      ),
    });
    return { error: INVALID_CREDENTIALS };
  }

  const loginRow = db
    .prepare(
      "SELECT id, password_hash FROM logins WHERE username = ? COLLATE NOCASE"
    )
    .get(username) as { id: number; password_hash: string } | undefined;

  // Always run a verification (against the dummy hash for unknown users) so the
  // timing doesn't reveal whether the username exists.
  const ok = await verifyPassword(
    password,
    loginRow?.password_hash ?? DUMMY_HASH
  );
  if (!loginRow || !ok) {
    recordFailure(usernameKey, ip);
    // Audit the failed attempt (username only — NEVER the password).
    recordAudit({ action: AUDIT_ACTIONS.loginFailure, detail: usernameKey });
    return { error: INVALID_CREDENTIALS };
  }

  // Password OK. If the login has 2FA enabled, DON'T mint a session yet — go to
  // the second-factor step (unless the operator has bypassed this username via the
  // ALLOS_DISABLE_2FA env var, the documented bootstrap-recovery escape hatch).
  if (isTotpEnabled(loginRow.id)) {
    if (is2faBypassed(username)) {
      // Loud + audited: an admin explicitly disabled 2FA for this login to recover
      // access. Never silent.
      log.warn("2FA bypassed via ALLOS_DISABLE_2FA env override", {
        username: usernameKey,
      });
      recordAudit({
        loginId: loginRow.id,
        action: AUDIT_ACTIONS.twofaBypass,
        detail: usernameKey,
      });
      // fall through to mint the session below
    } else {
      // Correct password consumed the prior failures? No — hold the throttle open
      // across the 2FA window. Create the challenge, set the short-lived cookie, and
      // hand the form off to the second-factor step. No session exists yet.
      purgeExpiredTotpChallenges();
      const { token: chalToken, maxAgeSec } = createTotpChallenge(
        loginRow.id,
        usernameKey,
        next
      );
      (await cookies()).set(
        TWO_FACTOR_COOKIE,
        chalToken,
        sessionCookieOptions(maxAgeSec)
      );
      return { needsTotp: true };
    }
  }

  // Success: forget this username's failures and mint the session.
  clearAttempts(usernameKey);
  purgeExpiredSessions();
  const userAgent = truncateUserAgent((await headers()).get("user-agent"));
  const { token, maxAgeSec } = createSession(loginRow.id, userAgent);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(maxAgeSec));
  recordAudit({
    loginId: loginRow.id,
    action: AUDIT_ACTIONS.loginSuccess,
    detail: usernameKey,
  });

  redirect(next);
}

// Second-factor step (issue #23): completes a login that stopped at the 2FA gate.
// Reads the short-lived challenge cookie set by login(), verifies the submitted
// TOTP (or a one-time recovery code) — rate-limited through the SAME lockout
// machinery as passwords — and only then mints the real session. A missing/expired
// challenge sends the user back to the password step.
export async function verifyLoginTotp(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const code = String(formData.get("code") ?? "").trim();
  const rawChallenge = (await cookies()).get(TWO_FACTOR_COOKIE)?.value;
  if (!rawChallenge) {
    // No challenge in flight — bounce back to the password form.
    return { error: "Your sign-in session expired. Please start again." };
  }
  const challenge = getTotpChallenge(rawChallenge);
  if (!challenge) {
    (await cookies()).delete(TWO_FACTOR_COOKIE);
    return { error: "Your sign-in session expired. Please start again." };
  }

  const usernameKey = clampAttemptField(challenge.username.toLowerCase());
  const ip = clampAttemptField(await clientIp());
  pruneOldAttempts();

  // Reuse the password throttle so brute-forcing a 6-digit code is bounded (and a
  // throttled attempt still records, extending its own backoff).
  const userDecision = evaluateLockout(
    usernameAttempts(usernameKey),
    USERNAME_LOCKOUT
  );
  const globalDecision = evaluateLockout(globalAttempts(), GLOBAL_LOCKOUT);
  if (userDecision.lockedOut || globalDecision.lockedOut) {
    recordFailure(usernameKey, ip);
    recordAudit({ action: AUDIT_ACTIONS.loginThrottled, detail: usernameKey });
    return { error: INVALID_CODE, needsTotp: true };
  }

  if (!code)
    return { error: "Enter your authenticator code.", needsTotp: true };

  const outcome = verifyLoginSecondFactor(challenge.loginId, code);
  if (!outcome.ok) {
    recordFailure(usernameKey, ip);
    recordAudit({
      loginId: challenge.loginId,
      action: AUDIT_ACTIONS.twofaFailure,
      detail: usernameKey,
    });
    return { error: INVALID_CODE, needsTotp: true };
  }

  // Second factor passed — tear down the challenge, clear its cookie, mint the
  // session, and audit (recovery-code use is recorded distinctly so a spent code
  // is visible in the trail).
  deleteTotpChallenge(rawChallenge);
  (await cookies()).delete(TWO_FACTOR_COOKIE);
  clearAttempts(usernameKey);
  purgeExpiredSessions();
  const userAgent = truncateUserAgent((await headers()).get("user-agent"));
  const { token, maxAgeSec } = createSession(challenge.loginId, userAgent);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(maxAgeSec));
  if (outcome.viaRecovery) {
    recordAudit({
      loginId: challenge.loginId,
      action: AUDIT_ACTIONS.twofaRecoveryUsed,
      detail: usernameKey,
    });
  }
  recordAudit({
    loginId: challenge.loginId,
    action: AUDIT_ACTIONS.loginSuccess,
    detail: usernameKey,
  });

  redirect(safeNextPath(challenge.nextPath));
}
