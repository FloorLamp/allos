import { db, hoistedStatement } from "./db";
import { readBodyCapped } from "./request-body";
import {
  accessibleProfilesForLogin,
  ownProfileForLogin,
  resolveSessionToken,
  SESSION_COOKIE,
  writableProfileIdsForLogin,
  type Role,
  type SessionLogin,
  type SessionProfile,
} from "./auth";
import {
  allows,
  bearer,
  BoardingUnavailable,
  BOARDING_URL,
  deviceVerifier,
} from "./device-credential";

// The device API's request boundary (FloorLamp/allos#6076; docs/device-api.md).
//
// Two decisions, kept apart as lib/api-tokens.ts keeps them:
//   1. WHO IS CALLING — boarding's answer for the credential (lib/device-credential.ts):
//      the device's name and its `allos:*` scopes. Fail-closed: no answer is 503.
//   2. WHAT IT MAY DO HERE — allos's own. The device is linked to ONE login by the
//      owner (`device_logins`, scripts/device-links.ts); the login's current role and
//      grants decide which profiles it reaches and writes, re-derived on every call
//      exactly as for a cookie session, so a revoked grant lands at once.
//
// The credential itself is never stored, logged or echoed; only the device's name is.

export type DeviceScope = "allos:read" | "allos:ask" | "allos:log";

const verifier = deviceVerifier({
  service: "allos",
  url: process.env.BOARDING_URL || BOARDING_URL,
});

const LINK_STMT = hoistedStatement(
  `SELECT l.id AS id, l.username AS username, l.role AS role
     FROM device_logins d JOIN logins l ON l.id = d.login_id
    WHERE d.device = ?`
);

export interface DeviceLink {
  device: string;
  loginId: number;
  username: string;
  createdAt: string;
}

export function listDeviceLinks(): DeviceLink[] {
  return db
    .prepare(
      `SELECT d.device AS device, d.login_id AS loginId, l.username AS username,
              d.created_at AS createdAt
         FROM device_logins d JOIN logins l ON l.id = d.login_id
        ORDER BY d.device`
    )
    .all() as DeviceLink[];
}

// Boarding's device names: `[a-z0-9][a-z0-9_.-]*` (boarding README *Devices*).
export const DEVICE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

// Point a device at a login (replacing an earlier link). The owner's explicit act;
// nothing here infers it.
export function linkDevice(device: string, loginId: number): void {
  if (!DEVICE_NAME.test(device))
    throw new Error(`not a device name: ${device}`);
  db.prepare(
    `INSERT INTO device_logins (device, login_id) VALUES (?, ?)
     ON CONFLICT(device) DO UPDATE SET login_id = excluded.login_id`
  ).run(device, loginId);
}

export function unlinkDevice(device: string): boolean {
  return (
    db.prepare("DELETE FROM device_logins WHERE device = ?").run(device)
      .changes > 0
  );
}

// deleteLogin's explicit sweep, beside its api_tokens one: the FK cascades, but the
// teardown holds with foreign_keys off too.
export function deleteDeviceLinksForLogin(loginId: number): void {
  db.prepare("DELETE FROM device_logins WHERE login_id = ?").run(loginId);
}

export type DeviceAuth =
  | {
      ok: true;
      device: string;
      login: SessionLogin;
      // The profile this call reads or writes: `?profile=<id>` when the device named
      // one, else the login's own profile, else its first reachable one.
      profile: SessionProfile;
      profiles: SessionProfile[];
    }
  | { ok: false; status: 401 | 403 | 503; error: DeviceRefusal };

// BACKEND.md's words (`token`, `scope`, `boarding`) plus allos's own two: `device`
// (verified, but the owner linked it to no login) and `profile` (the login reaches no
// profile, or not the one asked for).
export type DeviceRefusal =
  "token" | "scope" | "boarding" | "device" | "profile";

export function refuse(auth: { status: number; error: string }): Response {
  return Response.json({ error: auth.error }, { status: auth.status });
}

// A `/v1` write's JSON body, read under a hard byte cap (lib/request-body.ts: a
// Content-Length is not a bound). A device states a dose or a reading, never a file:
// 16 KB is generous. Not JSON, over the cap or not an object: null.
const BODY_CAP_BYTES = 16 * 1024;
export async function deviceJsonBody(
  req: Request
): Promise<Record<string, unknown> | null> {
  const read = await readBodyCapped(req.body, BODY_CAP_BYTES);
  if ("overCap" in read) return null;
  try {
    const parsed: unknown = JSON.parse(read.text || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// The profile a call acts on and the ones its login reaches: `?profile=<id>` when the
// caller named one, else `own` (the login's own profile, or the session's active one),
// else the first reachable.
function reach(
  req: Request,
  login: SessionLogin,
  own: number | null
): { profile: SessionProfile; profiles: SessionProfile[] } | null {
  const profiles = accessibleProfilesForLogin(login.id);
  const asked = new URL(req.url).searchParams.get("profile");
  const wanted = asked === null ? own : Number(asked);
  const profile =
    wanted === null
      ? profiles[0]
      : (profiles.find((p) => p.id === wanted) ??
        (asked === null ? profiles[0] : undefined));
  return profile ? { profile, profiles } : null;
}

// The `/api` twin of a `/v1` route (Deck's web host, deck-ui host/web.js): the same
// handler on allos's own origin for a person signed in with the session cookie, never
// a device credential in a browser. The session's login and grants decide the profiles
// exactly as for a linked device; a scope is a device's, so it does not apply.
function authenticateSession(req: Request): DeviceAuth {
  const token = (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const session = token ? resolveSessionToken(token) : null;
  if (!session) return { ok: false, status: 401, error: "token" };
  const here = reach(req, session.login, session.profile.id);
  if (!here) return { ok: false, status: 403, error: "profile" };
  return { ok: true, device: "session", login: session.login, ...here };
}

// Authenticate a `/v1` request and resolve the profile it acts on. Order matters and
// is the contract's: the credential before anything (401 / 503), then the route's
// scope (403 `scope`), then allos's own link (403 `device`) and grants (403 `profile`).
// A request on `/api/…` is the session twin of the route instead.
export async function authenticateDevice(
  req: Request,
  scope: DeviceScope
): Promise<DeviceAuth> {
  if (new URL(req.url).pathname.startsWith("/api/"))
    return authenticateSession(req);
  let who;
  try {
    who = await verifier.check(bearer(req));
  } catch (e) {
    if (e instanceof BoardingUnavailable) {
      console.error("device api: boarding unavailable", e.message);
      return { ok: false, status: 503, error: "boarding" };
    }
    throw e;
  }
  if (!who) return { ok: false, status: 401, error: "token" };
  if (!allows(who, scope)) return { ok: false, status: 403, error: "scope" };

  const link = LINK_STMT.get(who.device) as
    { id: number; username: string; role: Role } | undefined;
  if (!link) return { ok: false, status: 403, error: "device" };
  const login: SessionLogin = {
    id: link.id,
    username: link.username,
    role: link.role,
  };

  const here = reach(req, login, ownProfileForLogin(login.id));
  if (!here) return { ok: false, status: 403, error: "profile" };
  return { ok: true, device: who.device, login, ...here };
}

// The write gate for `allos:log` routes: the same answer requireProfileWriteAccess
// gives a Server Action (reach, then write access, then demo restriction), from the
// one set-shaped resolver that composes all three.
export function deviceMayWrite(auth: DeviceAuth & { ok: true }): boolean {
  return writableProfileIdsForLogin(auth.login.id).includes(auth.profile.id);
}
