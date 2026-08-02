// SERVER-ACTION TIER (#1836) — the row-level management actions the #1874 page consumes:
// login rename, post-creation software edit, and the atomic "Change profile" re-map.
//
// The re-map is the one that matters: it is an access-control transition touching TWO
// profiles (records routed away from one, onto another), performed as ONE compare-and-
// swap so there is never a window where the label is unmapped. The refusals pinned here:
// a stale expectation is a typed outcome, and a caller must hold write on BOTH sides.

import { describe, expect, it } from "vitest";
import {
  editPortalSoftwareAction,
  remapIdentityAction,
  renameAccountAction,
} from "@/app/(app)/integrations/patient-portals/actions";
import {
  ACCOUNT_NAME_ERROR,
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  portalById,
  portalIdentityState,
} from "@/lib/portals";
import { actAs, createLogin, createProfile, fd } from "./harness";

let portalSeq = 0;
function makePortal(): { portalId: number; accountId: number } {
  const r = createPortal(`Manage Portal ${++portalSeq}`);
  expect(r.ok).toBe(true);
  const portalId = r.ok ? r.id : 0;
  return { portalId, accountId: accountsForPortal(portalId)[0].id };
}

describe("renameAccountAction (#1836)", () => {
  it("renames a login for an admin, including onto an email-shaped name (#1829)", async () => {
    const { portalId } = makePortal();
    const made = createPortalAccount(portalId, "Old Nickname");
    expect(made.ok).toBe(true);
    const accountId = made.ok ? made.id : 0;

    const login = createLogin({ role: "admin" });
    actAs(login, createProfile("Rename Admin", login.id));

    expect(
      await renameAccountAction(
        fd({ account_id: accountId, name: "dana@example.com" })
      )
    ).toEqual({ ok: true });
    expect(
      accountsForPortal(portalId).find((a) => a.id === accountId)!.name
    ).toBe("dana@example.com");
  });

  it("surfaces ACCOUNT_NAME_ERROR for an address-shaped name, as a typed outcome", async () => {
    const { portalId } = makePortal();
    const made = createPortalAccount(portalId, "Keeps Name");
    expect(made.ok).toBe(true);
    const accountId = made.ok ? made.id : 0;

    const login = createLogin({ role: "admin" });
    actAs(login, createProfile("Rename Url Admin", login.id));

    expect(
      await renameAccountAction(
        fd({ account_id: accountId, name: "https://portal.example.org" })
      )
    ).toEqual({ ok: false, error: ACCOUNT_NAME_ERROR });
    expect(
      accountsForPortal(portalId).find((a) => a.id === accountId)!.name
    ).toBe("Keeps Name");
  });

  it("is registry maintenance: a member is bounced at the gate", async () => {
    const { accountId } = makePortal();
    const login = createLogin({ role: "member" });
    actAs(login, createProfile("Rename Member", login.id));

    await expect(
      renameAccountAction(fd({ account_id: accountId, name: "Mine Now" }))
    ).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("reports a typed refusal for a garbage or missing id", async () => {
    const login = createLogin({ role: "admin" });
    actAs(login, createProfile("Rename Garbage", login.id));
    expect(
      await renameAccountAction(fd({ account_id: "nope", name: "X" }))
    ).toEqual({ ok: false, error: "Unknown login." });
    expect(
      await renameAccountAction(fd({ account_id: 999_999, name: "X" }))
    ).toEqual({ ok: false, error: "That login is already gone." });
  });
});

describe("editPortalSoftwareAction (#1836)", () => {
  it("lets an admin re-tag an existing portal, including the new ecw value", async () => {
    const { portalId } = makePortal();
    const login = createLogin({ role: "admin" });
    actAs(login, createProfile("Software Admin", login.id));

    expect(
      await editPortalSoftwareAction(
        fd({ portal_id: portalId, software: "ecw" })
      )
    ).toEqual({ ok: true });
    expect(portalById(portalId)!.software).toBe("ecw");

    // "Not sure" clears the tag rather than storing a sentinel.
    expect(
      await editPortalSoftwareAction(fd({ portal_id: portalId, software: "" }))
    ).toEqual({ ok: true });
    expect(portalById(portalId)!.software).toBeNull();
  });

  it("refuses an unknown value with a typed outcome — bare TEXT, boundary-validated", async () => {
    const { portalId } = makePortal();
    const login = createLogin({ role: "admin" });
    actAs(login, createProfile("Software Bad Admin", login.id));

    expect(
      await editPortalSoftwareAction(
        fd({ portal_id: portalId, software: "allscripts" })
      )
    ).toEqual({ ok: false, error: "Unknown portal software." });
  });

  it("is registry maintenance: a member is bounced at the gate", async () => {
    const { portalId } = makePortal();
    const login = createLogin({ role: "member" });
    actAs(login, createProfile("Software Member", login.id));

    await expect(
      editPortalSoftwareAction(fd({ portal_id: portalId, software: "mychart" }))
    ).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe("remapIdentityAction — the atomic Change profile (#1836)", () => {
  it("re-points a binding between two profiles the caller may write", async () => {
    const { accountId } = makePortal();
    const login = createLogin({ role: "member" });
    const from = createProfile("Remap From", login.id);
    const to = createProfile("Remap To", login.id);
    actAs(login, from);

    const bound = bindPortalIdentity(accountId, "REMAP, ACTION", from.id);
    expect(bound.ok).toBe(true);
    const id = bound.ok ? bound.id : 0;

    expect(
      await remapIdentityAction(
        fd({
          identity_id: id,
          expected_profile_id: from.id,
          profile_id: to.id,
        })
      )
    ).toEqual({ ok: true });
    expect(portalIdentityState(id)).toEqual({
      profileId: to.id,
      ignored: false,
    });
  });

  it("REFUSES a stale expected profile with a typed outcome, changing nothing", async () => {
    const { accountId } = makePortal();
    const login = createLogin({ role: "member" });
    const from = createProfile("Stale From", login.id);
    const to = createProfile("Stale To", login.id);
    const third = createProfile("Stale Third", login.id);
    actAs(login, from);

    const bound = bindPortalIdentity(accountId, "REMAP, RACED", from.id);
    expect(bound.ok).toBe(true);
    const id = bound.ok ? bound.id : 0;

    // A concurrent writer re-points the row after this screen rendered it.
    expect(
      await remapIdentityAction(
        fd({ identity_id: id, expected_profile_id: from.id, profile_id: to.id })
      )
    ).toEqual({ ok: true });

    // The stale screen saves too — its expectation no longer describes the row.
    expect(
      await remapIdentityAction(
        fd({
          identity_id: id,
          expected_profile_id: from.id,
          profile_id: third.id,
        })
      )
    ).toEqual({
      ok: false,
      error: "This mapping changed while you were editing — check it again.",
    });
    expect(portalIdentityState(id)).toEqual({
      profileId: to.id,
      ignored: false,
    });
  });

  it("REFUSES a caller without write on the profile the binding currently points at", async () => {
    const { accountId } = makePortal();
    const victimLogin = createLogin({ role: "member" });
    const victim = createProfile("Remap Victim", victimLogin.id);
    const bound = bindPortalIdentity(accountId, "REMAP, VICTIM", victim.id);
    expect(bound.ok).toBe(true);
    const id = bound.ok ? bound.id : 0;

    // The attacker holds genuine write on their own profile — the TARGET gate alone
    // would pass, so the gate on the CURRENT owner is what protects the victim.
    const attackerLogin = createLogin({ role: "member" });
    const attacker = createProfile("Remap Attacker", attackerLogin.id);
    actAs(attackerLogin, attacker);

    await expect(
      remapIdentityAction(
        fd({
          identity_id: id,
          expected_profile_id: victim.id,
          profile_id: attacker.id,
        })
      )
    ).rejects.toThrow(/not accessible|read-only/);
    expect(portalIdentityState(id)).toEqual({
      profileId: victim.id,
      ignored: false,
    });
  });

  it("REFUSES a target profile the caller cannot write", async () => {
    const { accountId } = makePortal();
    const login = createLogin({ role: "member" });
    const own = createProfile("Remap Own", login.id);
    const strangerLogin = createLogin({ role: "member" });
    const stranger = createProfile("Remap Stranger", strangerLogin.id);
    actAs(login, own);

    const bound = bindPortalIdentity(accountId, "REMAP, OUTBOUND", own.id);
    expect(bound.ok).toBe(true);
    const id = bound.ok ? bound.id : 0;

    await expect(
      remapIdentityAction(
        fd({
          identity_id: id,
          expected_profile_id: own.id,
          profile_id: stranger.id,
        })
      )
    ).rejects.toThrow(/not accessible|read-only/);
    expect(portalIdentityState(id)).toEqual({
      profileId: own.id,
      ignored: false,
    });
  });

  it("reports typed refusals for gone, ignored, and garbage rows", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Remap Typed", login.id);
    actAs(login, profile);

    expect(
      await remapIdentityAction(
        fd({
          identity_id: 999_999,
          expected_profile_id: profile.id,
          profile_id: profile.id,
        })
      )
    ).toEqual({ ok: false, error: "That mapping is already gone." });
    expect(
      await remapIdentityAction(
        fd({ identity_id: "nope", expected_profile_id: 1, profile_id: 1 })
      )
    ).toEqual({ ok: false, error: "Unknown mapping." });
    expect(
      await remapIdentityAction(fd({ identity_id: 1, profile_id: "x" }))
    ).toEqual({ ok: false, error: "Choose a profile." });
  });
});
