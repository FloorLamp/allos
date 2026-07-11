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

  it("commits a biomarkers job through the persist core: body-metric, height, and med projections (#418)", async () => {
    // The SAME extraction output a file upload produces — a weight vital, a height
    // vital, a prescription, and a plain lab. The paste commit must now route each
    // through persistDocumentlessImport: weight → body_metrics, height →
    // metric_samples, prescription → intake_items, lab → medical_records.
    const result: ImportResult = {
      ok: true,
      type: "biomarkers",
      results: [
        {
          category: "vitals",
          panel: null,
          name: "Body Weight",
          canonical_name: "Body Weight",
          value: "82",
          value_num: 82,
          unit: "kg",
          reference_range: null,
          flag: null,
          collected_date: "2026-01-10",
          notes: null,
        },
        {
          category: "vitals",
          panel: null,
          name: "Height",
          canonical_name: "Height",
          value: "178",
          value_num: 178,
          unit: "cm",
          reference_range: null,
          flag: null,
          collected_date: "2026-01-10",
          notes: null,
        },
        {
          category: "prescription",
          panel: null,
          name: "Lisinopril 10 mg",
          canonical_name: "Lisinopril 10 mg",
          value: null,
          value_num: null,
          unit: null,
          reference_range: null,
          flag: null,
          collected_date: "2026-01-10",
          notes: "Take 1 tablet by mouth daily",
        },
        {
          category: "lab",
          panel: "Metabolic",
          name: "Glucose",
          canonical_name: "Glucose",
          value: "95",
          value_num: 95,
          unit: "mg/dL",
          reference_range: null,
          flag: null,
          collected_date: "2026-01-10",
          notes: null,
        },
      ],
      immunizations: [],
      meta: {
        document_type: "lab",
        source: "paste",
        patient_name: null,
        patient_sex: null,
        patient_birthdate: null,
        patient_age: null,
        document_date: "2026-01-10",
      },
    };
    const jobId = seedReadyJob(profile.id, result);

    const res = await commitImportJob(jobId);
    expect(res.ok).toBe(true);
    expect(jobStatus(jobId)).toBeUndefined();

    // Weight → body_metrics (source NULL, manual-like), reaching the weight charts.
    const bm = db
      .prepare(
        "SELECT weight_kg, source FROM body_metrics WHERE profile_id = ? AND date = '2026-01-10'"
      )
      .get(profile.id) as { weight_kg: number; source: string | null };
    expect(bm.weight_kg).toBe(82);
    expect(bm.source).toBeNull();

    // Height → metric_samples (metric 'height_cm', source 'manual').
    const hs = db
      .prepare(
        "SELECT value, source FROM metric_samples WHERE profile_id = ? AND metric = 'height_cm' AND date = '2026-01-10'"
      )
      .get(profile.id) as { value: number; source: string } | undefined;
    expect(hs?.value).toBe(178);
    expect(hs?.source).toBe("manual");

    // Prescription → structured intake_items medication (document_id NULL,
    // source 'extracted'), with a schedule inferred from the sig.
    const med = db
      .prepare(
        "SELECT name, kind, document_id, source, as_needed FROM intake_items WHERE profile_id = ? AND kind = 'medication'"
      )
      .get(profile.id) as
      | {
          name: string;
          kind: string;
          document_id: number | null;
          source: string | null;
          as_needed: number;
        }
      | undefined;
    expect(med?.name).toBe("Lisinopril");
    expect(med?.document_id).toBeNull();
    expect(med?.source).toBe("extracted");
    expect(med?.as_needed).toBe(0); // "daily" → scheduled, not PRN
    const doseCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM intake_item_doses d
             JOIN intake_items i ON i.id = d.item_id
            WHERE i.profile_id = ? AND i.kind = 'medication'`
        )
        .get(profile.id) as { c: number }
    ).c;
    expect(doseCount).toBe(1);

    // The lab stays a medical_record; the weight/height were routed OUT of records.
    const recs = db
      .prepare(
        "SELECT name, category, document_id FROM medical_records WHERE profile_id = ? ORDER BY name"
      )
      .all(profile.id) as {
      name: string;
      category: string;
      document_id: number | null;
    }[];
    const names = recs.map((r) => r.name);
    expect(names).toContain("Glucose");
    expect(names).toContain("Lisinopril 10 mg"); // prescription record kept as fallback
    expect(names).not.toContain("Body Weight");
    expect(names).not.toContain("Height");
    // Documentless: every kept record carries a NULL document_id (manual-like).
    expect(recs.every((r) => r.document_id === null)).toBe(true);
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
