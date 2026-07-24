// SERVER-ACTION TIER — multi-view Journal cross-profile write gates (issue #1330).
//
// A merged card carries its subject's profile_id, so saveActivity/deleteActivity/
// mergeActivities gate + target the SUBJECT's profile via the shared gateItemProfile()
// → requireProfileWriteAccess(itemProfileId). This proves:
//   • a WRITE-granted subject's activity is created/edited/deleted on ITS profile,
//     while the acting profile is untouched (edit targets the subject);
//   • a READ-only-granted subject refuses the write (the view-only card can't slip a
//     write past the server);
//   • an UNGRANTED profile refuses the write;
//   • a CREATE with no profile_id lands on the acting profile (log-again → actor);
//   • a cross-profile merge pair is refused by the AND profile_id re-check.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  saveActivity,
  deleteActivity,
  mergeActivities,
} from "@/app/(app)/journal/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";
import type { TestLogin, TestProfile } from "./harness";

let login: TestLogin;
let owner: TestProfile; // acting profile (write)
let shared: TestProfile; // second WRITE-granted profile (a subject)
let roProfile: TestProfile; // READ-only-granted profile
let ungranted: TestProfile; // not granted at all

beforeEach(() => {
  login = createLogin({ role: "member" });
  owner = createProfile("MV Owner", login.id); // granted (write)
  shared = createProfile("MV Shared", login.id); // granted (write)
  roProfile = createProfile("MV ReadOnly");
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
  ).run(login.id, roProfile.id);
  ungranted = createProfile("MV Ungranted");
  actAs(login, owner);
});

function saveFd(
  over: Record<string, string | number | null | undefined> = {}
): FormData {
  return fd({
    type: "cardio",
    title: "Run",
    date: "2026-06-01",
    duration_min: 30,
    ...over,
  });
}

function insertActivity(profileId: number, title: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, '2026-06-01', 'cardio', ?, 30)`
      )
      .run(profileId, title).lastInsertRowid
  );
}

describe("saveActivity — cross-profile targeting", () => {
  it("edit/create targets the SUBJECT profile when profile_id is a write grant", async () => {
    const res = await saveActivity(saveFd({ profile_id: shared.id }));
    expect(res.ok).toBe(true);
    const row = db
      .prepare("SELECT profile_id FROM activities WHERE id = ?")
      .get(res.ok ? res.id : 0) as { profile_id: number };
    // Landed on the SUBJECT (shared), not the acting profile (owner).
    expect(row.profile_id).toBe(shared.id);
    expect(
      db
        .prepare("SELECT COUNT(*) c FROM activities WHERE profile_id = ?")
        .get(owner.id) as { c: number }
    ).toEqual({ c: 0 });
  });

  it("with NO profile_id, a create lands on the ACTING profile (log-again → actor)", async () => {
    const res = await saveActivity(saveFd());
    expect(res.ok).toBe(true);
    const row = db
      .prepare("SELECT profile_id FROM activities WHERE id = ?")
      .get(res.ok ? res.id : 0) as { profile_id: number };
    expect(row.profile_id).toBe(owner.id);
  });

  it("refuses a READ-only-granted subject", async () => {
    await expect(
      saveActivity(saveFd({ profile_id: roProfile.id }))
    ).rejects.toThrow(/read-only/);
    expect(
      db
        .prepare("SELECT COUNT(*) c FROM activities WHERE profile_id = ?")
        .get(roProfile.id) as { c: number }
    ).toEqual({ c: 0 });
  });

  it("refuses an UNGRANTED profile", async () => {
    await expect(
      saveActivity(saveFd({ profile_id: ungranted.id }))
    ).rejects.toThrow(/not accessible/);
    expect(
      db
        .prepare("SELECT COUNT(*) c FROM activities WHERE profile_id = ?")
        .get(ungranted.id) as { c: number }
    ).toEqual({ c: 0 });
  });
});

describe("deleteActivity — cross-profile targeting", () => {
  it("deletes the SUBJECT's activity on ITS profile", async () => {
    const id = insertActivity(shared.id, "shared run");
    const res = await deleteActivity(fd({ id, profile_id: shared.id }));
    expect(res.undoId).not.toBeNull();
    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(id)
    ).toBeUndefined();
  });

  it("refuses to delete a READ-only-granted subject's activity", async () => {
    const id = insertActivity(roProfile.id, "ro run");
    await expect(
      deleteActivity(fd({ id, profile_id: roProfile.id }))
    ).rejects.toThrow(/read-only/);
    expect(db.prepare("SELECT 1 FROM activities WHERE id = ?").get(id)).toEqual(
      { 1: 1 }
    );
  });
});

describe("mergeActivities — same-profile only", () => {
  it("folds a same-day pair on the SUBJECT's profile", async () => {
    const keep = insertActivity(shared.id, "keep");
    const drop = insertActivity(shared.id, "drop");
    const res = await mergeActivities(
      fd({ keep_id: keep, drop_id: drop, profile_id: shared.id })
    );
    expect(res.undoId).not.toBeNull();
    // The dropped row is gone; the keeper survives.
    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(drop)
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(keep)
    ).toEqual({ 1: 1 });
  });

  it("refuses a CROSS-profile pair by construction (AND profile_id re-check)", async () => {
    // Keeper on shared, sibling on owner: even gated to shared, owner's row isn't
    // shared's, so the pair never forms.
    const keep = insertActivity(shared.id, "keep");
    const drop = insertActivity(owner.id, "other-profile drop");
    const res = await mergeActivities(
      fd({ keep_id: keep, drop_id: drop, profile_id: shared.id })
    );
    expect(res.undoId).toBeNull();
    // Both rows still present — nothing folded or deleted.
    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(keep)
    ).toEqual({ 1: 1 });
    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(drop)
    ).toEqual({ 1: 1 });
  });
});
