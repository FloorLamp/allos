// DB INTEGRATION TIER — the ProfileScope primitive (lib/scope.ts) against a real
// in-memory SQLite handle (issue #1095). resolveScope reads the accessible set +
// per-profile access map from the DB (accessibleProfilesForLogin / accessForProfile),
// so its resolution — the admin/member matrix, the disambiguated names (#534), the
// access map, and the viewIds ∩ accessible validation — is exercised here against
// real logins/profiles/grants. Also proves the set-based `profile_id IN` rail
// (lib/cross-profile.ts → profileIdsIn) binds by scope.ids and confines the result to
// the accessible set, and that a write to a profile OUTSIDE the scope is rejected
// through the scope path (the existing accessForProfile behavior, now asserted via
// scope.access + scope.ids).

import { describe, it, expect, beforeEach, vi } from "vitest";

// This DB tier's shared setup mocks @/lib/auth for the server-action suite; THIS
// suite is about the real auth core underneath scope, so restore the real module.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

import { db } from "@/lib/db";
import type { CurrentSession } from "@/lib/auth";
import { resolveScope, stampSubjects } from "@/lib/scope";
import { profileIdsIn } from "@/lib/cross-profile";

let seq = 0;
function mkLogin(role: "admin" | "member" = "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(`scope_user_${role}_${++seq}`, role).lastInsertRowid
  );
}

function mkProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function grant(
  loginId: number,
  profileId: number,
  access: "read" | "write" = "write"
): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
  ).run(loginId, profileId, access);
}

// Minimal CurrentSession — resolveScope only reads login.{id,role} + profile.id.
function sessionFor(
  loginId: number,
  role: "admin" | "member",
  activeProfileId: number
): CurrentSession {
  return {
    login: { id: loginId, username: `login_${loginId}`, role },
    profile: {
      id: activeProfileId,
      name: `p_${activeProfileId}`,
      photo_path: null,
      photo_version: 0,
    },
    access: "write",
  };
}

beforeEach(() => {
  db.prepare("DELETE FROM login_profiles").run();
  db.prepare("DELETE FROM body_metrics").run();
});

describe("resolveScope: the admin/member access matrix", () => {
  it("a member scope carries only granted profiles, in id order", () => {
    const member = mkLogin("member");
    const a = mkProfile("Ada");
    const b = mkProfile("Grace");
    const ungranted = mkProfile("Hidden");
    grant(member, a);
    grant(member, b);

    const scope = resolveScope(sessionFor(member, "member", a));
    expect(scope.ids).toEqual([a, b]);
    expect(scope.ids).not.toContain(ungranted);
    expect(scope.actingProfileId).toBe(a);
    expect(scope.role).toBe("member");
    expect(scope.loginId).toBe(member);
    // #1013/#1096 shape carried but inert here.
    expect(scope.ownProfileId).toBeNull();
  });

  it("an admin scope sees every profile (grant bypass)", () => {
    const admin = mkLogin("admin");
    const a = mkProfile("A");
    const b = mkProfile("B");
    const c = mkProfile("C");

    const scope = resolveScope(sessionFor(admin, "admin", a));
    // Admin sees all profiles that exist (ids accumulate across tests, so assert
    // superset containment, not exact equality).
    for (const id of [a, b, c]) expect(scope.ids).toContain(id);
  });

  it("the access map reflects per-profile grants (read vs write); admin is all-write", () => {
    const member = mkLogin("member");
    const admin = mkLogin("admin");
    const readP = mkProfile("Read-only");
    const writeP = mkProfile("Writable");
    grant(member, readP, "read");
    grant(member, writeP, "write");

    const mScope = resolveScope(sessionFor(member, "member", writeP));
    expect(mScope.access.get(readP)).toBe("read");
    expect(mScope.access.get(writeP)).toBe("write");

    const aScope = resolveScope(sessionFor(admin, "admin", readP));
    expect(aScope.access.get(readP)).toBe("write");
    expect(aScope.access.get(writeP)).toBe("write");
  });

  it("disambiguates two profiles that share a name (#534)", () => {
    const member = mkLogin("member");
    const a = mkProfile("Alex");
    const b = mkProfile("Alex");
    grant(member, a);
    grant(member, b);

    const scope = resolveScope(sessionFor(member, "member", a));
    const names = scope.profiles.map((p) => p.name).sort();
    expect(names).toEqual(["Alex (1)", "Alex (2)"]);
  });
});

describe("resolveScope: viewIds validation (∩ accessible, default acting)", () => {
  let member: number;
  let a: number;
  let b: number;
  let ungranted: number;

  beforeEach(() => {
    member = mkLogin("member");
    a = mkProfile("View A");
    b = mkProfile("View B");
    ungranted = mkProfile("View X");
    grant(member, a);
    grant(member, b);
  });

  it("defaults to [actingProfileId] when no raw view-set is given", () => {
    const scope = resolveScope(sessionFor(member, "member", a));
    expect(scope.viewIds).toEqual([a]);
  });

  it("intersects the raw view-set with the accessible set, dropping ungranted / nonexistent", () => {
    const scope = resolveScope(sessionFor(member, "member", a), [
      a,
      b,
      ungranted,
      999999,
    ]);
    expect(scope.viewIds).toEqual([a, b]); // accessible order preserved, ungranted dropped
  });

  it("falls back to [acting] when the raw view-set intersects to nothing (can't widen past grants)", () => {
    const scope = resolveScope(sessionFor(member, "member", a), [
      ungranted,
      999999,
    ]);
    expect(scope.viewIds).toEqual([a]);
  });

  it("preserves accessible id order regardless of the raw input order", () => {
    const scope = resolveScope(sessionFor(member, "member", b), [b, a]);
    expect(scope.viewIds).toEqual([a, b]);
  });
});

describe("stampSubjects: one disambiguated subject resolution", () => {
  it("stamps each row's subject from the scope (name, avatar, access)", () => {
    const member = mkLogin("member");
    const a = mkProfile("Sam");
    const b = mkProfile("Sam");
    grant(member, a);
    grant(member, b, "read");
    const scope = resolveScope(sessionFor(member, "member", a));

    const rows = [
      { profileId: a, value: 1 },
      { profileId: b, value: 2 },
    ];
    const stamped = stampSubjects(scope, rows);
    expect(stamped[0].subject.name).toBe("Sam (1)");
    expect(stamped[0].subject.access).toBe("write");
    expect(stamped[0].value).toBe(1);
    expect(stamped[1].subject.name).toBe("Sam (2)");
    expect(stamped[1].subject.access).toBe("read");
  });

  it("falls back safely for a row whose profile is not in scope (stable label, read access)", () => {
    const member = mkLogin("member");
    const a = mkProfile("Only");
    grant(member, a);
    const scope = resolveScope(sessionFor(member, "member", a));

    const [stamped] = stampSubjects(scope, [{ profileId: 424242 }]);
    expect(stamped.subject.name).toBe("Profile 424242");
    expect(stamped.subject.access).toBe("read"); // most-restrictive fallback
  });
});

describe("set-based cross-profile SQL (profileIdsIn) confines to scope.ids", () => {
  it("a profile_id IN (scope.ids) read returns only in-scope rows, never an ungranted profile's", () => {
    const member = mkLogin("member");
    const a = mkProfile("Reads A");
    const b = mkProfile("Reads B");
    const ungranted = mkProfile("Reads X");
    grant(member, a);
    grant(member, b);
    for (const pid of [a, b, ungranted]) {
      db.prepare(
        "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, '2026-01-01', 70)"
      ).run(pid);
    }
    const scope = resolveScope(sessionFor(member, "member", a));

    // The exact shape a registered cross-profile reader would use: the IN-list is
    // bound params from scope.ids, never interpolated.
    const rows = db
      .prepare(
        `SELECT profile_id AS pid FROM body_metrics WHERE profile_id IN ${profileIdsIn(scope.ids)} ORDER BY profile_id`
      )
      .all(...scope.ids) as { pid: number }[];
    const seen = rows.map((r) => r.pid);
    expect(seen).toEqual([a, b]);
    expect(seen).not.toContain(ungranted);
  });

  it("an empty scope set matches nothing (IN (NULL)), never everything", () => {
    const a = mkProfile("Solo");
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, '2026-01-01', 70)"
    ).run(a);
    const rows = db
      .prepare(
        `SELECT profile_id AS pid FROM body_metrics WHERE profile_id IN ${profileIdsIn([])}`
      )
      .all() as { pid: number }[];
    expect(rows).toEqual([]);
  });
});

describe("write refusal through the scope path (unchanged access semantics)", () => {
  it("a profile outside the scope set is neither in scope.ids nor grants write access", () => {
    // #1095 §5: writes stay single-target through requireProfileWriteAccess; scope
    // only powers read-only labels. This asserts the existing refusal through the
    // scope object: an ungranted profile is absent from scope.ids AND its access
    // entry is absent (undefined), so no scope-driven affordance can offer a write.
    const member = mkLogin("member");
    const granted = mkProfile("Mine");
    const outside = mkProfile("Not mine");
    grant(member, granted);
    const scope = resolveScope(sessionFor(member, "member", granted));

    expect(scope.ids).toContain(granted);
    expect(scope.ids).not.toContain(outside);
    expect(scope.access.get(granted)).toBe("write");
    expect(scope.access.has(outside)).toBe(false);
  });
});
