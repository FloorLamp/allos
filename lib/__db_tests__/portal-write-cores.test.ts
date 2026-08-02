// DB INTEGRATION TIER — the #1836 write cores: account rename, post-creation software
// edit, and the atomic "Change profile" re-map.
//
// The test that matters most is the CAS refusal: remapPortalIdentity is ONE
// compare-and-swap (expected current profile → new profile), never unmap-then-rebind, so
// a stale expectation must change NOTHING — the row keeps pointing where the concurrent
// writer left it, and there is never a window where the label is unmapped.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  ACCOUNT_NAME_ERROR,
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  ignorePortalIdentity,
  isPortalSoftware,
  portalById,
  portalIdentityState,
  remapPortalIdentity,
  renamePortalAccount,
  resolvePortalIdentity,
  setPortalSoftware,
  SOFTWARE_VALUES,
  type PortalAccount,
} from "@/lib/portals";

let portalId: number;
let account: PortalAccount;
let profileOne: number;
let profileTwo: number;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

beforeAll(() => {
  const made = createPortal("Write Cores Portal");
  expect(made.ok).toBe(true);
  portalId = made.ok ? made.id : 0;
  account = accountsForPortal(portalId)[0];
  profileOne = newProfile("CORES-ONE");
  profileTwo = newProfile("CORES-TWO");
});

describe("the software vocabulary derives from one tuple (#1836)", () => {
  it("admits ecw and every other listed value, and nothing else", () => {
    for (const value of SOFTWARE_VALUES) {
      expect(isPortalSoftware(value)).toBe(true);
    }
    expect(isPortalSoftware("ecw")).toBe(true);
    expect(isPortalSoftware("epic")).toBe(false);
    expect(isPortalSoftware("")).toBe(false);
  });
});

describe("setPortalSoftware", () => {
  it("edits the tag after creation, including onto the new ecw value", () => {
    const r = setPortalSoftware(portalId, "ecw");
    expect(r).toEqual({ ok: true, id: portalId });
    expect(portalById(portalId)!.software).toBe("ecw");
  });

  it("clears the tag with an empty value — 'Not sure' stores nothing", () => {
    setPortalSoftware(portalId, "mychart");
    const r = setPortalSoftware(portalId, "");
    expect(r.ok).toBe(true);
    expect(portalById(portalId)!.software).toBeNull();
  });

  it("refuses an unknown value at the write boundary — the column is bare TEXT", () => {
    setPortalSoftware(portalId, "cerner");
    const r = setPortalSoftware(portalId, "allscripts");
    expect(r).toEqual({ ok: false, error: "Unknown portal software." });
    expect(portalById(portalId)!.software).toBe("cerner");
  });

  it("refuses a portal that is gone", () => {
    const r = setPortalSoftware(999_999, "mychart");
    expect(r.ok).toBe(false);
  });
});

describe("renamePortalAccount (#1836/#1829)", () => {
  it("renames the display name and never the slug the tool config quotes", () => {
    const made = createPortalAccount(portalId, "Rename Me");
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : 0;
    const before = accountsForPortal(portalId).find((a) => a.id === id)!;

    const r = renamePortalAccount(id, "Renamed Login");
    expect(r).toEqual({ ok: true, id });
    const after = accountsForPortal(portalId).find((a) => a.id === id)!;
    expect(after.name).toBe("Renamed Login");
    expect(after.slug).toBe(before.slug);
  });

  it("accepts an email-shaped name — the one narrowing of the no-address rule", () => {
    const made = createPortalAccount(portalId, "Email Rename");
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : 0;
    const r = renamePortalAccount(id, "dana@example.com");
    expect(r.ok).toBe(true);
    expect(accountsForPortal(portalId).find((a) => a.id === id)!.name).toBe(
      "dana@example.com"
    );
  });

  it("still refuses every other address shape, with ACCOUNT_NAME_ERROR", () => {
    const made = createPortalAccount(portalId, "Url Rename");
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : 0;
    for (const bad of [
      "https://portal.example.org/login",
      "mailto:dana@example.com",
      "portal.example.org",
    ]) {
      const r = renamePortalAccount(id, bad);
      expect(r).toEqual({ ok: false, error: ACCOUNT_NAME_ERROR });
    }
    expect(accountsForPortal(portalId).find((a) => a.id === id)!.name).toBe(
      "Url Rename"
    );
  });

  it("refuses an empty name and a login that is gone", () => {
    const made = createPortalAccount(portalId, "Empty Rename");
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : 0;
    expect(renamePortalAccount(id, "   ").ok).toBe(false);
    expect(renamePortalAccount(999_999, "Ghost").ok).toBe(false);
  });
});

describe("remapPortalIdentity — the atomic Change profile (#1836)", () => {
  it("re-points the binding in one statement when the expectation holds", () => {
    const bound = bindPortalIdentity(account.id, "REMAP, HAPPY", profileOne);
    expect(bound.ok).toBe(true);
    const id = bound.ok ? bound.id : 0;

    expect(remapPortalIdentity(id, profileOne, profileTwo)).toBe(true);
    expect(portalIdentityState(id)).toEqual({
      profileId: profileTwo,
      ignored: false,
    });
    // The upload path resolves to the new profile immediately — no unmapped window
    // ever existed for a companion-tool push to fall into. The account is NAMED
    // because the rename fixtures above gave this portal several logins.
    const resolved = resolvePortalIdentity(
      portalById(portalId)!.slug,
      account.slug,
      "REMAP, HAPPY"
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.profileId).toBe(profileTwo);
  });

  it("REFUSES a stale expected profile and changes nothing", () => {
    const bound = bindPortalIdentity(account.id, "REMAP, STALE", profileOne);
    expect(bound.ok).toBe(true);
    const id = bound.ok ? bound.id : 0;

    // A concurrent writer re-points the row between the caller's read and its swap.
    expect(remapPortalIdentity(id, profileOne, profileTwo)).toBe(true);

    // The caller's swap still expects profileOne: the compare fails, nothing moves.
    expect(remapPortalIdentity(id, profileOne, profileOne)).toBe(false);
    expect(portalIdentityState(id)).toEqual({
      profileId: profileTwo,
      ignored: false,
    });
  });

  it("never touches an IGNORED row — there is no profile to compare against", () => {
    const ignored = ignorePortalIdentity(account.id, "REMAP, IGNORED");
    expect(ignored.ok).toBe(true);
    const id = ignored.ok ? ignored.id : 0;
    expect(remapPortalIdentity(id, profileOne, profileTwo)).toBe(false);
    expect(portalIdentityState(id)).toEqual({ profileId: null, ignored: true });
  });

  it("returns false for a row that does not exist", () => {
    expect(remapPortalIdentity(999_999, profileOne, profileTwo)).toBe(false);
  });
});
