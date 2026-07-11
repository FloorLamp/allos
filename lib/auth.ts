import { cache } from "react";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { recordAudit } from "./audit";
import { AUDIT_ACTIONS } from "./audit-actions";
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from "./session-cookie";
import { isDemoMode, isDemoRestricted } from "./demo";

// Re-exported so existing importers (the login action, etc.) keep resolving the
// cookie name from lib/auth. The single source of truth is lib/session-cookie.ts,
// which is dependency-free so the Edge middleware can import it too (issue #21).
export { SESSION_COOKIE };

// Session/auth layer for the single-tenant → multi-user conversion.
// The cookie holds a random 256-bit token; the DB stores only its
// SHA-256, so a DB leak can't be replayed as a live cookie. The active profile
// lives server-side on the session row, never in the cookie.
//
// CSRF: no separate token is needed. State-changing requests go through Server
// Actions (Next enforces an Origin/Host match on POST) or through
// token-authenticated API handlers (Health Connect ingest, Telegram webhook);
// the only cookie-authenticated handlers are GET-only downloads/streams, which a
// cross-site form can't meaningfully forge. The cookie is httpOnly + SameSite=Lax.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_TTL_SEC = SESSION_TTL_MS / 1000;

// Absolute session ceiling (issue #23). The 30-day expiry is SLIDING — every use
// re-extends expires_at — so an active session otherwise never dies. This is the
// hard cap measured from created_at: regardless of how recently the session was
// used, once it is this old it stops resolving and the user must re-authenticate
// (password + 2FA). Enforced in the session lookup and the purge, so a session
// past the cap is dead everywhere at once.
const SESSION_ABSOLUTE_MAX_DAYS = 90;
const SESSION_ABSOLUTE_MAX_MODIFIER = `-${SESSION_ABSOLUTE_MAX_DAYS} days`;

export type Role = "admin" | "member";
// The access LEVEL a login holds on the profile it is currently acting as
// (issue #33). 'write' is the historical all-or-nothing behavior (read + edit);
// 'read' is view-only, enforced server-side by requireWriteAccess(). Admins are
// always 'write' (they bypass grants). Any stored value other than 'read' reads
// back as 'write', so a NULL/legacy grant defaults to the permissive historical
// behavior — never accidentally locking a member out.
export type Access = "read" | "write";
export interface SessionLogin {
  id: number;
  username: string;
  role: Role;
}
export interface SessionProfile {
  id: number;
  name: string;
  // Optional avatar: relative on-disk path (null = no photo) and a version that
  // bumps on every change, used as the ?v= cache-buster on the serve URL.
  photo_path: string | null;
  photo_version: number;
}
export interface CurrentSession {
  login: SessionLogin;
  profile: SessionProfile;
  // The caller's access level on `profile` — 'write' unless the active profile is
  // shared with this member as a read-only grant. Admins are always 'write'.
  access: Access;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Cookie attributes shared by the login action and the middleware refresh, so
// the sliding re-set can't drift from the original. `secure` only in prod so the
// cookie still works over plain HTTP in local dev — and it's the SAME flag that
// picks the `__Host-` cookie name (SESSION_COOKIE_SECURE in lib/session-cookie),
// so the name never disagrees with the Secure attribute the prefix requires. The
// `__Host-` prefix additionally mandates Path=/ and no Domain, both satisfied here.
export function sessionCookieOptions(maxAgeSec: number = SESSION_TTL_SEC) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: maxAgeSec,
  };
}

// Prepared statements hoisted to module scope — these run on effectively every
// request (getCurrentSession → accessibleProfiles), so prepare them once. `db` is
// created + migrated eagerly at import (lib/db.ts), so it's ready here.
const PROFILES_ALL_STMT = db.prepare(
  "SELECT id, name, photo_path, photo_version FROM profiles ORDER BY id"
);
const PROFILES_FOR_LOGIN_STMT = db.prepare(
  `SELECT p.id, p.name, p.photo_path, p.photo_version FROM profiles p
     JOIN login_profiles ap ON ap.profile_id = p.id
    WHERE ap.login_id = ?
    ORDER BY p.id`
);

// The profiles a login may act as: admins see every profile; members see only
// their granted ones. Ordered by id so "first accessible" is stable.
function accessibleProfiles(loginId: number, role: Role): SessionProfile[] {
  if (role === "admin") {
    return PROFILES_ALL_STMT.all() as SessionProfile[];
  }
  return PROFILES_FOR_LOGIN_STMT.all(loginId) as SessionProfile[];
}

const GRANT_ACCESS_STMT = db.prepare(
  "SELECT access FROM login_profiles WHERE login_id = ? AND profile_id = ?"
);

// The access level a login holds on a specific profile. Admins are implicit
// all-write, so they always resolve to 'write' (no grant row needed). For a
// member the value comes from the grant row; anything other than the exact
// string 'read' — a missing row, a NULL, a legacy/unknown value — reads as
// 'write', so a grant can only ever be RESTRICTED by an explicit 'read', never
// silently by data drift. Callers must have already confirmed the profile is
// accessible (getCurrentSession does).
export function accessForProfile(
  loginId: number,
  role: Role,
  profileId: number
): Access {
  if (role === "admin") return "write";
  const row = GRANT_ACCESS_STMT.get(loginId, profileId) as
    { access: string | null } | undefined;
  return row?.access === "read" ? "read" : "write";
}

// Delete every expired session. Called opportunistically at login so the table
// doesn't accumulate dead rows.
export function purgeExpiredSessions(): void {
  // Drop both sliding-expired rows AND any past the absolute created_at ceiling,
  // so the ceiling can't be defeated by a session that keeps sliding expires_at.
  db.prepare(
    `DELETE FROM sessions
       WHERE expires_at <= datetime('now')
          OR created_at <= datetime('now', ?)`
  ).run(SESSION_ABSOLUTE_MAX_MODIFIER);
}

// Mint a session for a login and return the raw token (the caller sets it as
// the cookie — Server Actions can, Server Components can't). The initial active
// profile is the login's first accessible one. `userAgent` (already truncated by
// the caller) is stored so the active-sessions view can label the device.
export function createSession(
  loginId: number,
  userAgent: string | null = null
): {
  token: string;
  maxAgeSec: number;
} {
  const acct = db
    .prepare("SELECT id, role FROM logins WHERE id = ?")
    .get(loginId) as { id: number; role: Role } | undefined;
  if (!acct) throw new Error(`createSession: no login ${loginId}`);
  const first = accessibleProfiles(acct.id, acct.role)[0];
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    `INSERT INTO sessions
       (token_hash, login_id, active_profile_id, user_agent, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now', '+30 days'), datetime('now'))`
  ).run(hashToken(token), loginId, first?.id ?? null, userAgent);
  return { token, maxAgeSec: SESSION_TTL_SEC };
}

// Revoke the current session (logout): delete the DB row and clear the cookie.
// Safe to call from a Server Action, where cookie mutation is allowed.
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
      hashToken(token)
    );
  }
  store.delete(SESSION_COOKIE);
}

// The absolute-max modifier is a trusted internal constant (never user input), so
// interpolating it into the prepared SQL is safe and keeps the single-bound-param
// call sites unchanged. A session past created_at + 90 days simply doesn't match,
// so getCurrentSession() returns null and the user must re-authenticate.
const SESSION_LOOKUP_STMT = db.prepare(
  `SELECT s.login_id AS loginId, s.active_profile_id AS activeProfileId,
          a.username, a.role
     FROM sessions s JOIN logins a ON a.id = s.login_id
    WHERE s.token_hash = ?
      AND s.expires_at > datetime('now')
      AND s.created_at > datetime('now', '${SESSION_ABSOLUTE_MAX_MODIFIER}')`
);
const SESSION_FIX_PROFILE_STMT = db.prepare(
  "UPDATE sessions SET active_profile_id = ? WHERE token_hash = ?"
);
const SESSION_TOUCH_STMT = db.prepare(
  `UPDATE sessions
      SET last_used_at = datetime('now'),
          expires_at = datetime('now', '+30 days')
    WHERE token_hash = ? AND last_used_at < datetime('now', '-1 hour')`
);

// Resolve the caller's session from the cookie, or null. Validates expiry,
// re-derives the active profile against current grants (so a revoked grant can't
// keep a login on a profile it lost), and throttles the last_used_at write to
// once an hour. Sync DB reads are fine under better-sqlite3.
//
// Wrapped in React `cache()` so it runs at most ONCE per server request even
// though requireSession/requireAdmin/getAccessibleProfiles/etc. each call it —
// the throttled sliding-refresh write also collapses to one. `cache()` is scoped
// to a React server request; outside one (there is none here — it reads cookies()
// which itself requires a request) it degrades to a plain passthrough, so no
// stale value can outlive a request. Safe because no request mutates the session
// and then re-reads it expecting the change within the same render (the switch-
// profile action revalidates, producing a fresh request with a fresh cache).
export const getCurrentSession = cache(
  async function getCurrentSession(): Promise<CurrentSession | null> {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const tokenHash = hashToken(token);

    const row = SESSION_LOOKUP_STMT.get(tokenHash) as
      | {
          loginId: number;
          activeProfileId: number | null;
          username: string;
          role: Role;
        }
      | undefined;
    if (!row) return null;

    const profiles = accessibleProfiles(row.loginId, row.role);
    if (profiles.length === 0) return null; // login with no usable profile

    let profile = profiles.find((p) => p.id === row.activeProfileId);
    if (!profile) {
      // Stored active profile is missing or no longer granted — snap to the first
      // accessible one and persist the correction.
      profile = profiles[0];
      SESSION_FIX_PROFILE_STMT.run(profile.id, tokenHash);
    }

    // Sliding refresh, throttled: the WHERE only matches when >1h stale, so a
    // busy session isn't written on every request. Extending expires_at here (not
    // just the cookie's max-age in middleware) is what makes the 30-day expiry
    // truly sliding — otherwise an active user is hard-logged-out 30 days after
    // login no matter how recently they used the app.
    SESSION_TOUCH_STMT.run(tokenHash);

    return {
      login: { id: row.loginId, username: row.username, role: row.role },
      profile,
      access: accessForProfile(row.loginId, row.role, profile.id),
    };
  }
);

// Guard for Server Components / Server Actions: returns the session or redirects
// to /login. redirect() throws (NEXT_REDIRECT), which is the intended control
// flow inside actions too.
export async function requireSession(): Promise<CurrentSession> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session;
}

// Admin-only guard. Members are bounced to the app root. (No admin-only surface
// ships in Phase 1; provided for the Phase 4 admin UI.)
export async function requireAdmin(): Promise<CurrentSession> {
  const session = await requireSession();
  if (session.login.role !== "admin") redirect("/");
  return session;
}

// Write guard (issue #33): the gate every MUTATING Server Action must call in
// place of a bare requireSession(). It resolves the session, then asserts the
// caller holds WRITE access on the profile it is acting as — admins always pass;
// a member acting as a read-only-granted profile is bounced to the app root
// (redirect() throws NEXT_REDIRECT, so a forged POST that reaches the action
// aborts before any mutation runs). This is the AUTHORITATIVE boundary; hidden
// UI affordances are only a convenience. A source-scanning test
// (lib/__tests__/actions-write-access.test.ts) fails the build if a mutating
// action forgets to call this.
export async function requireWriteAccess(): Promise<CurrentSession> {
  const session = await requireSession();
  // Demo mode (#181): belt-and-braces. In a public demo every non-admin write is
  // refused HERE regardless of the grant, so a misconfigured 'write' grant can't
  // let a demo visitor mutate the synthetic data. Admins stay fully functional to
  // maintain the instance. This is independent of the #33 access check below.
  assertNotDemoRestricted(session.login.role);
  if (session.access !== "write") redirect("/");
  return session;
}

// The ONE demo-mode refusal, shared by every guard that blocks demo mutations
// (requireWriteAccess, requireProfileWriteAccess, requireLoginWriteAccess), so
// "who is locked down in demo" stays a single decision — lib/demo's pure
// isDemoRestricted — with a single posture: redirect() throws NEXT_REDIRECT, so a
// forged POST aborts server-side regardless of what the UI renders.
function assertNotDemoRestricted(role: Role): void {
  if (isDemoRestricted(isDemoMode(), role)) redirect("/");
}

// Login-mutation guard (issue #278): the gate for Server Actions that mutate the
// caller's LOGIN-scoped auth state — 2FA enrollment, change-own-password, session
// revocation — rather than profile-owned data. requireWriteAccess() is the wrong
// gate there (those actions legitimately run for read-only members and never
// touch the acting profile), but demo mode must still refuse them: the shared
// public demo login would otherwise let any visitor enroll 2FA or rotate the
// publicly documented password and lock every other visitor out until the
// nightly reset — or kick concurrent visitors off their sessions. Outside demo
// mode this is exactly requireSession(); the demo admin stays fully functional.
export async function requireLoginWriteAccess(): Promise<CurrentSession> {
  const session = await requireSession();
  assertNotDemoRestricted(session.login.role);
  return session;
}

// Cross-profile write gate (issue #31): the guard a Server Action must call when
// it mutates a profile that is NOT the session's active one — e.g. the Household
// quick-actions, which confirm a dose for another accessible profile without
// switching. requireWriteAccess() checks only the ACTIVE profile, so it is the
// wrong gate here. This resolves the session, then asserts the caller may reach
// the TARGET profile AND holds WRITE on it (accessibility FIRST — accessForProfile
// assumes the profile is already reachable and defaults an ungranted member to
// 'write', so it must never be consulted alone). Admins pass (implicit all-write);
// a member's read-only or absent grant is bounced to the app root (redirect()
// throws NEXT_REDIRECT, aborting a forged POST before any mutation runs).
export async function requireProfileWriteAccess(
  profileId: number
): Promise<CurrentSession> {
  const session = await requireSession();
  const { login } = session;
  // Demo mode (#181): the same belt-and-braces block as requireWriteAccess — a
  // demo member may not mutate ANY profile (active or cross-profile), even with a
  // misconfigured grant. Admins pass.
  assertNotDemoRestricted(login.role);
  const reachable = accessibleProfiles(login.id, login.role).some(
    (p) => p.id === profileId
  );
  if (!reachable) redirect("/");
  if (accessForProfile(login.id, login.role, profileId) !== "write")
    redirect("/");
  return session;
}

// The profiles the current login may switch to (for the header switcher).
export async function getAccessibleProfiles(): Promise<SessionProfile[]> {
  const session = await getCurrentSession();
  if (!session) return [];
  return accessibleProfiles(session.login.id, session.login.role);
}

// Session-free accessible-profiles resolver, keyed by login id — used by the
// consolidated (per-login) calendar feed route, which authenticates via a token,
// not a cookie. Resolves the login's CURRENT role + grants every call, so a revoked
// grant (or demotion) is reflected immediately rather than frozen at token mint.
// Returns [] for an unknown/deleted login.
export function accessibleProfilesForLogin(loginId: number): SessionProfile[] {
  const acct = db
    .prepare("SELECT role FROM logins WHERE id = ?")
    .get(loginId) as { role: Role } | undefined;
  if (!acct) return [];
  return accessibleProfiles(loginId, acct.role);
}

// Total number of profiles in the instance, regardless of the caller's grants.
// The Household view is a cross-profile overview (admins see all profiles), so
// the nav gates it on the instance-wide count, not the caller's accessible set.
export function countProfiles(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }
  ).n;
}

// Whether the given session may see a specific profile — the same rule as the
// switcher/serve route: admins reach every profile, members only their granted
// ones. Used by the profile-photo serve route to gate cross-profile fetches.
export function canAccessProfile(
  session: CurrentSession,
  profileId: number
): boolean {
  return accessibleProfiles(session.login.id, session.login.role).some(
    (p) => p.id === profileId
  );
}

// Delete every session belonging to a login — used when an admin resets a
// login's password (all its live cookies must stop working). Optionally spare
// one token's session, which change-own-password uses to keep the caller logged
// in while logging out every other device.
export function destroyLoginSessions(
  loginId: number,
  keepTokenHash?: string
): void {
  if (keepTokenHash) {
    db.prepare(
      "DELETE FROM sessions WHERE login_id = ? AND token_hash != ?"
    ).run(loginId, keepTokenHash);
  } else {
    db.prepare("DELETE FROM sessions WHERE login_id = ?").run(loginId);
  }
}

// Change-own-password helper: drop every session for this login EXCEPT the
// caller's current one (identified by the live cookie). Returns silently if
// there's no cookie (nothing to keep — caller handles the full destroy).
export async function destroyOtherSessionsForCurrent(
  loginId: number
): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  destroyLoginSessions(loginId, token ? hashToken(token) : undefined);
}

// A live session as shown on Settings → Preferences. `id`
// is the SHA-256 token_hash — safe to hand to the client: it can't be reversed
// into the cookie token, and revokeSession scopes deletion to the owning login,
// so it only ever revokes the caller's own sessions. `current` marks the session
// making this request.
export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  current: boolean;
}

// The SHA-256 of the caller's current cookie token, or null when there's no
// cookie — used to flag the current row in the sessions list.
async function currentTokenHash(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? hashToken(token) : null;
}

// Every live session for a login, newest-seen first, for the active-sessions
// view. Expired rows are excluded (they're already dead to getCurrentSession).
export async function listLoginSessions(
  loginId: number
): Promise<SessionSummary[]> {
  const currentHash = await currentTokenHash();
  const rows = db
    .prepare(
      `SELECT token_hash AS id, created_at AS createdAt,
              last_used_at AS lastSeenAt, user_agent AS userAgent
         FROM sessions
        WHERE login_id = ? AND expires_at > datetime('now')
          AND created_at > datetime('now', '${SESSION_ABSOLUTE_MAX_MODIFIER}')
        ORDER BY last_used_at DESC`
    )
    .all(loginId) as Omit<SessionSummary, "current">[];
  return rows.map((r) => ({ ...r, current: r.id === currentHash }));
}

// Revoke one session by its token_hash, scoped to the owning login so a login
// can only ever end its own sessions. Revoking the current session logs the
// caller out on their next request (getCurrentSession finds no row).
export function revokeSession(loginId: number, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ? AND login_id = ?").run(
    sessionId,
    loginId
  );
}

// How many admin logins exist — the guard rail against locking the instance
// out of its admin surface (no action may drop this to zero).
export function adminLoginCount(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM logins WHERE role = 'admin'")
      .get() as { c: number }
  ).c;
}

// Switch the active profile on the current session row, after verifying the
// login may act as it (granted, or admin). No-op-safe: an inaccessible target
// is rejected.
export async function setActiveProfile(profileId: number): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;
  const session = await getCurrentSession();
  if (!session) return;
  const allowed = accessibleProfiles(session.login.id, session.login.role).some(
    (p) => p.id === profileId
  );
  if (!allowed) return;
  db.prepare(
    "UPDATE sessions SET active_profile_id = ? WHERE token_hash = ?"
  ).run(profileId, hashToken(token));
  // Audit the switch — the login now acts as `profileId` (the target).
  recordAudit({
    loginId: session.login.id,
    profileId,
    action: AUDIT_ACTIONS.profileSwitch,
    target: String(profileId),
  });
}
