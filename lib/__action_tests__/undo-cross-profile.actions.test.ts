// SERVER-ACTION TIER — cross-profile Undo on multi-view surfaces (#2104).
//
// The two halves of one undo round trip used to resolve DIFFERENT profiles: the
// multi-view delete stamps the ROW's profile onto the capture (gateItemProfile gates
// and writes the row's subject), while the restore resolved the ACTING profile
// (requireWriteAccess) and filtered the holding row by it. Deleting Mia's reading
// while acting as Dad therefore captured under Mia, restored under Dad, found
// nothing, told the user "Couldn't undo — it may have expired", and let the capture
// purge for good in the retention sweep — a data-loss defect, not just UX.
//
// The restore now resolves the OWNING profile from the holding row itself
// (deletedRowProfile) and gates it with requireProfileWriteAccess — the same shape
// gateItemProfile applies on the delete side — so the round trip closes for a login
// that may write the row's profile, and REFUSES (restoring nothing) for one that
// may not. restoreDeletedRow keeps its profile_id filter as the anti-replay compare.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { deleteResult } from "@/app/(app)/results/reading-actions";
import { undoDelete, undoDeletes } from "@/app/(app)/undo-actions";
import { captureDelete } from "@/lib/undo-delete-db";
import { createLogin, createProfile, actAs, fd } from "./harness";

function seedRecord(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num)
         VALUES (?, '2024-05-01', 'lab', ?, '42', 'ng/mL', ?, 42)`
      )
      .run(profileId, name, name).lastInsertRowid
  );
}

function recordCount(profileId: number, name: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ? AND name = ?"
      )
      .get(profileId, name) as { n: number }
  ).n;
}

function holdingRowExists(undoId: number): boolean {
  return (
    db.prepare("SELECT 1 FROM deleted_rows WHERE id = ?").get(undoId) != null
  );
}

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

describe("cross-profile undo round trip (#2104)", () => {
  it("restores the OTHER profile's row when the login may write it — the full multi-view round trip", async () => {
    // Acting as A, a member with write on BOTH profiles deletes B's reading off a
    // multi-view Biomarkers table (the delete posts the ROW's profile_id) …
    const login = createLogin({ role: "member" });
    const acting = createProfile("Undo Acting", login.id);
    const other = createProfile("Undo Other", login.id);
    actAs(login, acting);
    const recId = seedRecord(other.id, "Ferritin X");

    const { undoId } = await deleteResult(
      fd({ id: recId, profile_id: other.id })
    );
    expect(undoId).not.toBeNull();
    expect(recordCount(other.id, "Ferritin X")).toBe(0);

    // … and the toast's Undo actually restores it — onto B, where it belongs.
    expect(await undoDelete(undoId!)).toEqual({ ok: true });
    expect(recordCount(other.id, "Ferritin X")).toBe(1);
    // Never onto the acting profile.
    expect(recordCount(acting.id, "Ferritin X")).toBe(0);
    // The token is consumed.
    expect(holdingRowExists(undoId!)).toBe(false);
  });

  it("REFUSES a login without write access to the captured row's profile, restoring nothing", async () => {
    // The victim's capture: a real cross-profile token for a profile the replaying
    // login has no grant on at all.
    const victimLogin = createLogin({ role: "member" });
    const victim = createProfile("Undo Victim", victimLogin.id);
    const recId = seedRecord(victim.id, "Glucose X");
    actAs(victimLogin, victim);
    const { undoId } = await deleteResult(
      fd({ id: recId, profile_id: victim.id })
    );
    expect(undoId).not.toBeNull();

    // The replaying login: genuine write access to its OWN profile only.
    const attackerLogin = createLogin({ role: "member" });
    const attackerProfile = createProfile("Undo Attacker", attackerLogin.id);
    actAs(attackerLogin, attackerProfile);

    await expect(undoDelete(undoId!)).rejects.toThrow(
      /not accessible|read-only/
    );
    // Nothing restored anywhere; the capture survives for its rightful owner.
    expect(recordCount(victim.id, "Glucose X")).toBe(0);
    expect(recordCount(attackerProfile.id, "Glucose X")).toBe(0);
    expect(holdingRowExists(undoId!)).toBe(true);

    // The rightful owner's undo still works afterwards.
    actAs(victimLogin, victim);
    expect(await undoDelete(undoId!)).toEqual({ ok: true });
    expect(recordCount(victim.id, "Glucose X")).toBe(1);
  });

  it("REFUSES a READ-only grant on the captured profile the same way", async () => {
    const login = createLogin({ role: "member" });
    const readOnly = createProfile("Undo ReadOnly", login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, readOnly.id);
    const writable = createProfile("Undo Writable", login.id);
    actAs(login, writable);

    // Capture stamped with the read-only profile (as an admin's delete would have).
    const undoId = captureBodyMetric(readOnly.id, "2020-04-01");

    await expect(undoDelete(undoId)).rejects.toThrow(/read-only/);
    expect(holdingRowExists(undoId)).toBe(true);
  });

  it("a gone token still answers { ok: false } — expired, not an error", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("Undo Gone", login.id);
    actAs(login, profile);
    expect(await undoDelete(999_999)).toEqual({ ok: false });
  });

  describe("the batch twin (#2104)", () => {
    it("restores a mixed-profile batch when the login may write every owner", async () => {
      const login = createLogin({ role: "member" });
      const a = createProfile("Batch A", login.id);
      const b = createProfile("Batch B", login.id);
      actAs(login, a);

      const tokenA = captureBodyMetric(a.id, "2020-05-01");
      const tokenB = captureBodyMetric(b.id, "2020-05-02");

      expect(await undoDeletes([tokenA, tokenB])).toEqual({ restored: 2 });
      for (const [pid, date] of [
        [a.id, "2020-05-01"],
        [b.id, "2020-05-02"],
      ] as const) {
        const n = (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date = ?"
            )
            .get(pid, date) as { n: number }
        ).n;
        expect(n).toBe(1);
      }
    });

    it("a forged token in the batch aborts the WHOLE batch before anything restores", async () => {
      const login = createLogin({ role: "member" });
      const mine = createProfile("Batch Mine", login.id);
      const stranger = createProfile("Batch Stranger");
      actAs(login, mine);

      const okToken = captureBodyMetric(mine.id, "2020-06-01");
      const forged = captureBodyMetric(stranger.id, "2020-06-02");

      await expect(undoDeletes([okToken, forged])).rejects.toThrow(
        /not accessible/
      );
      // Nothing restored — including the token the login could have undone alone —
      // and both captures survive.
      expect(holdingRowExists(okToken)).toBe(true);
      expect(holdingRowExists(forged)).toBe(true);
      const n = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date = '2020-06-01'"
          )
          .get(mine.id) as { n: number }
      ).n;
      expect(n).toBe(0);
    });
  });
});
