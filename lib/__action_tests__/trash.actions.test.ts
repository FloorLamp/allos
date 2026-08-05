// SERVER-ACTION TIER — Data → Trash and its retention setting (issue #2013).
//
// The DB tier proves the cores; this file proves the request boundary over them: the
// retention window is a GLOBAL setting written only by the admin action, the two
// by-hand purges are profile-scoped writes gated on requireWriteAccess (a caregiver
// with read access may look at a trash but not empty it), and every response reports
// what the write actually did rather than confirming unconditionally.

import { describe, it, expect } from "vitest";
import { emptyTrashNow, purgeTrashEntry } from "@/app/(app)/data/trash-actions";
import { undoDelete } from "@/app/(app)/undo-actions";
import { saveTrashRetention } from "@/app/(app)/settings/server/actions";
import { captureDelete } from "@/lib/undo-delete-db";
import { listTrash } from "@/lib/queries/trash";
import { getTrashRetentionDays, getSetting } from "@/lib/settings";
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
} from "@/lib/retention";
import { db, today } from "@/lib/db";
import { actAs, createLogin, createProfile, fd, seedActor } from "./harness";

// A body-metric capture this test owns — the plainest undoable kind (one row, no
// children), so nothing here depends on another domain's fixture shape.
function captureBodyMetric(profileId: number, date: string): number {
  const id = Number(
    db
      .prepare(
        "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 80)"
      )
      .run(profileId, date).lastInsertRowid
  );
  return captureDelete("body-metric", profileId, id)!;
}

describe("saveTrashRetention (global, admin-only)", () => {
  it("round-trips a whole-day window into the global settings tier", async () => {
    seedActor({ role: "admin", profileName: "trash-retention-admin" });
    await saveTrashRetention(fd({ trash_retention_days: "45" }));
    expect(getSetting("trash_retention_days")).toBe("45");
    expect(getTrashRetentionDays()).toBe(45);
  });

  it("clamps an out-of-range submit instead of storing it", async () => {
    seedActor({ role: "admin", profileName: "trash-retention-clamp" });
    await saveTrashRetention(fd({ trash_retention_days: "0" }));
    expect(getTrashRetentionDays()).toBe(MIN_TRASH_RETENTION_DAYS);
    await saveTrashRetention(fd({ trash_retention_days: "100000" }));
    expect(getTrashRetentionDays()).toBe(MAX_TRASH_RETENTION_DAYS);
  });

  it("falls back to the 30-day default on a garbage submit", async () => {
    seedActor({ role: "admin", profileName: "trash-retention-garbage" });
    await saveTrashRetention(fd({ trash_retention_days: "soon" }));
    expect(getTrashRetentionDays()).toBe(DEFAULT_TRASH_RETENTION_DAYS);
  });
});

describe("purgeTrashEntry", () => {
  it("purges the acting profile's capture and reports it once", async () => {
    const { profile } = seedActor({ profileName: "trash-purge-actor" });
    const undoId = captureBodyMetric(profile.id, "2020-04-01");

    expect(await purgeTrashEntry(undoId)).toEqual({ ok: true });
    expect(listTrash(profile.id, 30).map((e) => e.id)).not.toContain(undoId);

    // Gone is a real state, not a silent success: another tab, the hourly tick, or a
    // restore may have taken it, and the surface renders that differently.
    const again = await purgeTrashEntry(undoId);
    expect(again).toMatchObject({ ok: false, reason: "gone" });
  });

  it("refuses a nonsense token without touching anything", async () => {
    seedActor({ profileName: "trash-purge-invalid" });
    expect(await purgeTrashEntry(0)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(await purgeTrashEntry(-3)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("cannot purge another profile's capture", async () => {
    const owner = createLogin({ role: "admin" });
    const ownerProfile = createProfile("trash-purge-owner", owner.id);
    actAs(owner, ownerProfile);
    const undoId = captureBodyMetric(ownerProfile.id, "2020-04-02");

    const intruder = createLogin({ role: "admin" });
    const intruderProfile = createProfile("trash-purge-intruder", intruder.id);
    actAs(intruder, intruderProfile);
    expect(await purgeTrashEntry(undoId)).toMatchObject({
      ok: false,
      reason: "gone",
    });

    // Still there for its owner, and still restorable.
    actAs(owner, ownerProfile);
    expect(listTrash(ownerProfile.id, 30).map((e) => e.id)).toContain(undoId);
    expect((await undoDelete(undoId)).ok).toBe(true);
  });

  it("is refused for a read-only acting session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("trash-purge-readonly", login.id);
    actAs(login, profile, "write");
    const undoId = captureBodyMetric(profile.id, "2020-04-03");

    actAs(login, profile, "read");
    await expect(purgeTrashEntry(undoId)).rejects.toThrow(/read-only/);
    // Nothing was destroyed by the refusal.
    actAs(login, profile, "write");
    expect(listTrash(profile.id, 30).map((e) => e.id)).toContain(undoId);
  });
});

describe("emptyTrashNow", () => {
  it("reports how many captures it actually purged", async () => {
    const { profile } = seedActor({ profileName: "trash-empty-actor" });
    captureBodyMetric(profile.id, "2020-05-01");
    captureBodyMetric(profile.id, "2020-05-02");

    expect(await emptyTrashNow()).toEqual({ purged: 2 });
    expect(listTrash(profile.id, 30)).toHaveLength(0);
    // A second tap purged nothing, and says so rather than claiming "Emptied".
    expect(await emptyTrashNow()).toEqual({ purged: 0 });
  });

  it("is refused for a read-only acting session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("trash-empty-readonly", login.id);
    actAs(login, profile, "write");
    captureBodyMetric(profile.id, "2020-05-03");

    actAs(login, profile, "read");
    await expect(emptyTrashNow()).rejects.toThrow(/read-only/);
    actAs(login, profile, "write");
    expect(listTrash(profile.id, 30)).toHaveLength(1);
  });
});

describe("restore from the Trash uses the toast's own action", () => {
  it("undoDelete puts a listed capture back and consumes it", async () => {
    const { profile } = seedActor({ profileName: "trash-restore-actor" });
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title)
           VALUES (?, ?, 'cardio', 'Trash restore probe')`
        )
        .run(profile.id, today(profile.id)).lastInsertRowid
    );
    const undoId = captureDelete("activity", profile.id, activityId)!;

    const entry = listTrash(profile.id, 30).find((e) => e.id === undoId);
    expect(entry?.title).toBe("Trash restore probe");

    expect(await undoDelete(undoId)).toEqual({ ok: true });
    // Back under a NEW id (restore never re-uses the deleted row's), and the capture
    // is consumed, so the Trash stops offering it.
    const back = db
      .prepare(
        `SELECT id FROM activities WHERE profile_id = ? AND title = 'Trash restore probe'`
      )
      .get(profile.id) as { id: number };
    expect(back.id).not.toBe(activityId);
    expect(listTrash(profile.id, 30).map((e) => e.id)).not.toContain(undoId);
  });
});
