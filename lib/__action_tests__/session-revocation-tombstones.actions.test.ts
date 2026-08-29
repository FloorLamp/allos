// SERVER-ACTION TIER — every deliberate way to end a session says REVOKED (#3053).
//
// The defect this exists for is not any one path, it is the SET: seven server actions
// destroy sessions, and a fix that reached five of them would leave the health record on a
// device revoked through either of the other two, with nothing to say which. So the table
// below drives all seven through their real Server Actions and asks the same question of
// each — what does the wire now say about that exact token — rather than asserting on the
// statement each one happens to run.
//
// THE NEGATIVE IS THE OTHER HALF and it is in lib/__db_tests__/auth.test.ts, where expiry
// (swept and unswept) answers "unauthorized" and leaves no tombstone. Without it this file
// would pass just as happily against a build that tombstoned everything, which is the
// build #2994's pass-4 ruling forbids.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import crypto from "node:crypto";
import { sessionDenial, type SessionDenial } from "@/lib/auth";
import {
  changeOwnPassword,
  revokeSessionAction,
  signOutOtherSessions,
} from "@/app/(app)/settings/actions";
import {
  deleteLogin,
  resetPassword,
  revokeLoginSessions,
} from "@/app/(app)/settings/family/actions";
import { completeSetPassword } from "@/app/(auth)/set-password/actions";
import { createAuthToken } from "@/lib/auth-tokens";
import { ACTION_TEST_PASSWORD } from "./password-fixture";
import { createLogin, createProfile, actAs, fd } from "./harness";

// A NEW, STRONG password for the paths that set one. Low-entropy words + digits, per the
// fixture rule — it only has to pass checkPasswordStrength.
const NEW_PASSWORD = "not-a-real-password-2";

// A session on a DEVICE ELSEWHERE: the phone in the drawer, the laptop across town. The
// raw token never leaves this function's caller, exactly as it never leaves the browser
// in production — the row stores its hash, and `sessionDenial` is asked with the raw
// value the way a cookie presents it.
function deviceSession(loginId: number): string {
  const token = `device token ${loginId} ${++seq}`;
  db.prepare(
    `INSERT INTO sessions (token_hash, login_id, expires_at)
     VALUES (?, ?, datetime('now', '+30 days'))`
  ).run(crypto.createHash("sha256").update(token).digest("hex"), loginId);
  return token;
}
let seq = 0;

// Each case ends the sessions of a login the ACTING admin is not using, and answers with
// the far device's token. Keeping the acting session out of it is what lets one table
// cover both the self-aimed paths and the admin-aimed ones.
const PATHS: [name: string, run: () => Promise<string>][] = [
  [
    "per-device revoke (Settings → Active sessions → Revoke)",
    async () => {
      const me = createLogin({ role: "admin" });
      actAs(me, createProfile("revoke-one", me.id));
      const token = deviceSession(me.id);
      const id = crypto.createHash("sha256").update(token).digest("hex");
      await revokeSessionAction(null, fd({ session_id: id }));
      return token;
    },
  ],
  [
    "Sign out everywhere else",
    async () => {
      const me = createLogin({ role: "admin" });
      actAs(me, createProfile("revoke-others", me.id));
      const token = deviceSession(me.id);
      await signOutOtherSessions();
      return token;
    },
  ],
  [
    "password change evicts the other devices",
    async () => {
      const me = createLogin({ role: "admin" });
      actAs(me, createProfile("revoke-pwchange", me.id));
      const token = deviceSession(me.id);
      const res = await changeOwnPassword(
        fd({ current_password: ACTION_TEST_PASSWORD, new_password: NEW_PASSWORD })
      );
      expect(res.ok, "the password change itself was refused").toBe(true);
      return token;
    },
  ],
  [
    "admin password reset",
    async () => {
      const admin = createLogin({ role: "admin" });
      actAs(admin, createProfile("revoke-reset", admin.id));
      const victim = createLogin({ role: "member" });
      const token = deviceSession(victim.id);
      const res = await resetPassword(fd({ id: victim.id, password: NEW_PASSWORD }));
      expect(res.ok, "the reset itself was refused").toBe(true);
      return token;
    },
  ],
  [
    "Sign out all devices (revokeLoginSessions)",
    async () => {
      const admin = createLogin({ role: "admin" });
      actAs(admin, createProfile("revoke-all", admin.id));
      const victim = createLogin({ role: "member" });
      const token = deviceSession(victim.id);
      const res = await revokeLoginSessions(fd({ id: victim.id }));
      expect(res.ok, "the sign-out itself was refused").toBe(true);
      return token;
    },
  ],
  [
    "deleteLogin takes its sessions with it",
    async () => {
      const admin = createLogin({ role: "admin" });
      actAs(admin, createProfile("revoke-delete", admin.id));
      const victim = createLogin({ role: "member" });
      const token = deviceSession(victim.id);
      const res = await deleteLogin(fd({ id: victim.id }));
      expect(res.ok, "the delete itself was refused").toBe(true);
      return token;
    },
  ],
  [
    "an invite/reset link completed at /set-password",
    async () => {
      const login = createLogin({ role: "member" });
      const token = deviceSession(login.id);
      const link = createAuthToken(login.id, "reset");
      const res = await completeSetPassword({}, fd({ token: link, password: NEW_PASSWORD }));
      expect(res.ok, "the set-password itself was refused").toBe(true);
      return token;
    },
  ],
];

describe("every deliberate session end answers REVOKED on the wire (#3053)", () => {
  it.each(PATHS)("%s", async (_name, run) => {
    const token = await run();
    expect(sessionDenial(token)).toBe<SessionDenial>("revoked");
  });

  // The word is reachable ONLY by presenting the token itself — the reasoning recorded at
  // `SessionDenial` in lib/auth.ts turns on this, so it is asserted rather than argued.
  it("says nothing to a caller that does not hold the token", async () => {
    const admin = createLogin({ role: "admin" });
    actAs(admin, createProfile("revoke-oracle", admin.id));
    const victim = createLogin({ role: "member" });
    const revoked = deviceSession(victim.id);
    const untouched = deviceSession(victim.id);
    await revokeLoginSessions(fd({ id: victim.id }));

    expect(sessionDenial(revoked)).toBe<SessionDenial>("revoked");
    // A guess, an empty cookie, and a live-shaped token nobody revoked all read the same.
    for (const guess of ["", "device token 999 999", `${untouched} but wrong`]) {
      expect(sessionDenial(guess)).toBe<SessionDenial>("unauthorized");
    }
  });
});
