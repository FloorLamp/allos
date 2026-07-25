// SERVER-ACTION TIER — the household dose round's subscription write path (#1459).
//
// The action layer is the auth boundary, so this tier asserts what the pure and DB
// tiers structurally can't see: the requireWriteAccess gate on the RECEIVING profile,
// and — the load-bearing one — that a submitted member list cannot widen a caregiver's
// reach. The form is client-side, so its ids are attacker-controlled; the action
// narrows them to what is currently offerable before storing, and the send/tap paths
// narrow again against live grants. A test that only drove the UI would miss this.
//
// All fixtures are synthetic profiles/logins in the throwaway temp DB. No PHI.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getProfileHouseholdRound } from "@/lib/settings";
import {
  saveHouseholdRound,
  sendTestHouseholdRound,
} from "@/app/(app)/settings/profile/actions";
import { actAs, createLogin, createProfile } from "./harness";

function grant(loginId: number, profileId: number, access: "read" | "write") {
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, profileId, access);
}

function setOwnProfile(loginId: number, profileId: number) {
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    profileId,
    loginId
  );
}

function form(enabled: boolean, memberIds: number[]): FormData {
  const f = new FormData();
  f.set("household_round_enabled", enabled ? "1" : "0");
  for (const id of memberIds) f.append("household_round_members", String(id));
  return f;
}

// A caregiver acting as their OWN profile, with write access to `ada` and a
// read-only grant on `readOnly`.
function caregiver(tag: string) {
  const login = createLogin({ role: "member", username: `hh_${tag}` });
  const receiver = createProfile(`${tag} Caregiver`, login.id);
  const ada = createProfile(`${tag} Ada`, login.id);
  const readOnly = createProfile(`${tag} Ward`, login.id);
  const stranger = createProfile(`${tag} Stranger`); // ungranted entirely
  grant(login.id, receiver.id, "write");
  grant(login.id, ada.id, "write");
  grant(login.id, readOnly.id, "read");
  setOwnProfile(login.id, receiver.id);
  actAs(login, receiver);
  return { login, receiver, ada, readOnly, stranger };
}

describe("saveHouseholdRound", () => {
  it("stores the enable flag and the selected members on the RECEIVING profile", async () => {
    const c = caregiver("Save");
    await saveHouseholdRound(form(true, [c.ada.id]));
    expect(getProfileHouseholdRound(c.receiver.id)).toEqual({
      enabled: true,
      memberIds: [c.ada.id],
    });
    // The member's own profile stores nothing — the subscription belongs to the
    // receiver, and a member must not acquire settings by being included.
    expect(getProfileHouseholdRound(c.ada.id)).toEqual({
      enabled: false,
      memberIds: [],
    });
  });

  it("DROPS a submitted member the caller only holds READ on", async () => {
    // The form is client-side; a read-only ward id posted by hand must not be stored,
    // because the round confirms doses and a read grant may never write.
    const c = caregiver("ReadOnly");
    await saveHouseholdRound(form(true, [c.ada.id, c.readOnly.id]));
    expect(getProfileHouseholdRound(c.receiver.id).memberIds).toEqual([
      c.ada.id,
    ]);
  });

  it("DROPS a submitted profile the caller cannot reach at all", async () => {
    const c = caregiver("Forged");
    await saveHouseholdRound(form(true, [c.ada.id, c.stranger.id]));
    expect(getProfileHouseholdRound(c.receiver.id).memberIds).toEqual([
      c.ada.id,
    ]);
  });

  it("drops junk ids without failing the save", async () => {
    const c = caregiver("Junk");
    const f = form(true, [c.ada.id]);
    f.append("household_round_members", "not-a-number");
    f.append("household_round_members", "-1");
    await saveHouseholdRound(f);
    expect(getProfileHouseholdRound(c.receiver.id).memberIds).toEqual([
      c.ada.id,
    ]);
  });

  it("turning the round off keeps the selection for when it comes back on", async () => {
    const c = caregiver("Toggle");
    await saveHouseholdRound(form(true, [c.ada.id]));
    await saveHouseholdRound(form(false, [c.ada.id]));
    expect(getProfileHouseholdRound(c.receiver.id)).toEqual({
      enabled: false,
      memberIds: [c.ada.id],
    });
  });

  it("REFUSES a read-only acting session (requireWriteAccess)", async () => {
    const c = caregiver("ReadSession");
    actAs(c.login, c.receiver, "read");
    await expect(saveHouseholdRound(form(true, [c.ada.id]))).rejects.toThrow(
      /read-only/
    );
    expect(getProfileHouseholdRound(c.receiver.id).enabled).toBe(false);
  });
});

describe("sendTestHouseholdRound", () => {
  it("reports an empty round instead of sending an empty message", async () => {
    const c = caregiver("TestEmpty");
    await saveHouseholdRound(form(true, [c.ada.id]));
    const result = await sendTestHouseholdRound();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Nothing to send");
  });

  it("REFUSES a read-only acting session", async () => {
    const c = caregiver("TestReadSession");
    actAs(c.login, c.receiver, "read");
    await expect(sendTestHouseholdRound()).rejects.toThrow(/read-only/);
  });
});
