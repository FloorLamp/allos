import { cache } from "react";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db, hoistedStatement } from "./db";
import { recordAudit } from "./audit";
import { AUDIT_ACTIONS } from "./audit-actions";
import {
  SESSION_COOKIE,
  SESSION_SLIDE_MARK_COOKIE,
  SESSION_TTL_SEC,
  sessionCookieOptions,
} from "./session-cookie";
import { isDemoMode, isDemoRestricted } from "./demo";
import {
  AUTHORIZED_PROFILE_IDS_MARK,
  type AuthorizedProfileIds,
} from "./cross-profile";
import {
  parseViewProfileIds,
  serializeViewProfileIds,
  toggleViewId,
} from "./view-set";

// Re-exported so existing importers (the login action, etc.) keep resolving the
// cookie name + options from lib/auth. The single source of truth is
// lib/session-cookie.ts, which is dependency-free so the Edge middleware can
// import it too (issues #21, #676).
export { SESSION_COOKIE, sessionCookieOptions };

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
  // WHICH SESSION THIS IS, safe to hand to the browser (#2908). Opaque, stable for
  // the life of one session, and different for every other one. See deviceSessionKey.
  deviceSessionKey: string;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// A name for THIS session that the browser may hold, and that grants nothing.
//
// The device write gate (lib/offline/write-gate.ts) has to answer one question that no
// amount of client-side state can: "is the document asking to re-open device writes part
// of the session that closed them, or a new one?" A mount cannot answer it — every tab
// open at logout is still mounted, and each of them re-opened the gate and wrote a
// logged-out login's PHI straight back. Identity answers it, so the session needs a name.
//
// It is a second hash of the stored token hash, truncated. That is deliberate on both
// counts: it is not the token (which stays httpOnly and never reaches script), it is not
// the token_hash the server authenticates against, and it is not reversible to either, so
// the copy that ends up at rest in IndexedDB beside the offline snapshots authenticates
// nothing if the device is taken. It only has to be comparable and unique per session.
function deviceSessionKey(tokenHash: string): string {
  return crypto
    .createHash("sha256")
    .update(`allos-device-session:${tokenHash}`)
    .digest("hex")
    .slice(0, 16);
}

// Prepared statements hoisted to module scope — these run on effectively every
// request (getCurrentSession → accessibleProfiles), so prepare them once. `db` is
// created + migrated eagerly at import (lib/db.ts), so it's ready here.
const PROFILES_ALL_STMT = hoistedStatement(
  "SELECT id, name, photo_path, photo_version FROM profiles ORDER BY id"
);
const PROFILES_FOR_LOGIN_STMT = hoistedStatement(
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

// Whether a login can reach ANY profile — the precondition for a usable session
// (issue #1434). A member created with zero grants authenticates fine and then
// resolves to no session at all (see resolveSessionToken below), which used to
// present as a silent bounce back to an empty sign-in form. The sign-in actions
// call this BEFORE minting a session so the outcome can be honest and no unusable
// session row is created. Admins are implicit-all, so they only fail this when the
// instance has no profiles at all.
export function loginHasProfileAccess(loginId: number, role: Role): boolean {
  return accessibleProfiles(loginId, role).length > 0;
}

const GRANT_ACCESS_STMT = hoistedStatement(
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

// ── REVOKED, NOT MERELY UNAUTHORIZED (#3053) ─────────────────────────────────
//
// A revocation leaves a TOMBSTONE and an expiry does not. That asymmetry IS the
// distinction — absence cannot carry it, because every path here ends in the same DELETE
// — and it is the one property of this file a change must not lose. Why the table exists
// and how long its rows live: lib/migrations/versions/20260829-revoked-session-tombstones.
const TOMBSTONE_TOKEN_STMT = hoistedStatement(
  `INSERT OR REPLACE INTO revoked_sessions (token_hash, revoked_at)
   VALUES (?, datetime('now'))`
);
// The two set-shaped revocations cannot say afterwards which rows they took, so they copy
// the hashes they are ABOUT to delete — but NARROWER than the delete by exactly one
// clause, and that clause is not optional.
//
// The delete is `WHERE login_id = ?` with no expiry filter, so it also takes rows that
// were ALREADY DEAD. Mirroring it tombstoned them, and a device whose cookie had merely
// lapsed then wiped its health record at its next /login — the person the ruling protects,
// the one who came back tomorrow. And it depended on whether `purgeExpiredSessions` had
// run: swept, the row was gone and nothing was recorded; unswept, the record was
// destroyed. Same household, same actions, outcome decided by a background sweep.
//
// So these select the LIVE set — the liveness `SESSION_LOOKUP_STMT` and
// `listLoginSessions` already use, because "a session this revocation ended" and "a
// session a device could still have presented" must be the same set. A dead row is not
// something anyone revoked.
const SESSION_IS_LIVE = `expires_at > datetime('now')
        AND created_at > datetime('now', '${SESSION_ABSOLUTE_MAX_MODIFIER}')`;
const TOMBSTONE_LOGIN_STMT = hoistedStatement(
  `INSERT OR REPLACE INTO revoked_sessions (token_hash, revoked_at)
     SELECT token_hash, datetime('now') FROM sessions
      WHERE login_id = ? AND ${SESSION_IS_LIVE}`
);
const TOMBSTONE_LOGIN_EXCEPT_STMT = hoistedStatement(
  `INSERT OR REPLACE INTO revoked_sessions (token_hash, revoked_at)
     SELECT token_hash, datetime('now') FROM sessions
      WHERE login_id = ? AND token_hash != ? AND ${SESSION_IS_LIVE}`
);
const REVOKED_LOOKUP_STMT = hoistedStatement(
  "SELECT 1 AS found FROM revoked_sessions WHERE token_hash = ?"
);

/**
 * WHY THE SERVER SAYS THE WORD, AND WHAT IT COSTS TO SAY IT.
 *
 * This is the response shape an unauthenticated caller gets from the app's
 * cookie-authoritative data routes, and the owner's 2026-08-20 ruling on #3053 deferred
 * one decision to whoever wrote it: does telling a caller "this session was revoked",
 * rather than plain "unauthorized", leak anything worth withholding from an attacker
 * holding the device?
 *
 * THE ANSWER IS NO, and the reasoning is four steps, in the order that matters:
 *
 *   1. `"revoked"` is reachable ONLY by presenting the exact 32-byte session token whose
 *      hash we recorded. Anyone who can do that held a live session until the moment it
 *      was revoked, so they could already read everything the word could protect. The
 *      distinction tells them nothing they could not have learned one request earlier.
 *   2. It is NOT an oracle. A caller with no cookie, a forged cookie, a guessed token or
 *      an expired one gets `"unauthorized"` — indistinguishable from every other invalid
 *      token — so nobody can learn from this answer whether some token ever existed. The
 *      tombstone is keyed by the token's SHA-256, so matching one means already holding
 *      it.
 *   3. It carries NOTHING ELSE. No username, no login id, no profile, no timestamp, no
 *      count of other devices. "This one is over" is the entire payload; who ended it and
 *      when stay on the server, in the audit trail (#1843).
 *   4. Withholding it buys nothing anyway. The attacker holding the device watches the
 *      offline record disappear and the app refuse to sign in — the fact is delivered by
 *      the consequence whether or not the word is. What withholding it DOES cost is the
 *      health record: silence is precisely the state #3053 records, where "Sign out all
 *      devices" left the med list sitting on the compromised phone.
 *
 * The one thing it genuinely reveals is that the revocation was DELIBERATE rather than a
 * lapse. That is the point. It is also the thing an honest product owes the person whose
 * device it is.
 */
export type SessionDenial = "revoked" | "unauthorized";

/**
 * What to tell a caller whose token did not resolve to a session. Resolve the session
 * first; ask this only when that answered null.
 */
export function sessionDenial(token: string | null | undefined): SessionDenial {
  if (!token) return "unauthorized";
  return REVOKED_LOOKUP_STMT.get(hashToken(token)) ? "revoked" : "unauthorized";
}

/** `sessionDenial` for the caller's own cookie. */
export async function currentSessionDenial(): Promise<SessionDenial> {
  return sessionDenial((await cookies()).get(SESSION_COOKIE)?.value);
}

// Delete every expired session, returning how many rows went. Called
// opportunistically at login AND from the hourly notify tick's sweep block
// (#1843) — an instance nobody signs into for months used to accumulate dead
// rows unbounded, because "someone signs in" was the only trigger.
//
// `datetime('now')` is correct here: both `sessions.expires_at` and
// `sessions.created_at` are declared `convention: "bare"` in lib/time-columns.ts,
// so this compares like against like.
export function purgeExpiredSessions(): number {
  // NO TOMBSTONE HERE, and that is the load-bearing line of #3053: a session that simply
  // lapsed leaves no record, so the next request gets a plain "unauthorized" and the
  // device keeps its offline copy — #2994's pass-4 ruling, untouched.
  //
  // It does RETIRE tombstones, on the same tick and by the same 90-day ceiling. Counted
  // separately — the return value is sessions, per the #1843 audit line.
  //
  // AND RETIRING ONE DOES CHANGE AN ANSWER. It is tempting to argue that a token past the
  // ceiling can never resolve to a session, so its tombstone cannot matter — the premise
  // is true and the conclusion does not follow. `sessionDenial` is consulted ONLY AFTER
  // resolution has already failed; answering the denial WORD is its whole job. So a
  // retired tombstone turns "revoked" into "unauthorized", every time.
  //
  // So this is a TRADE, not a tidy-up. A phone revoked on suspicion of compromise and left
  // in a drawer for 91 days comes back, is told "unauthorized", and KEEPS its offline
  // health record — #3053's own exposure, reopened here. Against that: an unbounded table
  // of hashes for every session this instance has ever deliberately ended. 90 days is
  // chosen because it is the session ceiling, and therefore the longest window in which
  // the device could still have believed it had a session at all. SHORTENING IT IS NOT
  // FREE — every day removed is a day of devices that come back and are not told.
  db.prepare(
    "DELETE FROM revoked_sessions WHERE revoked_at <= datetime('now', ?)"
  ).run(SESSION_ABSOLUTE_MAX_MODIFIER);
  // Drop both sliding-expired rows AND any past the absolute created_at ceiling,
  // so the ceiling can't be defeated by a session that keeps sliding expires_at.
  return db
    .prepare(
      `DELETE FROM sessions
       WHERE expires_at <= datetime('now')
          OR created_at <= datetime('now', ?)`
    )
    .run(SESSION_ABSOLUTE_MAX_MODIFIER).changes;
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
    const hash = hashToken(token);
    // Tombstoned like every other deliberate end (#3053). This device wipes itself
    // through components/device-wipe; the tombstone is for the OTHER documents of the
    // same session — a second tab — which otherwise learn it never.
    TOMBSTONE_TOKEN_STMT.run(hash);
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  }
  store.delete(SESSION_COOKIE);
  // The slide mark (#2058) dates the session cookie, so it dies with it. Leaving
  // it behind would tell the middleware that the NEXT session's cookie was
  // already refreshed recently when it wasn't.
  store.delete(SESSION_SLIDE_MARK_COOKIE);
}

// The absolute-max modifier is a trusted internal constant (never user input), so
// interpolating it into the prepared SQL is safe and keeps the single-bound-param
// call sites unchanged. A session past created_at + 90 days simply doesn't match,
// so getCurrentSession() returns null and the user must re-authenticate.
const SESSION_LOOKUP_STMT = hoistedStatement(
  `SELECT s.login_id AS loginId, s.active_profile_id AS activeProfileId,
          a.username, a.role
     FROM sessions s JOIN logins a ON a.id = s.login_id
    WHERE s.token_hash = ?
      AND s.expires_at > datetime('now')
      AND s.created_at > datetime('now', '${SESSION_ABSOLUTE_MAX_MODIFIER}')`
);
const SESSION_FIX_PROFILE_STMT = hoistedStatement(
  "UPDATE sessions SET active_profile_id = ? WHERE token_hash = ?"
);
const SESSION_DELETE_STMT = hoistedStatement(
  "DELETE FROM sessions WHERE token_hash = ?"
);
const SESSION_TOUCH_STMT = hoistedStatement(
  `UPDATE sessions
      SET last_used_at = datetime('now'),
          expires_at = datetime('now', '+30 days')
    WHERE token_hash = ? AND last_used_at < datetime('now', '-1 hour')`
);

// DB-callable core of getCurrentSession: resolve a RAW session token to the
// current session, or null. Applies the expiry + absolute-ceiling gate (via
// SESSION_LOOKUP_STMT), re-derives the active profile against current grants (so a
// revoked grant can't keep a login on a profile it lost), and throttles the
// sliding last_used_at/expires_at write to once an hour. This is the whole
// decision; getCurrentSession() only adds the cookie read (issue #676), so the
// session lifecycle + ceiling + grant re-derivation are testable without a request.
export function resolveSessionToken(token: string): CurrentSession | null {
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
  if (profiles.length === 0) {
    // A login with no usable profile has no session (issue #1434). Tear the row
    // down rather than leaving a cookie that resolves to null on every request —
    // otherwise a member whose last grant was revoked keeps a zombie row that the
    // Family screen still counts as an "active session" while every request
    // bounces to /login. The sign-in actions refuse to mint one in the first
    // place; this is the same decision applied to a session that OUTLIVED its
    // grants. Deleting by token hash only ever touches this caller's own session.
    // AND IT IS A REVOCATION, not an expiry (#3053): the login lost every grant it had,
    // so somebody took this person's access away and the device must lose its copy too.
    // The eighth session-ending path — #3053's body lists seven and predates it.
    TOMBSTONE_TOKEN_STMT.run(tokenHash);
    SESSION_DELETE_STMT.run(tokenHash);
    return null;
  }

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
    deviceSessionKey: deviceSessionKey(tokenHash),
  };
}

// Resolve the caller's session from the cookie, or null.
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
    return resolveSessionToken(token);
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

// ── Minting the authorized-set capability (#2898) ─────────────────────────────
//
// `AuthorizedProfileIds` (lib/cross-profile.ts) is the type a set-based cross-profile
// query demands. It has no constructor that takes a list of numbers; it is DERIVED,
// here, from the same grant resolution every other access decision in this module
// uses. That is what makes these boundaries and not casts in disguise: whatever a
// caller believes about a login, the set that comes back is recomputed from
// `accessibleProfiles` at call time, so a revoked grant drops out immediately and an
// id nobody granted can never appear.
//
// The seal lives in this one helper, beside the derivation that justifies it, and is
// deliberately NOT exported: an exported `authorized(ids)` would be exactly the
// arbitrary-numbers minter the capability exists to prevent. It is a three-line copy
// of lib/cross-profile's private `seal` — mark non-enumerably so `Object.assign`
// cannot launder the mark onto a forged array, then freeze so `Object.assign` cannot
// overwrite this one in place. Two short copies is the price of not exporting a
// sealer; the shared SYMBOL is all the two modules have in common.
function authorized(ids: readonly number[]): AuthorizedProfileIds {
  Object.defineProperty(ids, AUTHORIZED_PROFILE_IDS_MARK, {
    value: true,
    enumerable: false,
  });
  return Object.freeze(ids) as unknown as AuthorizedProfileIds;
}

// The login's accessible set as the capability — for the token-authenticated surfaces
// that have no session to resolve a ProfileScope from (the portals registry endpoint,
// the Patient portals page's reads). Session-backed pages take `scope.ids` instead.
export function accessibleProfileIdsForLogin(
  loginId: number
): AuthorizedProfileIds {
  return authorized(accessibleProfilesForLogin(loginId).map((p) => p.id));
}

// The subset of that set the login may WRITE — the authority a reporting token's
// account gate and the "can this viewer act at all?" checks ask about. Reach FIRST,
// then access (accessForProfile assumes reachability), and demo-restriction refuses
// every non-admin write, so a demo-restricted token resolves to the empty set exactly
// as it would be refused at an upload.
//
// The ROLE IS READ HERE, not taken as an argument (#2935 review). A caller passing the
// wrong role would silently promote every read-only grant to writable — `accessForProfile`
// answers "write" unconditionally for an admin — and this function's result is one the
// type system labels authorized, so it must not depend on the caller getting a second
// argument right. It resolves the login's CURRENT role from the same row
// `accessibleProfilesForLogin` reads, which is also what makes a demotion take effect
// immediately instead of riding a stale value.
export function writableProfileIdsForLogin(
  loginId: number
): AuthorizedProfileIds {
  const acct = db
    .prepare("SELECT role FROM logins WHERE id = ?")
    .get(loginId) as { role: Role } | undefined;
  if (!acct) return authorized([]);
  if (isDemoRestricted(isDemoMode(), acct.role)) return authorized([]);
  return authorized(
    accessibleProfilesForLogin(loginId)
      .filter((p) => accessForProfile(loginId, acct.role, p.id) === "write")
      .map((p) => p.id)
  );
}

// ── Own-profile association (issue #1013) ─────────────────────────────────────
//
// A login may designate ONE of its accessible profiles as "mine" — the self the
// not-self write affordances (#1013) and the profile banner (#1096) key on. This is
// purely an association: it changes NO access (grants + admin-bypass govern access
// exactly as before). Stored as logins.own_profile_id (migration 103), read back
// here and re-validated against the login's CURRENT accessible set at the scope
// boundary (resolveScope), so a revoked grant drops the link to null on the next
// read even if the stored value wasn't nulled.

const LOGIN_OWN_PROFILE_STMT = hoistedStatement(
  "SELECT own_profile_id AS ownProfileId FROM logins WHERE id = ?"
);

// The raw stored own-profile id for a login, or null (unset, or the login is gone).
// NOT validated against grants — that is resolveScope's job on read.
export function ownProfileForLogin(loginId: number): number | null {
  const row = LOGIN_OWN_PROFILE_STMT.get(loginId) as
    { ownProfileId: number | null } | undefined;
  return row?.ownProfileId ?? null;
}

// DB-callable core of the own-profile setter: point a login's own-profile at
// `profileId` (or clear it with null), after verifying the login may ACT AS the
// target (granted, or admin) — the SAME accessibility gate switchActiveProfile
// applies, so a login can only ever mark an accessible profile as its own. Returns
// true when written, false when the target is inaccessible (no-op). Split from the
// action shell so the accessibility constraint is testable without a request.
export function setOwnProfileForLogin(
  loginId: number,
  role: Role,
  profileId: number | null
): boolean {
  if (profileId !== null) {
    const allowed = accessibleProfiles(loginId, role).some(
      (p) => p.id === profileId
    );
    if (!allowed) return false;
  }
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    profileId,
    loginId
  );
  return true;
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
//
// Returns HOW MANY sessions were ended. The count is what makes the #1843 audit
// row worth reading ("an admin ended three live sessions" vs "an admin clicked
// the button on an account with none") and what lets the call sites record an
// event only when a session actually died.
export function destroyLoginSessions(
  loginId: number,
  keepTokenHash?: string
): number {
  // Tombstone BEFORE the delete — after it there is nothing left to name (#3053). The
  // predicates are the same on both halves so a tombstone cannot describe a session that
  // survived, nor miss one that did not.
  if (keepTokenHash) {
    TOMBSTONE_LOGIN_EXCEPT_STMT.run(loginId, keepTokenHash);
    return db
      .prepare("DELETE FROM sessions WHERE login_id = ? AND token_hash != ?")
      .run(loginId, keepTokenHash).changes;
  }
  TOMBSTONE_LOGIN_STMT.run(loginId);
  return db.prepare("DELETE FROM sessions WHERE login_id = ?").run(loginId)
    .changes;
}

// Change-own-password helper: drop every session for this login EXCEPT the
// caller's current one (identified by the live cookie). Returns silently if
// there's no cookie (nothing to keep — caller handles the full destroy).
// Returns the number of sessions ended, like destroyLoginSessions.
export async function destroyOtherSessionsForCurrent(
  loginId: number
): Promise<number> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return destroyLoginSessions(loginId, token ? hashToken(token) : undefined);
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
// cookie — used to flag the current row in the sessions list, and to let
// revokeSession refuse the session making the request.
export async function currentTokenHash(): Promise<string | null> {
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

/** What a per-device revoke actually did. Three outcomes, and the caller must tell them apart. */
export type SessionRevokeOutcome = "revoked" | "nothing" | "refused-current";

// Revoke one session by its token_hash, scoped to the owning login so a login
// can only ever end its own sessions.
//
// AND IT REFUSES THE SESSION MAKING THE REQUEST. That exclusion used to live in
// the SETTINGS PAGE — ActiveSessions renders the Revoke button only for a row
// that is not `current` — which is an authorization invariant enforced by a
// RENDERING DECISION: hand this function the caller's own session id (a forged
// POST is the only way, so it is self-inflicted, but the shape is the one that
// keeps costing this repo) and it happily ended the session it was called from.
//
// That mattered beyond tidiness once #2908 landed: the offline snapshots, the
// queue and the write gate are wiped by a document on the device, and the ONE
// revoke a person can aim at their own device was the one path that ended its
// session without any of that running — so it left the health record and an OPEN
// write gate behind on a device that now has no session at all.
//
// `currentSessionId` is REQUIRED, and `null` only for a caller with no cookie:
// making it optional would let a future call site drop the guard by forgetting
// it, which is how the guard ended up in a component in the first place.
//
// The outcome is STATED rather than a boolean, because "I refused" and "there
// was nothing there" are different answers and the caller owes the person the
// difference. Only "revoked" means a row went — the #1843 audit event must not
// be written for either of the others.
export function revokeSession(
  loginId: number,
  sessionId: string,
  currentSessionId: string | null
): SessionRevokeOutcome {
  if (currentSessionId !== null && sessionId === currentSessionId) {
    return "refused-current";
  }
  const ended =
    db
      .prepare("DELETE FROM sessions WHERE token_hash = ? AND login_id = ?")
      .run(sessionId, loginId).changes > 0;
  // Only for a row that actually went (#3053). Tombstoning the caller-supplied id
  // unconditionally would let a forged POST plant rows for hashes this login never
  // owned — harmless to read, but unbounded to write, and the "nothing" outcome exists
  // precisely to say no session was there.
  //
  // AND NO LIVENESS CLAUSE HERE, unlike the two set-shaped statements above, which is a
  // decision rather than an omission. Those end a set nobody enumerated, so a lapsed
  // device in a drawer is swept in by accident; this one NAMES a device, which is what a
  // per-device revoke is for. A row that lapsed between the list being rendered and the
  // button being pressed is still the device the person meant to end, and ending it is
  // the answer they asked for. (The list itself only ever shows live rows, so reaching a
  // dead one takes a stale page or a forged id.)
  if (ended) TOMBSTONE_TOKEN_STMT.run(sessionId);
  return ended ? "revoked" : "nothing";
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

// DB-callable core of setActiveProfile: switch the active profile on the session
// identified by `token`, after verifying the login may act as the target
// (granted, or admin). Returns true if switched, false if the target is
// inaccessible (no-op). The shell only adds the cookie + current-session reads,
// so the accessibility gate is testable without a request (issue #676).
export function switchActiveProfile(
  session: CurrentSession,
  token: string,
  profileId: number
): boolean {
  const allowed = accessibleProfiles(session.login.id, session.login.role).some(
    (p) => p.id === profileId
  );
  if (!allowed) return false;
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
  return true;
}

// Switch the active profile on the current session row, after verifying the
// login may act as it (granted, or admin). No-op-safe: an inaccessible target
// is rejected. Switching the acting profile RESETS the view-set to single-view
// (issue #1096: reset is simpler and least surprising than intersect) — the new
// acting profile becomes the only viewed one until the user re-expands the view.
export async function setActiveProfile(profileId: number): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;
  const session = await getCurrentSession();
  if (!session) return;
  if (switchActiveProfile(session, token, profileId)) {
    // Reset the view overlay: NULL = single-view (just the new acting profile).
    SESSION_SET_VIEW_STMT.run(null, hashToken(token));
  }
}

// ── Multi-profile view-set (issue #1096) ──────────────────────────────────────
//
// The view-set is a READ overlay stored on the session row (migration 101) as JSON,
// re-validated against grants on every read (resolveScope). It is NOT an auth check
// — writes still target the single active profile. These helpers own only the raw
// stored value; the grant validation on read lives in lib/scope.ts.

const SESSION_VIEW_STMT = hoistedStatement(
  "SELECT view_profile_ids AS raw FROM sessions WHERE token_hash = ?"
);
const SESSION_SET_VIEW_STMT = hoistedStatement(
  "UPDATE sessions SET view_profile_ids = ? WHERE token_hash = ?"
);

// DB-callable core: the raw (UNVALIDATED) persisted view-set for a session token, or
// [] when unset/malformed. resolveScope re-intersects it with the caller's current
// accessible set, so this can be trusted no further than "what was stored".
export function sessionViewProfileIds(token: string): number[] {
  const row = SESSION_VIEW_STMT.get(hashToken(token)) as
    { raw: string | null } | undefined;
  return parseViewProfileIds(row?.raw ?? null);
}

// The current session's raw persisted view-set (or null when there's no cookie).
// Passed to resolveScope/requireScope, which does the grant validation — this is
// deliberately the UNVALIDATED stored value.
export async function getCurrentViewProfileIds(): Promise<number[] | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return sessionViewProfileIds(token);
}

// DB-callable core: persist a view-set for a session, VALIDATED against the login's
// current grants (∩ accessible — a member can never persist an ungranted id) and
// normalized to NULL for the single-view default. Returns the ids actually stored
// (∩ accessible, acting-profile always retained). Split from the shell so the
// validation is testable without a request.
export function setSessionViewProfiles(
  session: CurrentSession,
  token: string,
  rawIds: readonly number[]
): number[] {
  const { login, profile } = session;
  const accessible = new Set(
    accessibleProfiles(login.id, login.role).map((p) => p.id)
  );
  // Keep the acting profile always in view, then the requested ids that survive the
  // grant intersection. A revoked/ungranted id is silently dropped here (and would
  // be dropped again on read) — the "re-derive against current grants" stance.
  const validated = [profile.id, ...rawIds].filter(
    (id, i, arr) => accessible.has(id) && arr.indexOf(id) === i
  );
  const stored = serializeViewProfileIds(validated, profile.id);
  SESSION_SET_VIEW_STMT.run(stored, hashToken(token));
  return parseViewProfileIds(stored ?? null).length > 0
    ? parseViewProfileIds(stored ?? null)
    : [profile.id];
}

// Toggle one accessible profile in/out of the current session's view-set (the
// banner's per-chip view toggle). Grant-validated through setSessionViewProfiles, so
// an ungranted target is a no-op. No-op-safe when there's no live session/cookie.
export async function toggleViewProfile(profileId: number): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;
  const session = await getCurrentSession();
  if (!session) return;
  const current = sessionViewProfileIds(token);
  const next = toggleViewId(current, profileId, session.profile.id);
  setSessionViewProfiles(session, token, next);
}
