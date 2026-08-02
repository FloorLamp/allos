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
  it("REFUSES to delete another profile's binding, even with a forged profile_id the caller may write", async () => {
    const { accountId } = makePortal();

    // The victim: a profile the attacker has no grant on at all.
    const victimLogin = createLogin({ role: "member" });
    const victimProfile = createProfile("Unbind Victim", victimLogin.id);
    const bound = bindPortalIdentity(
      accountId,
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

    expect(identityExists(bound.id)).toBe(true);
    expect(portalIdentityProfile(bound.id)).toBe(victimProfile.id);
  });

  it("REFUSES when the caller only holds read on the profile the binding points at", async () => {
    const { accountId } = makePortal();

    const login = createLogin({ role: "member" });
    const readOnly = createProfile("Unbind ReadOnly", login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, readOnly.id);
    const writable = createProfile("Unbind Writable", login.id);
    actAs(login, writable);

    const bound = bindPortalIdentity(
      accountId,
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

// ── One-tap mapping off the card (#1739) ─────────────────────────────────────
//
// The pending row is the point of the discovery flow: the label a household would
// otherwise retype comes off the ROW, not the post, so what gets bound is
// character-for-character what the portal reported. A retyped "Jane Q Doe" for a portal's
// "Jane Q. Doe" is a fresh, wrong key — and the next run refuses again for a reason nobody
// can see.
describe("pending-identity actions (#1739)", () => {
  it("binds the label EXACTLY as it was reported, and clears the pending row", async () => {
    const { accountId, slug } = makePortal();
    const login = createLogin({ role: "member" });
    const profile = createProfile("Pending Owner", login.id);
    actAs(login, profile);

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
  });

  it("REFUSES to bind onto a profile the caller cannot write", async () => {
    const { slug, accountId } = makePortal();
    const strangerLogin = createLogin({ role: "member" });
    const strangerProfile = createProfile("Pending Stranger", strangerLogin.id);

    const login = createLogin({ role: "member" });
    const own = createProfile("Pending Mine", login.id);
    actAs(login, own);

    recordPendingIdentity(slug, null, "Someone Else", "discovered");
    const [row] = pendingFor(accountId);

    await expect(
      bindPendingIdentityAction(
        fd({ pending_id: row.id, profile_id: strangerProfile.id })
      )
    ).rejects.toThrow(/not accessible|read-only/);
    expect(pendingFor(accountId)).toHaveLength(1);
  });

  it("IGNORE writes a durable binding that points nowhere and stops the prompt", async () => {
    const { slug, accountId } = makePortal();
    // Admin, because durable Ignore is admin-only since #1875.
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Ignore Owner", login.id);
    actAs(login, profile);

    recordPendingIdentity(slug, null, "Not Ours", "discovered");
    const [row] = pendingFor(accountId);

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
  });

  it("REFUSES dismiss for a login that can write nothing", async () => {
    const { slug, accountId } = makePortal();
    // A caregiver with read-only access everywhere cannot clear a portal prompt.
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
  });

  it("REFUSES durable Ignore for ANY member — admin-only since #1875", async () => {
    // The caregiver fixture from the issue: genuine WRITE access to one profile. Under
    // the old any-writer gate this member could permanently refuse a pending belonging
    // to another adult's login, silently breaking that person's future imports.
    const { slug, accountId } = makePortal();
    const login = createLogin({ role: "member" });
    const writable = createProfile("Ignore Caregiver", login.id);
    actAs(login, writable);

    recordPendingIdentity(slug, null, "Not Theirs To Refuse", "discovered");
    const [row] = pendingFor(accountId);

    await expect(
      ignorePendingIdentityAction(fd({ pending_id: row.id }))
    ).rejects.toThrow(/NEXT_REDIRECT/);
    // Nothing was refused, nothing was cleared.
    expect(pendingFor(accountId)).toHaveLength(1);
    expect(
      listPortalIdentities().some(
        (i) => i.patientLabel === "Not Theirs To Refuse"
      )
    ).toBe(false);
  });

  it("a MEMBER with write access to one profile may act on the list", async () => {
    // Caregiver-members still clear their own prompts without an admin: "Not now" is
    // self-expiring and low-stakes, so it keeps the any-writer gate (#1875).
    const { slug, accountId } = makePortal();
    const login = createLogin({ role: "member" });
    const writable = createProfile("Caregiver Writable", login.id);
    actAs(login, writable);

    recordPendingIdentity(slug, null, "Caregiver Patient", "discovered");
    const [row] = pendingFor(accountId);
    expect(
      await dismissPendingIdentityAction(fd({ pending_id: row.id }))
    ).toEqual({ ok: true });
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

  it("removes an IGNORED binding through the un-ignore path, which needs no profile", async () => {
    const { slug, accountId } = makePortal();
    // Admin to WRITE the ignore (#1875); the un-ignore below stays any-writer.
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Unignore Owner", login.id);
    actAs(login, profile);

    recordPendingIdentity(slug, null, "Reconsidered", "discovered");
    const [row] = pendingFor(accountId);
    await ignorePendingIdentityAction(fd({ pending_id: row.id }));
    const binding = listPortalIdentities().find(
      (i) => i.patientLabel === "Reconsidered"
    )!;

    // An ignored binding has no profile to authorize against, so unbind takes the
    // any-profile-write tier and the delete is scoped to ignored = 1.
    expect(await unbindIdentityAction(fd({ identity_id: binding.id }))).toEqual(
      {
        ok: true,
      }
    );
    expect(identityExists(binding.id)).toBe(false);
  });
});
