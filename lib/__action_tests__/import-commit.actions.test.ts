// SERVER-ACTION TIER — the paste/CSV import COMMIT path (issue #323).
//
// commitImportJob claims a ready job by flipping 'ready' → 'committing' before
// writing rows, so a double-click can't import twice. The baseline import_jobs
// CHECK forbade 'committing', so that claim threw `CHECK constraint failed` on
// EVERY save and nothing was ever imported — a written-but-impossible state that
// shipped because no test at any tier drove this action. This is that missing
// coverage: run a job to 'ready', commit it, and assert the rows land and the job
// row is consumed. Migration 015 (which grows the enum) is applied by the DB-tier
// setup, so a green run here also proves the claim no longer throws.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { commitImportJob } from "@/app/(app)/data/actions";
import type { ImportResult } from "@/app/(app)/data/actions";
import { seedActor, type TestLogin, type TestProfile } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// Insert a job the extractor would have produced: status 'ready' with a parsed
// result_json. Returns the new job id.
function seedReadyJob(profileId: number, result: ImportResult): number {
  return Number(
    db
      .prepare(
        `INSERT INTO import_jobs (profile_id, type, status, summary, result_json)
         VALUES (?, ?, 'ready', ?, ?)`
      )
      .run(profileId, result.type, "pending review", JSON.stringify(result))
      .lastInsertRowid
  );
}

function jobStatus(id: number): string | undefined {
  const row = db
    .prepare("SELECT status FROM import_jobs WHERE id = ?")
    .get(id) as { status: string } | undefined;
  return row?.status;
}

describe("commitImportJob — save a ready paste import", () => {
  let login: TestLogin;
  let profile: TestProfile;

  beforeEach(() => {
    ({ login, profile } = seedActor({ profileName: "Test Patient" }));
    revalidate.mockClear();
  });

  it("commits a ready workouts job: writes activities + sets, then deletes the job", async () => {
    const set = {
      exercise: "Bench Press",
      weight: 100,
      weight_unit: "kg" as const,
      reps: 5,
      duration_sec: null,
      weight_right: null,
      reps_right: null,
      equipment: null,
    };
    const result: ImportResult = {
      ok: true,
      type: "workouts",
      workouts: [
        {
          date: "2026-01-05",
          title: "Push Day",
          notes: null,
          sets: [set, { ...set }],
        },
      ],
    };
    const jobId = seedReadyJob(profile.id, result);

    const res = await commitImportJob(jobId);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toMatch(/1 workout/);

    // The job row is consumed on success.
    expect(jobStatus(jobId)).toBeUndefined();

    // The activity + its two sets landed on the acting profile.
    const acts = db
      .prepare(
        "SELECT id, title, type FROM activities WHERE profile_id = ? ORDER BY id"
      )
      .all(profile.id) as { id: number; title: string; type: string }[];
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ title: "Push Day", type: "strength" });
    const setCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM exercise_sets WHERE activity_id = ?"
        )
        .get(acts[0].id) as { c: number }
    ).c;
    expect(setCount).toBe(2);
    expect(revalidate).toHaveBeenCalledWith("/data");
  });

  it("refuses to re-commit a job already claimed as 'committing'", async () => {
    // A job the app-read would see as mid-commit: the claim can't re-fire, so the
    // action reports it's not ready rather than importing a second time.
    const jobId = seedReadyJob(profile.id, {
      ok: true,
      type: "workouts",
      workouts: [],
    });
    db.prepare("UPDATE import_jobs SET status = 'committing' WHERE id = ?").run(
      jobId
    );

    const res = await commitImportJob(jobId);
    expect(res.ok).toBe(false);
    // Still 'committing' — untouched.
    expect(jobStatus(jobId)).toBe("committing");
  });
});
