// SERVER-ACTION TIER — Data → Manage delete path (deleteDatasetRows /
// deleteAllDatasetRows).
//
// Proves the delete affordance the UI renders (DataExport shows Edit/Delete for
// every deletable dataset) actually deletes end-to-end through the real action:
// key → DELETE_POLICY resolve → scoped `DELETE ... WHERE id IN (...) AND
// profile_id = ?`. The regression this guards: `immunizations` renders a delete
// button but had no DELETE_POLICY entry, so resolve() returned null and the action
// no-op'd with an "Unknown dataset" error. It also re-asserts profile scoping (a
// row belonging to another profile is untouched) and the browse-only guard
// (intake_log has no policy, so its delete is rejected, matching the hidden UI).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  deleteDatasetRows,
  deleteAllDatasetRows,
} from "@/app/(app)/data/manage-actions";
import { seedActor, createProfile } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function addImmunizationRow(profileId: number, vaccine: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO immunizations (profile_id, date, vaccine, dose_label) VALUES (?, '2001-06-01', ?, '1')"
      )
      .run(profileId, vaccine).lastInsertRowid
  );
}

function immCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM immunizations WHERE profile_id = ?")
      .get(profileId) as { c: number }
  ).c;
}

beforeEach(() => revalidate.mockClear());

describe("deleteDatasetRows — immunizations (regression: missing DELETE_POLICY)", () => {
  it("deletes the selected immunization rows and revalidates its pages", async () => {
    const { profile } = seedActor();
    const id1 = addImmunizationRow(profile.id, "mmr");
    const id2 = addImmunizationRow(profile.id, "tdap");
    expect(immCount(profile.id)).toBe(2);

    const res = await deleteDatasetRows("immunizations", [id1]);
    expect(res).toEqual({ ok: true, deleted: 1 });
    expect(immCount(profile.id)).toBe(1);
    // The remaining row is the untouched one.
    expect(
      db.prepare("SELECT vaccine FROM immunizations WHERE id = ?").get(id2)
    ).toEqual({ vaccine: "tdap" });
    // The policy's revalidate paths (plus the Data page) fired.
    expect(revalidate).toHaveBeenCalledWith("/data");
    expect(revalidate).toHaveBeenCalledWith("/immunizations");
  });

  it("never deletes another profile's immunization rows", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("ManageB", login.id);
    const idB = addImmunizationRow(profileB.id, "mmr");

    // Acting as A, try to delete B's row id — the profile_id filter blocks it.
    const res = await deleteDatasetRows("immunizations", [idB]);
    expect(res).toEqual({ ok: true, deleted: 0 });
    expect(immCount(profileB.id)).toBe(1);
  });

  it("deleteAllDatasetRows clears only the acting profile's immunizations", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("ManageB2", login.id);
    addImmunizationRow(profileA.id, "mmr");
    addImmunizationRow(profileA.id, "tdap");
    addImmunizationRow(profileB.id, "hpv");

    const res = await deleteAllDatasetRows("immunizations");
    expect(res).toEqual({ ok: true, deleted: 2 });
    expect(immCount(profileA.id)).toBe(0);
    expect(immCount(profileB.id)).toBe(1);
  });
});

describe("deleteDatasetRows — browse-only datasets are rejected", () => {
  it("intake_log (deletable:false, no policy) resolves to Unknown dataset", async () => {
    seedActor();
    const res = await deleteDatasetRows("intake_log", [1]);
    expect(res).toEqual({ ok: false, error: "Unknown dataset." });
  });
});
