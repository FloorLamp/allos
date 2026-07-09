import { describe, it, expect } from "vitest";
import {
  canDeleteLogin,
  canDeleteProfile,
  membersLosingAllAccess,
} from "../family-deletion";

describe("canDeleteLogin", () => {
  it("refuses the last admin", () => {
    const d = canDeleteLogin({ role: "admin", adminCount: 1 });
    expect(d.ok).toBe(false);
  });

  it("allows an admin when another admin remains", () => {
    expect(canDeleteLogin({ role: "admin", adminCount: 2 })).toEqual({
      ok: true,
    });
  });

  it("always allows a member (even when only one admin exists)", () => {
    expect(canDeleteLogin({ role: "member", adminCount: 1 })).toEqual({
      ok: true,
    });
  });
});

describe("canDeleteProfile", () => {
  it("refuses the last remaining profile", () => {
    expect(canDeleteProfile({ profileCount: 1 }).ok).toBe(false);
  });

  it("refuses when count is somehow zero", () => {
    expect(canDeleteProfile({ profileCount: 0 }).ok).toBe(false);
  });

  it("allows when more than one profile remains", () => {
    expect(canDeleteProfile({ profileCount: 2 })).toEqual({ ok: true });
  });
});

describe("membersLosingAllAccess", () => {
  it("flags a member whose only grant is the deleted profile", () => {
    expect(
      membersLosingAllAccess(5, [{ username: "kiddo", profileIds: [5] }])
    ).toEqual(["kiddo"]);
  });

  it("does not flag a member who keeps another grant", () => {
    expect(
      membersLosingAllAccess(5, [{ username: "kiddo", profileIds: [5, 6] }])
    ).toEqual([]);
  });

  it("ignores members who were never granted the profile", () => {
    expect(
      membersLosingAllAccess(5, [{ username: "other", profileIds: [6] }])
    ).toEqual([]);
  });

  it("returns usernames sorted case-insensitively", () => {
    expect(
      membersLosingAllAccess(5, [
        { username: "Zed", profileIds: [5] },
        { username: "amy", profileIds: [5] },
      ])
    ).toEqual(["amy", "Zed"]);
  });

  it("returns empty when no members are given", () => {
    expect(membersLosingAllAccess(5, [])).toEqual([]);
  });
});
