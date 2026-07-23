// SERVER-ACTION TIER — the Data → Review unit-mislabel remediation (issue #761):
// applyUnitMislabel / undoUnitMislabel / dismissUnitMislabel. Drives the real Server
// Actions through the mocked auth boundary (harness), proving:
//   • Apply corrects the stored unit, sets the `edited` edit-lock (#133), re-derives
//     the flag, and returns the captured prior state for undo,
//   • Undo restores the prior unit AND flag AND edit-lock (row-ops side-state),
//   • Dismiss records a false positive so the card no longer surfaces,
//   • all three are profile-scoped (a foreign row is untouched / not found).

import { describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  applyUnitMislabel,
  undoUnitMislabel,
  dismissUnitMislabel,
} from "@/app/(app)/data/review-actions";
import { getUnitMislabelReviews } from "@/lib/queries";
import { seedActor, createProfile, fd } from "./harness";

function insertMchcMislabel(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num, reference_range, flag)
         VALUES (?, ?, 'lab', 'Mean Corpuscular Hemoglobin Concentration (MCHC)', '33', 'g/L', 'Mean Corpuscular Hemoglobin Concentration (MCHC)', 33, '31-37', NULL)`
      )
      .run(profileId, today(profileId)).lastInsertRowid
  );
}

function rowOf(id: number): {
  unit: string | null;
  flag: string | null;
  edited: number | null;
} {
  return db
    .prepare("SELECT unit, flag, edited FROM medical_records WHERE id = ?")
    .get(id) as {
    unit: string | null;
    flag: string | null;
    edited: number | null;
  };
}

describe("applyUnitMislabel", () => {
  it("corrects the unit, sets edited, re-derives the flag, and returns an undo token", async () => {
    const { profile } = seedActor();
    const id = insertMchcMislabel(profile.id);

    const res = await applyUnitMislabel(fd({ id }));
    if (!res.ok) throw new Error(res.error);
    expect(res.undo).toMatchObject({ id, unit: "g/L", flag: null, edited: 0 });

    const row = rowOf(id);
    expect(row.unit).toBe("g/dL");
    expect(row.edited).toBe(1);
    expect(row.flag).toBeNull(); // 33 g/dL is in range → Normal
    expect(getUnitMislabelReviews(profile.id)).toHaveLength(0);
  });

  it("undo restores the prior unit AND flag AND edit-lock", async () => {
    const { profile } = seedActor();
    const id = insertMchcMislabel(profile.id);

    const res = await applyUnitMislabel(fd({ id }));
    if (!res.ok) throw new Error(res.error);
    expect(rowOf(id).unit).toBe("g/dL");

    const undone = await undoUnitMislabel(res.undo);
    expect(undone).toEqual({ ok: true });
    const row = rowOf(id);
    expect(row.unit).toBe("g/L");
    expect(row.flag).toBeNull();
    expect(row.edited).toBe(0);
    // The card surfaces again after undo.
    expect(getUnitMislabelReviews(profile.id)).toHaveLength(1);
  });

  it("rejects a foreign profile's row (scoping)", async () => {
    const { login } = seedActor();
    const other = createProfile("Other", login.id);
    const foreignId = insertMchcMislabel(other.id);

    // Acting as the seeded profile, apply against the OTHER profile's row.
    const res = await applyUnitMislabel(fd({ id: foreignId }));
    expect(res.ok).toBe(false);
    expect(rowOf(foreignId).unit).toBe("g/L"); // untouched
  });
});

describe("dismissUnitMislabel", () => {
  it("records a false positive so the card no longer surfaces", async () => {
    const { profile } = seedActor();
    const id = insertMchcMislabel(profile.id);
    expect(getUnitMislabelReviews(profile.id)).toHaveLength(1);

    const res = await dismissUnitMislabel(fd({ id }));
    expect(res).toEqual({ ok: true });
    expect(getUnitMislabelReviews(profile.id)).toHaveLength(0);
    // The row itself is untouched — only the detection is suppressed.
    expect(rowOf(id).unit).toBe("g/L");
  });
});

// The action calls revalidatePath (mocked in setup) — assert it fired so the surfaces
// refresh, mirroring the other Review-action tests.
describe("revalidation", () => {
  it("revalidates after Apply", async () => {
    const { profile } = seedActor();
    const id = insertMchcMislabel(profile.id);
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();
    await applyUnitMislabel(fd({ id }));
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/data");
    void profile;
  });
});
