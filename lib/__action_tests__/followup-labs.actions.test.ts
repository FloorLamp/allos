// SERVER-ACTION TIER — the flagged-labs follow-up chain write paths (#700).
//
// Drives the real trackLabFollowUp (biomarkers) + resolveFollowUp (upcoming) actions
// against the REAL throwaway temp DB, with the auth boundary mocked by setup.ts.
// Asserts: the create writes a linked, dated care_plan_item with source_kind='labs';
// the resolve records the outcome + closes the loop confirm-first through the SAME
// action the imaging adapter uses (dispatching on source_kind); the auth/validation
// gates (read-only refusal, cross-profile refusal, bad outcome, missing ids); and that
// a deleted source reading de-links the follow-up without a FK-500 (row-ops #700).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { trackLabFollowUp } from "@/app/(app)/biomarkers/actions";
import { resolveFollowUp } from "@/app/(app)/upcoming/actions";
import { deleteRecord } from "@/app/(app)/medical/actions";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function addReading(
  profileId: number,
  canonical: string,
  date: string,
  value = "8.2"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
         VALUES (?, ?, 'lab', ?, ?, ?, '%', ?, 'high', 'manual')`
      )
      .run(profileId, date, canonical, value, Number(value), canonical)
      .lastInsertRowid
  );
}

function carePlanRow(id: number) {
  return db
    .prepare(
      `SELECT description, planned_date, source_kind,
              source_medical_record_id AS src, recommended_interval_days AS interval,
              status, resolution, resolved_by_medical_record_id AS resolvedBy
         FROM care_plan_items WHERE id = ?`
    )
    .get(id) as
    | {
        description: string;
        planned_date: string | null;
        source_kind: string | null;
        src: number | null;
        interval: number | null;
        status: string | null;
        resolution: string | null;
        resolvedBy: number | null;
      }
    | undefined;
}

function followUpIdFor(profileId: number, recordId: number): number {
  return (
    db
      .prepare(
        "SELECT id FROM care_plan_items WHERE profile_id = ? AND source_medical_record_id = ?"
      )
      .get(profileId, recordId) as { id: number }
  ).id;
}

describe("trackLabFollowUp action", () => {
  it("creates a linked, dated 'Recheck …' follow-up from a flagged reading", async () => {
    const { profile } = seedActor();
    const now = today(profile.id);
    const readingDate = shiftDateStr(now, -30);
    const recId = addReading(profile.id, "Hemoglobin A1c", readingDate);

    const res = await trackLabFollowUp(
      fd({ record_id: recId, interval_days: 91 })
    );
    expect(res.ok).toBe(true);

    const cp = carePlanRow(followUpIdFor(profile.id, recId))!;
    expect(cp.source_kind).toBe("labs");
    expect(cp.src).toBe(recId);
    expect(cp.interval).toBe(91);
    expect(cp.description).toBe("Recheck Hemoglobin A1c");
    expect(cp.planned_date).toBe(shiftDateStr(readingDate, 91));
    expect(cp.status).toBeNull(); // open
    expect(revalidate).toHaveBeenCalledWith("/upcoming");
  });

  it("rejects a missing reading id and a bad interval", async () => {
    const { profile } = seedActor();
    expect((await trackLabFollowUp(fd({ interval_days: 91 }))).ok).toBe(false);
    const recId = addReading(profile.id, "LDL Cholesterol", today(profile.id));
    expect(
      (await trackLabFollowUp(fd({ record_id: recId, interval_days: 0 }))).ok
    ).toBe(false);
  });

  it("refuses a read-only acting session (requireWriteAccess)", async () => {
    const login = createLogin({});
    const profile = createProfile("ro", login.id);
    actAs(login, profile, "read");
    const recId = addReading(profile.id, "Hemoglobin A1c", today(profile.id));
    await expect(
      trackLabFollowUp(fd({ record_id: recId, interval_days: 91 }))
    ).rejects.toThrow();
  });
});

describe("resolveFollowUp action — labs", () => {
  async function seedFollowUp() {
    const { profile } = seedActor();
    const now = today(profile.id);
    const recId = addReading(
      profile.id,
      "Hemoglobin A1c",
      shiftDateStr(now, -120)
    );
    await trackLabFollowUp(fd({ record_id: recId, interval_days: 91 }));
    const cpId = followUpIdFor(profile.id, recId);
    // A later same-family (eAG) reading that can resolve it.
    const laterId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
           VALUES (?, ?, 'lab', 'Estimated Average Glucose', '126', 126, 'mg/dL', 'Estimated Average Glucose', 'normal', 'manual')`
        )
        .run(profile.id, shiftDateStr(now, -3)).lastInsertRowid
    );
    return { profile, cpId, laterId };
  }

  it("records the outcome + closes the loop (confirm-first) via the shared action", async () => {
    const { cpId, laterId } = await seedFollowUp();
    const res = await resolveFollowUp(
      fd({
        care_plan_item_id: cpId,
        resolution: "stable",
        resolving_study_id: laterId,
      })
    );
    expect(res.ok).toBe(true);
    const cp = carePlanRow(cpId)!;
    expect(cp.status).toBe("completed");
    expect(cp.resolution).toBe("stable");
    expect(cp.resolvedBy).toBe(laterId);
  });

  it("cannot resolve another profile's follow-up", async () => {
    const { cpId } = await seedFollowUp();
    const otherLogin = createLogin({});
    const otherProfile = createProfile("other", otherLogin.id);
    actAs(otherLogin, otherProfile, "write");
    const res = await resolveFollowUp(
      fd({ care_plan_item_id: cpId, resolution: "resolved" })
    );
    expect(res.ok).toBe(false);
    expect(carePlanRow(cpId)!.status).toBeNull();
  });
});

describe("deleteRecord row-ops (#700 labs)", () => {
  it("de-links a follow-up when its source reading is deleted (no FK-500)", async () => {
    const { profile } = seedActor();
    const now = today(profile.id);
    const recId = addReading(
      profile.id,
      "Hemoglobin A1c",
      shiftDateStr(now, -30)
    );
    await trackLabFollowUp(fd({ record_id: recId, interval_days: 91 }));
    const cpId = followUpIdFor(profile.id, recId);

    await deleteRecord(fd({ id: recId }));
    // The follow-up survives (not cascade-dropped), degraded to a generic item.
    const cp = carePlanRow(cpId)!;
    expect(cp.source_kind).toBeNull();
    expect(cp.src).toBeNull();
    // The reading is gone.
    expect(
      db.prepare("SELECT id FROM medical_records WHERE id = ?").get(recId)
    ).toBeUndefined();
  });
});
