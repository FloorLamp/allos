// SERVER-ACTION TIER (#1757) — the gate and the typed outcome on "Request sync".
//
// The action names a portal LOGIN and no profile, so requireProfileWriteAccess has no
// target and requireWriteAccess would assert the wrong thing (the session's ACTIVE
// profile, which is unrelated to a portal login). It takes the same any-profile-write
// gate the pending list does: the honest minimum is that this login could act on the
// records a run would bring in.
//
// It also must never confirm success unconditionally. Two legitimate refusals exist —
// an already-open ask, and a login with no mapped patients — and both are rendered.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { requestSyncAction } from "@/app/(app)/integrations/patient-portals/actions";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
} from "@/lib/portals";
import { listSyncRequests } from "@/lib/portal-requests";
import { actAs, createLogin, createProfile, fd } from "./harness";

let seq = 0;

function makePortalWithMappedPatient(profileId: number): number {
  const r = createPortal(`Request Portal ${++seq}`);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("fixture");
  const accountId = accountsForPortal(r.id)[0].id;
  expect(bindPortalIdentity(accountId, `PATIENT ${seq}`, profileId).ok).toBe(
    true
  );
  return accountId;
}

function makeEmptyPortal(): number {
  const r = createPortal(`Empty Portal ${++seq}`);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("fixture");
  return accountsForPortal(r.id)[0].id;
}

describe("requestSyncAction — the gate", () => {
  it("REFUSES a login with write access nowhere", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`Req Gate ${++seq}`, login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, profile.id);
    actAs(login, profile, "read");

    const accountId = makePortalWithMappedPatient(profile.id);
    await expect(requestSyncAction(fd({ account_id: accountId }))).rejects.toThrow(
      /no write access/
    );
    expect(listSyncRequests().some((r) => r.accountId === accountId)).toBe(false);
  });

  it("lets a member with write access somewhere raise one", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`Req Writer ${++seq}`, login.id);
    actAs(login, profile);

    const accountId = makePortalWithMappedPatient(profile.id);
    await expect(requestSyncAction(fd({ account_id: accountId }))).resolves.toEqual(
      { ok: true }
    );
    expect(listSyncRequests().some((r) => r.accountId === accountId)).toBe(true);
  });
});

describe("requestSyncAction — the typed outcome", () => {
  it("names the already-open case instead of claiming success twice", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile(`Req Twice ${++seq}`, login.id);
    actAs(login, profile);

    const accountId = makePortalWithMappedPatient(profile.id);
    await requestSyncAction(fd({ account_id: accountId }));
    const again = await requestSyncAction(fd({ account_id: accountId }));
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/already requested/i);
  });

  it("refuses a login with no mapped patients, and says why", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile(`Req Unmapped ${++seq}`, login.id);
    actAs(login, profile);

    const accountId = makeEmptyPortal();
    const out = await requestSyncAction(fd({ account_id: accountId }));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/Map at least one patient/i);
    expect(listSyncRequests().some((r) => r.accountId === accountId)).toBe(false);
  });

  it("refuses a malformed account id", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile(`Req Bad ${++seq}`, login.id);
    actAs(login, profile);
    expect(await requestSyncAction(fd({ account_id: "not-a-number" }))).toEqual({
      ok: false,
      error: "Unknown portal login.",
    });
  });
});
