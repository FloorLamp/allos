// SERVER-ACTION TIER — Tier-1 multi-view record-list per-item writes (issue #1328).
//
// On a multi-view record list every row carries its OWN profileId, so an edit/delete
// on a non-acting member's row must land on the ITEM's profile while GATING on that
// profile's grant — never the acting one. Each edit/delete posts `profile_id` and gates
// via the shared gateItemProfile → requireProfileWriteAccess. This tier pins that gate
// across a loop-composed list (conditions) and a set-based list (care_goals): a GRANTED
// target's write lands on the target; an UNGRANTED target is refused BEFORE any write;
// and with no `profile_id` the action falls back to the acting profile. Auth is mocked
// (harness), the DB is real.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  updateCondition,
  deleteCondition,
} from "@/app/(app)/conditions/actions";
import { updateCareGoal, deleteCareGoal } from "@/app/(app)/care-goals/actions";
import { updateRecord, deleteRecord } from "@/app/(app)/medical/actions";
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

function recordName(id: number): string | undefined {
  return (
    db.prepare("SELECT name FROM medical_records WHERE id = ?").get(id) as
      | { name: string }
      | undefined
  )?.name;
}

function seedCondition(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO conditions (name, status, source, profile_id) VALUES (?, 'active', NULL, ?)"
      )
      .run(name, profileId).lastInsertRowid
  );
}

function seedCareGoal(profileId: number, description: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO care_goals (description, source, profile_id) VALUES (?, NULL, ?)"
      )
      .run(description, profileId).lastInsertRowid
  );
}

function conditionName(id: number): string | undefined {
  return (
    db.prepare("SELECT name FROM conditions WHERE id = ?").get(id) as
      { name: string } | undefined
  )?.name;
}

describe("Tier-1 multi-view record writes gate the ITEM's profile (#1328)", () => {
  it("updateCondition with posted profile_id writes to the ITEM's profile, not the acting one", async () => {
    // Admin acting as their own profile, viewing a second granted profile in multi-view.
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const condId = seedCondition(other.id, "Asthma");

    await updateCondition(
      fd({ id: condId, name: "Asthma (updated)", profile_id: other.id })
    );

    expect(conditionName(condId)).toBe("Asthma (updated)");
    // Acting profile got nothing new.
    const actingRows = db
      .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
      .get(acting.id) as { n: number };
    expect(actingRows.n).toBe(0);
  });

  it("deleteCondition with posted profile_id deletes the ITEM's row", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const condId = seedCondition(other.id, "Eczema");

    await deleteCondition(fd({ id: condId, profile_id: other.id }));

    expect(conditionName(condId)).toBeUndefined();
  });

  it("refuses an edit targeting an UNGRANTED profile before any write", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Member self", login.id);
    // NOT granted to this member.
    const stranger = createProfile("Stranger");
    actAs(login, acting);
    const condId = seedCondition(stranger.id, "Private condition");

    await expect(
      updateCondition(
        fd({ id: condId, name: "Hacked", profile_id: stranger.id })
      )
    ).rejects.toThrow();
    // Unchanged.
    expect(conditionName(condId)).toBe("Private condition");
  });

  it("with NO profile_id falls back to the acting profile (single-view path)", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    actAs(login, acting);
    const condId = seedCondition(acting.id, "Migraine");

    await updateCondition(fd({ id: condId, name: "Migraine (edited)" }));
    expect(conditionName(condId)).toBe("Migraine (edited)");
  });

  it("set-based list (care_goals): updateCareGoal + deleteCareGoal target the ITEM's profile", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const goalId = seedCareGoal(other.id, "A1c < 7");

    await updateCareGoal(
      fd({ id: goalId, description: "A1c < 6.5", profile_id: other.id })
    );
    const desc = (
      db
        .prepare("SELECT description FROM care_goals WHERE id = ?")
        .get(goalId) as { description: string } | undefined
    )?.description;
    expect(desc).toBe("A1c < 6.5");

    await deleteCareGoal(fd({ id: goalId, profile_id: other.id }));
    expect(
      db.prepare("SELECT id FROM care_goals WHERE id = ?").get(goalId)
    ).toBeUndefined();
  });
});

describe("Multi-view Biomarkers table writes gate the ITEM's profile (#1331)", () => {
  it("updateRecord with posted profile_id edits the ITEM's reading, not the acting one", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const recId = seedRecord(other.id, "Vitamin D");

    const res = await updateRecord(
      fd({
        id: recId,
        date: "2024-05-01",
        name: "Vitamin D (updated)",
        category: "lab",
        profile_id: other.id,
      })
    );
    expect(res.ok).toBe(true);
    expect(recordName(recId)).toBe("Vitamin D (updated)");
    // The reading stayed on the OTHER profile — the acting profile got nothing.
    const actingRows = db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?")
      .get(acting.id) as { n: number };
    expect(actingRows.n).toBe(0);
  });

  it("deleteRecord with posted profile_id deletes the ITEM's reading", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, acting);
    const recId = seedRecord(other.id, "Ferritin");

    const { undoId } = await deleteRecord(
      fd({ id: recId, profile_id: other.id })
    );
    expect(undoId).not.toBeNull();
    expect(recordName(recId)).toBeUndefined();
  });

  it("refuses an edit targeting an UNGRANTED profile before any write", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Member self", login.id);
    const stranger = createProfile("Stranger");
    actAs(login, acting);
    const recId = seedRecord(stranger.id, "Glucose");

    await expect(
      updateRecord(
        fd({
          id: recId,
          date: "2024-05-01",
          name: "Hacked",
          category: "lab",
          profile_id: stranger.id,
        })
      )
    ).rejects.toThrow();
    expect(recordName(recId)).toBe("Glucose");
  });

  it("with NO profile_id falls back to the acting profile (single-view path)", async () => {
    const login = createLogin({ role: "admin" });
    const acting = createProfile("Acting", login.id);
    actAs(login, acting);
    const recId = seedRecord(acting.id, "HDL");

    const res = await updateRecord(
      fd({ id: recId, date: "2024-05-01", name: "HDL (edited)", category: "lab" })
    );
    expect(res.ok).toBe(true);
    expect(recordName(recId)).toBe("HDL (edited)");
  });
});
