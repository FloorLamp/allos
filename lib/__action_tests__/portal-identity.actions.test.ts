// SERVER-ACTION TIER (#1747, #1739) — the authorization boundary on the patient-portal
// identity bindings.
//
// A binding decides WHERE a person's records land, so creating or removing one is an
// access-control transition. The bug #1747 pinned down: the unbind action used to gate on
// a `profile_id` read straight out of the same client FormData that named the row id, so
// the value that was checked and the row that was deleted were never tied together.
//
// The gates on this surface are deliberately different, and each is exercised here:
//   • routing writes take requireProfileWriteAccess(TARGET);
//   • dismiss ("Not now") takes the any-profile-write gate — it names no profile, and it
//     is self-expiring;
//   • durable IGNORE takes requireAdmin (#1875): it silently breaks another login's
//     future imports, which no per-profile grant can stand in for;
//   • the registries take requireAdmin (covered by the static scan, not here).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  bindIdentityAction,
  bindPendingIdentityAction,
  dismissPendingIdentityAction,
  ignorePendingIdentityAction,
  unbindIdentityAction,
} from "@/app/(app)/integrations/patient-portals/actions";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  listPendingIdentities,
  listPortalIdentities,
  portalIdentityProfile,
  recordPendingIdentity,
  resolvePortalIdentity,
} from "@/lib/portals";
import { actAs, createLogin, createProfile, fd } from "./harness";

// This tier's temp DB is shared by every test in the file, so a test that asserts on the
// pending list must look only at the LOGIN it created. Counting the global list would
// make each test depend on the ones before it — the fixture-ownership rule, one tier
// down.
function pendingFor(accountId: number) {
  return listPendingIdentities().filter((p) => p.accountId === accountId);
}

let portalSeq = 0;
function makePortal(): { portalId: number; accountId: number; slug: string } {
  const name = `Unbind Portal ${++portalSeq}`;
  const r = createPortal(name);
  expect(r.ok).toBe(true);
  const portalId = r.ok ? r.id : 0;
  const account = accountsForPortal(portalId)[0];
  const slug = db
    .prepare("SELECT slug FROM portals WHERE id = ?")
    .get(portalId) as { slug: string };
  return { portalId, accountId: account.id, slug: slug.slug };
}

function identityExists(id: number): boolean {
  return (
    db.prepare("SELECT 1 FROM portal_identities WHERE id = ?").get(id) != null
  );
}

describe("unbindIdentityAction authorization (#1747)", () => {
  it("REFUSES bindings owned by inaccessible or read-only profiles", async () => {
    const { accountId } = makePortal();

    const victimLogin = createLogin({ role: "member" });
    const victimProfile = createProfile("Unbind Victim", victimLogin.id);
    const victimBound = bindPortalIdentity(
      accountId,
      "Victim Patient",
      victimProfile.id
    );
    expect(victimBound.ok).toBe(true);
    if (!victimBound.ok) return;

    const login = createLogin({ role: "member" });
    const readOnly = createProfile("Unbind ReadOnly", login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, readOnly.id);
    const writable = createProfile("Unbind Writable", login.id);
    actAs(login, writable);

    const readOnlyBound = bindPortalIdentity(
      accountId,
      "Read Only Patient",
      readOnly.id
    );
    expect(readOnlyBound.ok).toBe(true);
    if (!readOnlyBound.ok) return;

    await expect(
      unbindIdentityAction(
        fd({ identity_id: victimBound.id, profile_id: writable.id })
      )
    ).rejects.toThrow(/not accessible|read-only/);
    await expect(
      unbindIdentityAction(fd({ identity_id: readOnlyBound.id }))
    ).rejects.toThrow(/read-only/);

    expect(identityExists(victimBound.id)).toBe(true);
    expect(portalIdentityProfile(victimBound.id)).toBe(victimProfile.id);
    expect(identityExists(readOnlyBound.id)).toBe(true);
  });

  it("validates the row id, removes an owned binding, and reports stale deletion", async () => {
    const { accountId } = makePortal();

    const login = createLogin({ role: "member" });
    const profile = createProfile("Unbind Owner", login.id);
    actAs(login, profile);

    const made = await bindIdentityAction(
      fd({
        account_id: accountId,
        patient_label: "Owned Patient",
        profile_id: profile.id,
      })
    );
    expect(made).toEqual({ ok: true });
    const id = listPortalIdentities().find(
      (i) => i.patientLabel === "Owned Patient"
    )!.id;

    expect(
      await unbindIdentityAction(fd({ identity_id: "not-a-number" }))
    ).toEqual({ ok: false, error: "Unknown mapping." });
    expect(await unbindIdentityAction(fd({}))).toEqual({
      ok: false,
      error: "Unknown mapping.",
    });
    expect(identityExists(id)).toBe(true);

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
});

// ── One-tap mapping off the card (#1739) ─────────────────────────────────────
//
// The pending row is the point of the discovery flow: the label a household would
// otherwise retype comes off the ROW, not the post, so what gets bound is
// character-for-character what the portal reported. A retyped "Jane Q Doe" for a portal's
// "Jane Q. Doe" is a fresh, wrong key — and the next run refuses again for a reason nobody
// can see.
describe("pending-identity actions (#1739)", () => {
  it("binds the reported label to a writable profile and refuses a foreign target", async () => {
    const { accountId, slug } = makePortal();
    const login = createLogin({ role: "member" });
    const profile = createProfile("Pending Owner", login.id);
    actAs(login, profile);
    const strangerLogin = createLogin({ role: "member" });
    const strangerProfile = createProfile("Pending Stranger", strangerLogin.id);

    // A label a human would plausibly retype wrong.
    recordPendingIdentity(slug, null, "Jane Q. Doe", "discovered");
    const [row] = pendingFor(accountId);

    expect(
      await bindPendingIdentityAction(
        fd({ pending_id: row.id, profile_id: profile.id })
      )
    ).toEqual({ ok: true });

    const r = resolvePortalIdentity(slug, null, "Jane Q. Doe");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profileId).toBe(profile.id);
    expect(r.accountId).toBe(accountId);
    expect(pendingFor(accountId)).toHaveLength(0);

    recordPendingIdentity(slug, null, "Someone Else", "discovered");
    const [foreignRow] = pendingFor(accountId);

    await expect(
      bindPendingIdentityAction(
        fd({ pending_id: foreignRow.id, profile_id: strangerProfile.id })
      )
    ).rejects.toThrow(/not accessible|read-only/);
    expect(pendingFor(accountId)).toHaveLength(1);
  });

  it("keeps durable Ignore admin-only, persists it, and allows un-ignore", async () => {
    const { slug, accountId } = makePortal();
    const memberLogin = createLogin({ role: "member" });
    const memberProfile = createProfile("Ignore Caregiver", memberLogin.id);
    actAs(memberLogin, memberProfile);

    recordPendingIdentity(slug, null, "Not Ours", "discovered");
    const [row] = pendingFor(accountId);

    await expect(
      ignorePendingIdentityAction(fd({ pending_id: row.id }))
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(pendingFor(accountId)).toHaveLength(1);
    expect(
      listPortalIdentities().some((i) => i.patientLabel === "Not Ours")
    ).toBe(false);

    const adminLogin = createLogin({ role: "admin" });
    const adminProfile = createProfile("Ignore Owner", adminLogin.id);
    actAs(adminLogin, adminProfile);
    expect(
      await ignorePendingIdentityAction(fd({ pending_id: row.id }))
    ).toEqual({ ok: true });
    expect(pendingFor(accountId)).toHaveLength(0);

    const binding = listPortalIdentities().find(
      (i) => i.patientLabel === "Not Ours"
    )!;
    expect(binding.ignored).toBe(true);
    expect(binding.profileId).toBeNull();
    // "Not ever": a later report does not resurrect the prompt.
    expect(recordPendingIdentity(slug, null, "Not Ours", "discovered")).toBe(
      false
    );

    // An ignored binding has no profile to authorize against, so unbind takes the
    // any-profile-write tier and scopes the delete to ignored = 1.
    expect(await unbindIdentityAction(fd({ identity_id: binding.id }))).toEqual(
      { ok: true }
    );
    expect(identityExists(binding.id)).toBe(false);
  });

  it("allows dismiss only after a member has write access somewhere", async () => {
    const { slug, accountId } = makePortal();
    const login = createLogin({ role: "member" });
    const readOnly = createProfile("No Write Anywhere", login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, readOnly.id);
    actAs(login, readOnly, "read");

    recordPendingIdentity(slug, null, "Untouchable", "discovered");
    const [row] = pendingFor(accountId);

    await expect(
      dismissPendingIdentityAction(fd({ pending_id: row.id }))
    ).rejects.toThrow(/no write access/);
    expect(pendingFor(accountId)).toHaveLength(1);
    const writable = createProfile("Now Writable", login.id);
    actAs(login, writable);
    expect(
      await dismissPendingIdentityAction(fd({ pending_id: row.id }))
    ).toEqual({ ok: true });
    expect(pendingFor(accountId)).toHaveLength(0);
  });

  it("reports typed outcomes for a stale or garbage pending id", async () => {
    const { slug, accountId } = makePortal();
    const login = createLogin({ role: "member" });
    const profile = createProfile("Pending Typed", login.id);
    actAs(login, profile);

    recordPendingIdentity(slug, null, "Gone Soon", "discovered");
    const [row] = pendingFor(accountId);

    expect(
      await dismissPendingIdentityAction(fd({ pending_id: row.id }))
    ).toEqual({ ok: true });
    // Dismissing twice is not an unconditional success.
    expect(
      await dismissPendingIdentityAction(fd({ pending_id: row.id }))
    ).toEqual({
      ok: false,
      error: "That pending patient is already handled.",
    });
    expect(
      await bindPendingIdentityAction(
        fd({ pending_id: row.id, profile_id: profile.id })
      )
    ).toEqual({ ok: false, error: "That pending patient is already handled." });
    expect(await bindPendingIdentityAction(fd({ pending_id: "nope" }))).toEqual(
      {
        ok: false,
        error: "Unknown pending patient.",
      }
    );
  });
});

// ── Hand-typed bind over an existing binding (#2103) ─────────────────────────
//
// The "Pre-bind a patient by hand" form posts a free-typed label, and the bind core is
// an upsert — so when the (login, label) pair is already LIVE-BOUND, the action is not
// creating a binding, it is RE-POINTING one: every future acquirer upload for that
// patient re-routes onto the new profile. The one-sided target gate let a member with
// write access only to their OWN profile re-route a household member's clinical
// documents onto themselves. The action now resolves the current owner from the row
// (#1747) and takes remapIdentityAction's discipline: BOTH sides gated, one CAS.
describe("bindIdentityAction re-point protection (#2103)", () => {
  it("REFUSES re-pointing bindings owned by inaccessible or read-only profiles", async () => {
    const { accountId } = makePortal();

    const victimLogin = createLogin({ role: "member" });
    const victimProfile = createProfile("Repoint Victim", victimLogin.id);
    const victimBound = bindPortalIdentity(
      accountId,
      "Household Member B",
      victimProfile.id
    );
    expect(victimBound.ok).toBe(true);
    if (!victimBound.ok) return;

    const login = createLogin({ role: "member" });
    const readOnly = createProfile("Repoint ReadOnly", login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, readOnly.id);
    const writable = createProfile("Repoint Writable", login.id);
    actAs(login, writable);

    const readOnlyBound = bindPortalIdentity(
      accountId,
      "Read Only Bound",
      readOnly.id
    );
    expect(readOnlyBound.ok).toBe(true);
    if (!readOnlyBound.ok) return;

    await expect(
      bindIdentityAction(
        fd({
          account_id: accountId,
          patient_label: "Household Member B",
          profile_id: writable.id,
        })
      )
    ).rejects.toThrow(/not accessible|read-only/);
    await expect(
      bindIdentityAction(
        fd({
          account_id: accountId,
          patient_label: "Read Only Bound",
          profile_id: writable.id,
        })
      )
    ).rejects.toThrow(/read-only/);

    expect(portalIdentityProfile(victimBound.id)).toBe(victimProfile.id);
    expect(portalIdentityProfile(readOnlyBound.id)).toBe(readOnly.id);
  });

  it("re-points the same row atomically and stays idempotent", async () => {
    const { accountId } = makePortal();

    const login = createLogin({ role: "member" });
    const from = createProfile("Repoint From", login.id);
    const to = createProfile("Repoint To", login.id);
    actAs(login, to);

    const bound = bindPortalIdentity(accountId, "Both Sides Writable", from.id);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    expect(
      await bindIdentityAction(
        fd({
          account_id: accountId,
          patient_label: "Both Sides Writable",
          profile_id: to.id,
        })
      )
    ).toEqual({ ok: true });
    // The SAME row was re-pointed (remap CAS), not a second row minted.
    expect(portalIdentityProfile(bound.id)).toBe(to.id);

    expect(
      await bindIdentityAction(
        fd({
          account_id: accountId,
          patient_label: "Both Sides Writable",
          profile_id: to.id,
        })
      )
    ).toEqual({ ok: true });
    expect(portalIdentityProfile(bound.id)).toBe(to.id);
  });
});
