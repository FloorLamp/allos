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
    // immunizations has no undo kind, so its bulk delete is non-undoable.
    expect(res).toEqual({ ok: true, deleted: 1, undoIds: [] });
    expect(immCount(profile.id)).toBe(1);
    // The remaining row is the untouched one.
    expect(
      db.prepare("SELECT vaccine FROM immunizations WHERE id = ?").get(id2)
    ).toEqual({ vaccine: "tdap" });
    // The policy's revalidate paths (plus the Data page) fired.
    expect(revalidate).toHaveBeenCalledWith("/data");
    expect(revalidate).toHaveBeenCalledWith("/records");
  });

  it("never deletes another profile's immunization rows", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("ManageB", login.id);
    const idB = addImmunizationRow(profileB.id, "mmr");

    // Acting as A, try to delete B's row id — the profile_id filter blocks it.
    const res = await deleteDatasetRows("immunizations", [idB]);
    expect(res).toEqual({ ok: true, deleted: 0, undoIds: [] });
    expect(immCount(profileB.id)).toBe(1);
  });

  it("deleteAllDatasetRows clears only the acting profile's immunizations", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("ManageB2", login.id);
    addImmunizationRow(profileA.id, "mmr");
    addImmunizationRow(profileA.id, "tdap");
    addImmunizationRow(profileB.id, "hpv");

    const res = await deleteAllDatasetRows("immunizations");
    // "Delete all" is intentionally not undoable.
    expect(res).toEqual({ ok: true, deleted: 2, undoIds: [] });
    expect(immCount(profileA.id)).toBe(0);
    expect(immCount(profileB.id)).toBe(1);
  });
});

describe("deleteDatasetRows — undoable datasets capture each row", () => {
  function addBodyMetric(profileId: number, weightKg: number): number {
    return Number(
      db
        .prepare(
          "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, '2026-01-02', ?)"
        )
        .run(profileId, weightKg).lastInsertRowid
    );
  }
  function bmCount(profileId: number): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM body_metrics WHERE profile_id = ?")
        .get(profileId) as { c: number }
    ).c;
  }

  it("returns one undo token per captured row for body_metrics", async () => {
    const { profile } = seedActor();
    const id1 = addBodyMetric(profile.id, 80);
    const id2 = addBodyMetric(profile.id, 81);
    expect(bmCount(profile.id)).toBe(2);

    const res = await deleteDatasetRows("body_metrics", [id1, id2]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deleted).toBe(2);
    expect(res.undoIds).toHaveLength(2);
    expect(bmCount(profile.id)).toBe(0);

    // Each token restores its row (issue #29 bulk undo → restoreDeletedRow).
    const { restoreDeletedRow } = await import("@/lib/undo-delete-db");
    for (const token of res.undoIds)
      expect(restoreDeletedRow(profile.id, token)).toBe(true);
    expect(bmCount(profile.id)).toBe(2);
  });
});

describe("deleteDatasetRows — browse-only datasets are rejected", () => {
  it("intake_log (deletable:false, no policy) resolves to Unknown dataset", async () => {
    seedActor();
    const res = await deleteDatasetRows("intake_log", [1]);
    expect(res).toEqual({ ok: false, error: "Unknown dataset." });
  });
});

describe("deleteDatasetRows — metric_samples writes a re-import tombstone (#653)", () => {
  function addSample(profileId: number, source: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO metric_samples
             (profile_id, source, metric, date, start_time, end_time, value)
           VALUES (?, ?, 'lean_mass_kg', '2026-03-10', ?, ?, 42.5)`
        )
        .run(profileId, source, "2026-03-10T07:00:00Z", "2026-03-10T07:00:00Z")
        .lastInsertRowid
    );
  }

  it("a deleted synced sample leaves a tombstone so the next sync can't resurrect it", async () => {
    const { profile } = seedActor();
    const source = "withings";
    const id = addSample(profile.id, source);

    const res = await deleteDatasetRows("metric_samples", [id]);
    expect(res).toMatchObject({ ok: true, deleted: 1 });

    const { upsertMetricSamples } =
      await import("@/lib/integrations/normalize");
    const counts = upsertMetricSamples(
      profile.id,
      [
        {
          metric: "lean_mass_kg",
          date: "2026-03-10",
          start_time: "2026-03-10T07:00:00Z",
          end_time: "2026-03-10T07:00:00Z",
          value: 42.5,
        },
      ],
      source
    );
    expect(counts).toMatchObject({ inserted: 0, suppressed: 1 });
    const remaining = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM metric_samples WHERE profile_id = ?"
        )
        .get(profile.id) as { c: number }
    ).c;
    expect(remaining).toBe(0);
  });
});
