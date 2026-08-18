// Mutable "acting session" for the server-action test tier. The auth chokepoint
// (lib/auth) is mocked in lib/__action_tests__/setup.ts to return whatever this
// holds, so a test can switch which login/profile a server action runs as via
// actAs()/setActingSession() — the same shape requireSession() returns in prod.
//
// Kept in its own module (not the setup file) so both the mock factory and the
// harness/tests import the SAME live binding: the factory reads it late, so a
// mid-test actAs() is reflected on the next requireSession() call.

import { createHash } from "node:crypto";
import type { CurrentSession } from "@/lib/auth";

let current: CurrentSession | null = null;

export function setActingSession(session: CurrentSession): void {
  current = session;
}

export function clearActingSession(): void {
  current = null;
}

// The mocked requireSession/requireAdmin/getCurrentSession delegate here. Throwing
// (rather than redirecting, which needs next/navigation) makes "forgot to seed a
// session" a loud, obvious test failure instead of a null-deref deep in an action.
// The NON-throwing read, for the mocked getCurrentSession(): prod's
// getCurrentSession returns null for an anonymous request, and a route handler's
// "no session" branch (e.g. the #1423 share target's 303 to /login) can only be
// tested if the mock can express that. Tests reach it via clearActingSession().
export function peekActingSession(): CurrentSession | null {
  return current;
}

export function getActingSession(): CurrentSession {
  if (!current) {
    throw new Error(
      "No acting session set — call actAs()/setActingSession() before invoking a server action."
    );
  }
  return current;
}

// THE SESSIONS-TABLE PRIMARY KEY for the acting session — what prod's
// currentTokenHash() resolves the live cookie to, and the id revokeSessionAction
// must hand revokeSession so it can refuse the session making the request.
//
// SHAPED LIKE THE REAL VALUE ON PURPOSE, and that is the whole point of it
// existing. `sessions.token_hash` is a 64-hex SHA-256; `CurrentSession.deviceSessionKey`
// is a 16-char derivative of it (lib/auth's deviceSessionKey) and can never equal
// it. This tier used to stand `currentTokenHash` in as `deviceSessionKey`, which
// made the two interchangeable HERE and nowhere else — so an action that passed
// `session.deviceSessionKey` instead of the row key passed every test and would
// never have refused anything in production. A stand-in that cannot tell the right
// identifier from the plausible wrong one is not a stand-in.
//
// Deterministic per acting login+profile so a test can seed its session row under
// the same key: harness.ts re-exports it as `actingSessionId()`.
export function peekActingTokenHash(): string | null {
  if (!current) return null;
  return createHash("sha256")
    .update(`action-tier-session:${current.login.id}:${current.profile.id}`)
    .digest("hex");
}
