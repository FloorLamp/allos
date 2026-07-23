// DB INTEGRATION TIER — the own-profile association (issue #1013) against a real
// in-memory SQLite handle. Exercises:
//   • ownProfileForLogin / setOwnProfileForLogin: the stored value round-trips and the
//     accessibility constraint (only a profile the login can ACT AS may be marked own —
//     admins reach every profile, members only their grants);
//   • resolveScope's ownProfileId re-validation: an association ∩ accessible survives,
//     an ungranted / revoked / non-existent one resolves to null (the "re-derive
//     against current grants" stance), and isViewingSelf reads the acting profile.
// Fixtures are synthetic (obviously-fictional names) — no PHI.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The DB tier's shared setup mocks @/lib/auth for the action suite; this suite drives
// the real auth core underneath, so restore the real module.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

import { db } from "@/lib/db";
import {
  ownProfileForLogin,
  setOwnProfileForLogin,
  type CurrentSession,
} from "@/lib/auth";
import { resolveScope } from "@/lib/scope";
import { isViewingSelf } from "@/lib/own-profile";

let seq = 0;
function mkLogin(role: "admin" | "member" = "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(`own_user_${role}_${++seq}`, role).lastInsertRowid
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
function revoke(loginId: number, profileId: number): void {
  db.prepare(
    "DELETE FROM login_profiles WHERE login_id = ? AND profile_id = ?"
  ).run(loginId, profileId);
}
function role(loginId: number): "admin" | "member" {
  return (
    db.prepare("SELECT role FROM logins WHERE id = ?").get(loginId) as {
      role: "admin" | "member";
    }
  ).role;
}
function sessionFor(
  loginId: number,
  r: "admin" | "member",
  activeProfileId: number
): CurrentSession {
  return {
    login: { id: loginId, username: `login_${loginId}`, role: r },
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
});

describe("setOwnProfileForLogin / ownProfileForLogin", () => {
  it("a member may mark a GRANTED profile as own; it round-trips", () => {
    const m = mkLogin("member");
    const a = mkProfile("Ada");
    grant(m, a);
    expect(setOwnProfileForLogin(m, "member", a)).toBe(true);
    expect(ownProfileForLogin(m)).toBe(a);
  });

  it("a member may NOT mark an ungranted profile as own (no-op)", () => {
    const m = mkLogin("member");
    const a = mkProfile("Ada");
    const hidden = mkProfile("Hidden");
    grant(m, a);
    expect(setOwnProfileForLogin(m, "member", hidden)).toBe(false);
    expect(ownProfileForLogin(m)).toBeNull();
  });

  it("an admin may mark ANY profile as own (implicit all-access)", () => {
    const admin = mkLogin("admin");
    const anyProfile = mkProfile("Grace");
    expect(setOwnProfileForLogin(admin, "admin", anyProfile)).toBe(true);
    expect(ownProfileForLogin(admin)).toBe(anyProfile);
  });

  it("null clears the association", () => {
    const m = mkLogin("member");
    const a = mkProfile("Ada");
    grant(m, a);
    setOwnProfileForLogin(m, "member", a);
    expect(setOwnProfileForLogin(m, "member", null)).toBe(true);
    expect(ownProfileForLogin(m)).toBeNull();
  });
});

describe("resolveScope: own-profile re-validation + the self predicate", () => {
  it("acting AS the own profile → isViewingSelf true; ownProfileId carried", () => {
    const m = mkLogin("member");
    const a = mkProfile("Ada");
    const b = mkProfile("Bea");
    grant(m, a);
    grant(m, b);
    setOwnProfileForLogin(m, "member", a);
    const scope = resolveScope(
      sessionFor(m, "member", a),
      null,
      ownProfileForLogin(m)
    );
    expect(scope.ownProfileId).toBe(a);
    expect(isViewingSelf(scope)).toBe(true);
  });

  it("acting as ANOTHER profile → not self, but ownProfileId still carried", () => {
    const m = mkLogin("member");
    const a = mkProfile("Ada");
    const b = mkProfile("Bea");
    grant(m, a);
    grant(m, b);
    setOwnProfileForLogin(m, "member", a);
    const scope = resolveScope(
      sessionFor(m, "member", b),
      null,
      ownProfileForLogin(m)
    );
    expect(scope.ownProfileId).toBe(a);
    expect(isViewingSelf(scope)).toBe(false);
  });

  it("no own-profile set → ownProfileId null, never self", () => {
    const m = mkLogin("member");
    const a = mkProfile("Ada");
    grant(m, a);
    const scope = resolveScope(
      sessionFor(m, "member", a),
      null,
      ownProfileForLogin(m)
    );
    expect(scope.ownProfileId).toBeNull();
    expect(isViewingSelf(scope)).toBe(false);
  });

  it("a REVOKED own-profile grant resolves to null (re-derive against grants)", () => {
    const m = mkLogin("member");
    const a = mkProfile("Ada");
    const b = mkProfile("Bea");
    grant(m, a);
    grant(m, b);
    setOwnProfileForLogin(m, "member", a);
    // Stored value still points at `a`, but the grant is gone — the scope must not
    // resolve it as self.
    revoke(m, a);
    const scope = resolveScope(
      sessionFor(m, "member", b),
      null,
      ownProfileForLogin(m)
    );
    expect(scope.ownProfileId).toBeNull();
  });

  it("an admin's own-profile survives (admins reach every profile)", () => {
    const admin = mkLogin("admin");
    const p = mkProfile("Grace");
    setOwnProfileForLogin(admin, "admin", p);
    const scope = resolveScope(
      sessionFor(admin, role(admin), p),
      null,
      ownProfileForLogin(admin)
    );
    expect(scope.ownProfileId).toBe(p);
    expect(isViewingSelf(scope)).toBe(true);
  });
});
