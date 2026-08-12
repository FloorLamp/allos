// SERVER-ACTION TIER — session revocation writes an audit event (#1843).
//
// The hole this pins: an admin could force-terminate ANOTHER login's live
// sessions and leave nothing behind, while resetPassword — ninety lines away in
// the same file, doing strictly more — recorded an event. In an app where one
// login can reach another person's health record, "who ended that person's
// session, and when" is the accountability question the trail exists to answer.
//
// Also pinned: the event is written only when a session ACTUALLY ended. A forged
// session id, or a sign-out-everywhere on an account with no other devices,
// deletes nothing and must not leave a row claiming otherwise.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  revokeSessionAction,
  signOutOtherSessions,
} from "@/app/(app)/settings/actions";
import { revokeLoginSessions } from "@/app/(app)/settings/family/actions";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

interface AuditRow {
  login_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
}

// Every audit row this login is the ACTOR of, newest last.
function auditFor(loginId: number): AuditRow[] {
  return db
    .prepare(
      "SELECT login_id, action, target, detail FROM audit_events WHERE login_id = ? ORDER BY id"
    )
    .all(loginId) as AuditRow[];
}

// A live session row for a login. `tokenHash` is an obviously-fake local marker,
// not a credential: revokeSession/destroyLoginSessions only ever compare it.
function seedSession(loginId: number, tokenHash: string): string {
  db.prepare(
    `INSERT INTO sessions (token_hash, login_id, expires_at)
     VALUES (?, ?, datetime('now', '+30 days'))`
  ).run(tokenHash, loginId);
  return tokenHash;
}

function sessionCount(loginId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE login_id = ?")
      .get(loginId) as { c: number }
  ).c;
}

describe("admin force sign-out of another login (#1843)", () => {
  it("records who ended whose sessions, and how many", async () => {
    const admin = createLogin({ role: "admin" });
    const member = createLogin({ role: "member" });
    const profile = createProfile("revoke-admin-path", admin.id);
    actAs(admin, profile);

    seedSession(member.id, `fake-session-a-${member.id}`);
    seedSession(member.id, `fake-session-b-${member.id}`);

    const res = await revokeLoginSessions(fd({ id: member.id }));
    expect(res.ok).toBe(true);
    expect(sessionCount(member.id)).toBe(0);

    const rows = auditFor(admin.id);
    expect(rows).toHaveLength(1);
    // The ACTOR is the admin; the TARGET is the login that got signed out. Both
    // halves matter — an event that recorded only the target would answer "whose
    // session ended" while leaving "who ended it" exactly as unanswerable as
    // before.
    expect(rows[0].login_id).toBe(admin.id);
    expect(rows[0].action).toBe(AUDIT_ACTIONS.sessionRevokeAll);
    expect(rows[0].target).toBe(String(member.id));
    expect(rows[0].detail).toBe("2 session(s)");
  });

  it("writes nothing when the target had no live session", async () => {
    const admin = createLogin({ role: "admin" });
    const member = createLogin({ role: "member" });
    const profile = createProfile("revoke-admin-noop", admin.id);
    actAs(admin, profile);

    const res = await revokeLoginSessions(fd({ id: member.id }));
    expect(res.ok).toBe(true);
    expect(auditFor(admin.id)).toEqual([]);
  });

  it("refuses a non-admin — the gate is on the action, not the navigation", async () => {
    const member = createLogin({ role: "member" });
    const profile = createProfile("revoke-admin-gate", member.id);
    actAs(member, profile);
    const victim = createLogin({ role: "member" });
    seedSession(victim.id, `fake-session-gate-${victim.id}`);

    await expect(revokeLoginSessions(fd({ id: victim.id }))).rejects.toThrow(
      /requireAdmin/
    );
    expect(sessionCount(victim.id)).toBe(1);
  });
});

describe("a login revoking its own sessions (#1843)", () => {
  it("records one event per session actually revoked", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("revoke-self-one", login.id);
    actAs(login, profile);
    const hash = seedSession(login.id, `fake-session-self-${login.id}`);

    await revokeSessionAction(fd({ session_id: hash }));

    const rows = auditFor(login.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AUDIT_ACTIONS.sessionRevoke);
    expect(rows[0].target).toBe(String(login.id));
    expect(sessionCount(login.id)).toBe(0);
  });

  it("writes nothing for a session id that revokes nothing", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("revoke-self-forged", login.id);
    actAs(login, profile);
    // A stale id (the device was already signed out) and another login's id both
    // land here: revokeSession scopes its DELETE to the caller, so neither ends
    // anything, and an audit row for either would be a lie in the trail.
    const other = createLogin({ role: "member" });
    const foreign = seedSession(other.id, `fake-session-foreign-${other.id}`);

    await revokeSessionAction(fd({ session_id: "no-such-session" }));
    await revokeSessionAction(fd({ session_id: foreign }));

    expect(auditFor(login.id)).toEqual([]);
    expect(sessionCount(other.id)).toBe(1);
  });

  it("sign out everywhere else records the count, and nothing when there were none", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("revoke-self-all", login.id);
    actAs(login, profile);

    await signOutOtherSessions();
    expect(auditFor(login.id)).toEqual([]);

    seedSession(login.id, `fake-session-all-a-${login.id}`);
    seedSession(login.id, `fake-session-all-b-${login.id}`);
    seedSession(login.id, `fake-session-all-c-${login.id}`);

    await signOutOtherSessions();
    const rows = auditFor(login.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AUDIT_ACTIONS.sessionRevokeAll);
    expect(rows[0].detail).toBe("3 session(s)");
  });
});
