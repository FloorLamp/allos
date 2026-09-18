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
import { db, rawDb } from "@/lib/db";
import {
  deleteDatasetRows,
  deleteAllDatasetRows,
} from "@/app/(app)/data/manage-actions";
import {
  resolveFollowUpCore,
  trackImagingFollowUpCore,
  trackLabFollowUpCore,
} from "@/lib/followup-write";
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
    // Undoable since #1847: the dataset's rows are an undo-kind root now, so the
    // bulk delete captures each one and hands back a token per removed row.
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ ok: true, deleted: 1 });
    expect((res as { undoIds: number[] }).undoIds).toHaveLength(1);
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
    const { login } = seedActor();
    const profileB = createProfile("ManageB", login.id);
    const idB = addImmunizationRow(profileB.id, "mmr");

    // Acting as A, try to delete B's row id — the profile_id filter blocks it.
    const res = await deleteDatasetRows("immunizations", [idB]);
    // captureDelete returns null for a row that isn't the acting profile's, so the
    // batch captures nothing and reports nothing deleted.
    expect(res).toEqual({ ok: true, deleted: 0, undoIds: [] });
    expect(immCount(profileB.id)).toBe(1);
  });

  // #1847 routed this dataset through the undo branch, which returns BEFORE the
  // plain path's pre-image read. The dismissal sweep (#376) reads the vaccines that
  // were removed, so it has to take its pre-image on that branch too — otherwise a
  // bulk delete would silently leave an `immunization:<code>` suppression standing
  // with no dose backing it, and a later re-import would surface pre-silenced.
  it("still sweeps the un-backed dismissal on the undoable bulk path (#376)", async () => {
    const { profile } = seedActor();
    const id = addImmunizationRow(profile.id, "tdap");
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, 'immunization:tdap', datetime('now'))`
    ).run(profile.id);

    await deleteDatasetRows("immunizations", [id]);
    expect(
      db
        .prepare(
          `SELECT 1 FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = 'immunization:tdap'`
        )
        .get(profile.id)
    ).toBeUndefined();
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

  // #2125: the kinds #2038 made undoable at the row menu are undoable at the bulk
  // surface too — same rows, ONE contract. Pre-fix, these two datasets hard-deleted.
  function addPracticeSession(profileId: number, date: string): number {
    return Number(
      db
        .prepare(
          "INSERT INTO practice_logs (profile_id, practice, date, duration_min) VALUES (?, 'sauna', ?, 20)"
        )
        .run(profileId, date).lastInsertRowid
    );
  }
  function practiceCount(profileId: number): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM practice_logs WHERE profile_id = ?")
        .get(profileId) as { c: number }
    ).c;
  }

  it("bulk-deleted practice sessions restore from their undo tokens (#2125)", async () => {
    const { profile } = seedActor();
    const id1 = addPracticeSession(profile.id, "2026-02-01");
    const id2 = addPracticeSession(profile.id, "2026-02-03");
    const keeper = addPracticeSession(profile.id, "2026-02-05");

    const res = await deleteDatasetRows("practice_logs", [id1, id2]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deleted).toBe(2);
    expect(res.undoIds).toHaveLength(2);
    // The practice-session kind is 1:1 — the unselected sibling session survives
    // (the wellness-practice-history kind would have dragged it along).
    expect(practiceCount(profile.id)).toBe(1);
    expect(
      db.prepare("SELECT id FROM practice_logs WHERE id = ?").get(keeper)
    ).toBeDefined();

    const { restoreDeletedRow } = await import("@/lib/undo-delete-db");
    for (const token of res.undoIds)
      expect(restoreDeletedRow(profile.id, token)).toBe(true);
    expect(practiceCount(profile.id)).toBe(3);
  });

  // #5026 phase 2 CLOSED THIS DOOR, and what is pinned is that BOTH halves survive it.
  // A use is a `substance_log_events` row and a tick of the `substance_daily_totals`
  // counter, written in one transaction; this action's delete is a plain
  // `DELETE … WHERE id IN (…) AND profile_id = ?` and can only move ONE of them. So the
  // two tables became browse-only (lib/export.ts) and the action answers "Unknown
  // dataset" for both, through `resolve`, which reads DELETE_POLICY.
  //
  // THE ROWS ARE WHAT THIS ASSERTS, not the error string. A test that checked only
  // `ok: false` would pass on an action that refused AFTER deleting the counter, and
  // the state this closure exists to prevent is precisely a counter and a record that
  // disagree — so both are counted, and both doors are asked.
  it.each([
    ["substance_daily_totals", "day counter"],
    ["substance_log_events", "use events"],
  ])(
    "refuses to bulk-delete the substance %s, leaving BOTH halves standing (#5026)",
    async (key) => {
      const { profile } = seedActor();
      const dayId = Number(
        db
          .prepare(
            "INSERT INTO substance_daily_totals (profile_id, date, substance, units) VALUES (?, '2026-02-02', 'nicotine', 3)"
          )
          .run(profile.id).lastInsertRowid
      );
      const eventIds = [1, 2, 3].map((n) =>
        Number(
          db
            .prepare(
              `INSERT INTO substance_log_events
                 (profile_id, date, substance, recorded_at)
               VALUES (?, '2026-02-02', 'nicotine', ?)`
            )
            .run(profile.id, `2026-02-02T0${n}:00:00Z`).lastInsertRowid
        )
      );
      const halves = () => ({
        counters: (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM substance_daily_totals WHERE profile_id = ?"
            )
            .get(profile.id) as { n: number }
        ).n,
        events: (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM substance_log_events WHERE profile_id = ?"
            )
            .get(profile.id) as { n: number }
        ).n,
      });

      const ids = key === "substance_daily_totals" ? [dayId] : eventIds;
      expect(await deleteDatasetRows(key, ids)).toEqual({
        ok: false,
        error: "Unknown dataset.",
      });
      expect(halves()).toEqual({ counters: 1, events: 3 });
      // Delete-all takes the same `resolve`, and it is the door that would otherwise
      // wipe every counter row in one tap while every event stayed behind.
      expect(await deleteAllDatasetRows(key)).toEqual({
        ok: false,
        error: "Unknown dataset.",
      });
      expect(halves()).toEqual({ counters: 1, events: 3 });
    }
  );

  it("delete-all still tombstones a synced practice session (#653 — undo never covers delete-all)", async () => {
    // Regression for the guard this fix removed from tombstoneAllPreImages: with
    // practice_logs newly mapped to an undo kind, the old "handled by
    // captureDelete" short-circuit would have silently dropped delete-all
    // tombstones — but deleteAllDatasetRows is intentionally never undoable, so
    // nothing else writes them.
    const { profile } = seedActor();
    db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date, source, external_id) VALUES (?, 'sauna', '2026-02-01', 'oura', 'oura:sauna:1')"
    ).run(profile.id);

    const res = await deleteAllDatasetRows("practice_logs");
    expect(res).toMatchObject({ ok: true, deleted: 1, undoIds: [] });
    const tombstones = db
      .prepare(
        "SELECT natural_key FROM import_tombstones WHERE profile_id = ? AND target_table = 'practice_logs'"
      )
      .all(profile.id) as { natural_key: string }[];
    expect(tombstones.map((t) => t.natural_key)).toEqual(["oura:sauna:1"]);
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
             (profile_id, source, metric, date, started_at, ended_at, value)
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
          started_at: "2026-03-10T07:00:00Z",
          ended_at: "2026-03-10T07:00:00Z",
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

// #5966 — "Delete all" on a dataset whose rows a tracked follow-up names. The
// `care_plan_items` source/resolved-by pairs for these two tables are declared with no
// ON DELETE action, so before the seam ran here the wipe raised
// SQLITE_CONSTRAINT_FOREIGNKEY and rolled back: a person who had tracked one follow-up
// could not bulk-delete the dataset at all. The positive control below is what these
// assertions are observing — the same fixture, the same statement, no seam.
//
// Both tables are seeded through their REAL track cores (lib/followup-write.ts), so the
// link under test is the one the Track follow-up button writes, not a hand-set column.
describe("Delete all frees a tracked follow-up's link (#5966)", () => {
  const DAY = "2026-05-01";

  function addLabReading(profileId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit,
              canonical_name, flag, source)
           VALUES (?, ?, 'lab', 'Hemoglobin A1c', '8.2', 8.2, '%',
                   'Hemoglobin A1c', 'high', 'manual')`
        )
        .run(profileId, DAY).lastInsertRowid
    );
  }

  function addImagingStudy(profileId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO imaging_studies (profile_id, study_date, modality, body_region)
           VALUES (?, ?, 'mri', 'knee')`
        )
        .run(profileId, DAY).lastInsertRowid
    );
  }

  // Each case: the dataset key, the seed that writes one row, the real track core that
  // links a follow-up to it, and the source column that link lands in.
  const CASES = [
    {
      key: "medical_records",
      what: "a flagged lab reading",
      sourceColumn: "source_medical_record_id",
      seed: addLabReading,
      track: (profileId: number, rowId: number) =>
        trackLabFollowUpCore(profileId, rowId, 91, DAY),
    },
    {
      key: "imaging_studies",
      what: "an imaging finding",
      sourceColumn: "source_imaging_study_id",
      seed: addImagingStudy,
      track: (profileId: number, rowId: number) =>
        trackImagingFollowUpCore(profileId, rowId, 180, DAY),
    },
  ] as const;

  function rowCount(table: string, profileId: number): number {
    return (
      db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?`)
        .get(profileId) as { c: number }
    ).c;
  }

  function followUpLinks(carePlanItemId: number) {
    return db
      .prepare(
        `SELECT source_kind, source_medical_record_id, source_imaging_study_id,
                resolved_by_medical_record_id, resolved_by_imaging_study_id
           FROM care_plan_items WHERE id = ?`
      )
      .get(carePlanItemId);
  }

  it.each(CASES)(
    "$key: Delete all completes with a follow-up tracked from $what",
    async ({ key, seed, track, sourceColumn }) => {
      const { login, profile } = seedActor();
      const rowId = seed(profile.id);
      const tracked = track(profile.id, rowId);
      expect(tracked.kind).toBe("created");
      if (tracked.kind !== "created") return;
      // The link the button writes really is there before the wipe.
      expect(followUpLinks(tracked.carePlanItemId)).toMatchObject({
        [sourceColumn]: rowId,
      });

      // Another profile with its own tracked follow-up on its own row: the seam frees
      // by row id, so an id set read off `care_plan_items` instead of off the table
      // being deleted could reach this one. Acting as A must not touch it.
      const other = createProfile(`Other ${key}`, login.id);
      const otherRow = seed(other.id);
      const otherTracked = track(other.id, otherRow);
      expect(otherTracked.kind).toBe("created");
      if (otherTracked.kind !== "created") return;

      const res = await deleteAllDatasetRows(key);
      expect(res).toEqual({ ok: true, deleted: 1, undoIds: [] });
      expect(rowCount(key, profile.id)).toBe(0);

      // The source id AND the discriminator go together — the asymmetry migration 184
      // repairs. The care-plan item itself survives: a freed link degrades a follow-up
      // to the plain planned care it now is, it does not delete the person's plan.
      expect(followUpLinks(tracked.carePlanItemId)).toEqual({
        source_kind: null,
        source_medical_record_id: null,
        source_imaging_study_id: null,
        resolved_by_medical_record_id: null,
        resolved_by_imaging_study_id: null,
      });
      expect(
        db
          .prepare("SELECT description FROM care_plan_items WHERE id = ?")
          .get(tracked.carePlanItemId)
      ).toBeTruthy();

      // The other profile's row and its link are untouched.
      expect(rowCount(key, other.id)).toBe(1);
      expect(followUpLinks(otherTracked.carePlanItemId)).toMatchObject({
        [sourceColumn]: otherRow,
      });
      expect(rawDb.pragma("foreign_key_check")).toEqual([]);
    }
  );

  it.each(CASES)(
    "positive control — $key: the same wipe with no seam ahead of it throws and rolls back",
    async ({ key, seed, track }) => {
      // WHAT THE TWO CASES ABOVE ARE OBSERVING. Without this, a fixture that never
      // wrote the link, or a harness running with foreign keys off, would let them
      // pass while proving nothing. This is the pre-fix statement, run by hand.
      const { profile } = seedActor();
      const rowId = seed(profile.id);
      expect(track(profile.id, rowId).kind).toBe("created");
      expect(rawDb.pragma("foreign_keys", { simple: true })).toBe(1);

      expect(() =>
        db.prepare(`DELETE FROM ${key} WHERE profile_id = ?`).run(profile.id)
      ).toThrow(/FOREIGN KEY constraint failed/);
      // Rolled back — nothing was deleted, which is why the person was stuck.
      expect(rowCount(key, profile.id)).toBe(1);
    }
  );

  it("a resolved-by link is freed alone, leaving the source link standing", async () => {
    // The other half of the asymmetry. A resolved imaging follow-up names TWO studies:
    // the finding it came from and the later study that settled it. Deleting only the
    // resolving study must drop that link and keep the source link and the
    // discriminator, so the item still reads as the imaging follow-up it is.
    const { profile } = seedActor();
    const source = addImagingStudy(profile.id);
    const later = addImagingStudy(profile.id);
    const tracked = trackImagingFollowUpCore(profile.id, source, 180, DAY);
    expect(tracked.kind).toBe("created");
    if (tracked.kind !== "created") return;
    expect(
      resolveFollowUpCore(profile.id, tracked.carePlanItemId, "stable", later)
        .kind
    ).toBe("resolved");

    const res = await deleteDatasetRows("imaging_studies", [later]);
    expect(res).toMatchObject({ ok: true, deleted: 1 });
    expect(followUpLinks(tracked.carePlanItemId)).toMatchObject({
      source_kind: "imaging",
      source_imaging_study_id: source,
      resolved_by_imaging_study_id: null,
    });
    // The outcome text the person recorded survives the dead link.
    expect(
      db
        .prepare("SELECT resolution FROM care_plan_items WHERE id = ?")
        .get(tracked.carePlanItemId)
    ).toEqual({ resolution: "stable" });
  });
});
