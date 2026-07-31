// SERVER-ACTION TIER (#1747) — the authorization boundary on the MyChart portal
// identity bindings.
//
// A binding decides WHERE a person's records land, so removing one is an
// access-control transition. The bug this file pins down: the action used to gate on a
// `profile_id` read straight out of the same client FormData that named the row id, so
// the value that was checked and the row that was deleted were never tied together. A
// caller with legitimate write access to their OWN profile could post someone else's
// binding id alongside their own profile id and delete a mapping on a profile they
// cannot reach at all.
//
// The fix is that the owning profile is resolved FROM THE ROW and the gate is on that,
// with the delete itself scoped to (id, profile_id). These tests therefore assert the
// forgery is refused *and* that the victim's row survives — a refusal that still
// deleted the row would be no fix.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  bindIdentityAction,
  unbindIdentityAction,
} from "@/app/(app)/integrations/mychart/actions";
import {
  bindPortalIdentity,
  createPortal,
  portalIdentityProfile,
} from "@/lib/portals";
import { actAs, createLogin, createProfile, fd } from "./harness";

let portalSeq = 0;
function makePortal(): number {
  const slug = `unbind-portal-${++portalSeq}`;
  const r = createPortal(slug, `Unbind Portal ${portalSeq}`);
  expect(r.ok).toBe(true);
  return r.ok ? r.id : 0;
}

function identityExists(id: number): boolean {
  return (
    db.prepare("SELECT 1 FROM portal_identities WHERE id = ?").get(id) != null
  );
}

describe("unbindIdentityAction authorization (#1747)", () => {
  it("REFUSES to delete another profile's binding, even with a forged profile_id the caller may write", async () => {
    const portalId = makePortal();

    // The victim: a profile the attacker has no grant on at all.
    const victimLogin = createLogin({ role: "member" });
    const victimProfile = createProfile("Unbind Victim", victimLogin.id);
    const bound = bindPortalIdentity(
      portalId,
      "Victim Patient",
      victimProfile.id
    );
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    // The attacker: a member with genuine write access to their own profile only.
    const attackerLogin = createLogin({ role: "member" });
    const attackerProfile = createProfile("Unbind Attacker", attackerLogin.id);
    actAs(attackerLogin, attackerProfile);

    // The forged post: someone else's row id, their own profile id. The gate on the
    // supplied profile id would pass — they really can write it — so the only thing
    // that can save the victim's binding is resolving the row's real owner.
    await expect(
      unbindIdentityAction(
        fd({ identity_id: bound.id, profile_id: attackerProfile.id })
      )
    ).rejects.toThrow(/not accessible|read-only/);

    // And nothing was deleted.
    expect(identityExists(bound.id)).toBe(true);
    expect(portalIdentityProfile(bound.id)).toBe(victimProfile.id);
  });

  it("REFUSES when the caller only holds read on the profile the binding points at", async () => {
    const portalId = makePortal();

    const login = createLogin({ role: "member" });
    const readOnly = createProfile("Unbind ReadOnly", login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, readOnly.id);
    const writable = createProfile("Unbind Writable", login.id);
    actAs(login, writable);

    const bound = bindPortalIdentity(
      portalId,
      "Read Only Patient",
      readOnly.id
    );
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    await expect(
      unbindIdentityAction(fd({ identity_id: bound.id }))
    ).rejects.toThrow(/read-only/);
    expect(identityExists(bound.id)).toBe(true);
  });

  it("removes a binding the caller may write, and reports a typed outcome both times", async () => {
    const portalId = makePortal();

    const login = createLogin({ role: "member" });
    const profile = createProfile("Unbind Owner", login.id);
    actAs(login, profile);

    // Bound through the action, so the whole round trip is the real one.
    const made = await bindIdentityAction(
      fd({
        portal_id: portalId,
        patient_label: "Owned Patient",
        profile_id: profile.id,
      })
    );
    expect(made).toEqual({ ok: true });
    const id = identityIdFor(portalId, "Owned Patient");
    expect(portalIdentityProfile(id)).toBe(profile.id);

    // The legitimate unbind still works…
    expect(await unbindIdentityAction(fd({ identity_id: id }))).toEqual({
      ok: true,
    });
    expect(identityExists(id)).toBe(false);

    // …and a second attempt reports a typed refusal rather than an unconditional
    // success for a row that is no longer there.
    expect(await unbindIdentityAction(fd({ identity_id: id }))).toEqual({
      ok: false,
      error: "That mapping is already gone.",
    });
  });

  it("rejects a non-numeric or missing row id without touching the table", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("Unbind Garbage", login.id);
    actAs(login, profile);

    expect(
      await unbindIdentityAction(fd({ identity_id: "not-a-number" }))
    ).toEqual({ ok: false, error: "Unknown mapping." });
    expect(await unbindIdentityAction(fd({}))).toEqual({
      ok: false,
      error: "Unknown mapping.",
    });
  });
});

function identityIdFor(portalId: number, label: string): number {
  const row = db
    .prepare(
      "SELECT id FROM portal_identities WHERE portal_id = ? AND patient_label = ?"
    )
    .get(portalId, label) as { id: number } | undefined;
  return row?.id ?? 0;
}
