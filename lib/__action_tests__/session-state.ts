// Mutable "acting session" for the server-action test tier. The auth chokepoint
// (lib/auth) is mocked in lib/__action_tests__/setup.ts to return whatever this
// holds, so a test can switch which login/profile a server action runs as via
// actAs()/setActingSession() — the same shape requireSession() returns in prod.
//
// Kept in its own module (not the setup file) so both the mock factory and the
// harness/tests import the SAME live binding: the factory reads it late, so a
// mid-test actAs() is reflected on the next requireSession() call.

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
export function getActingSession(): CurrentSession {
  if (!current) {
    throw new Error(
      "No acting session set — call actAs()/setActingSession() before invoking a server action."
    );
  }
  return current;
}
