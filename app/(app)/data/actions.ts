"use server";
import { requireSession, requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { getUnitPrefs } from "@/lib/settings";
import {
  applyImportFollowups,
  persistDocumentlessImport,
} from "@/lib/import-persist";
import { extractionToPersistInput } from "@/lib/import-shape";
import { toKg } from "@/lib/units";
import { ALL_LIFT_NAMES, suggestTitle } from "@/lib/lifts";
import { getEquipment } from "@/lib/equipment";
import { createLogger } from "@/lib/log";
import {
  extractWorkouts,
  type ExtractedWorkout,
} from "@/lib/workout-extract";
import {
  extractMedicalDocument,
  type ExtractedResult,
  type ExtractedImmunization,
  type ExtractionMeta,
} from "@/lib/medical-extract";
import { getCanonicalVocabulary } from "@/lib/queries";
import { aiConfigured } from "@/lib/ai-client";
import { withAiLogContext } from "@/lib/ai-log";
import { checkAndIncrementAiUsage, extractionDailyLimit } from "@/lib/ai-usage";
import { extractionSemaphore } from "@/lib/ai-concurrency";

const log = createLogger("import");

// Surfaced (as the job's error) when the profile's daily AI extraction cap is hit
// on the /data import path: the raw pasted/loaded content is STILL persisted on the
// job row (source_text), only the Claude extraction is skipped. This reuses the
// SAME 'skipped' terminal status the no-API-key path already sets (runImportJob
// maps `skipped: true` → status 'skipped'), so the jobs list shows the existing
// degraded state — no new UI surface, no lost content, never a hard-errored request.
const AI_DAILY_LIMIT_IMPORT_MESSAGE =
  "Daily AI limit reached — import saved but not auto-extracted. It won't be sent to the model today; retry it tomorrow.";

export type ImportType = "workouts" | "biomarkers";

// Cap pasted/loaded text so a runaway paste can't blow the request budget.
const MAX_CHARS = 200_000;

// The successful shape of an extraction, stored in a job's result_json and fed
// to the review preview. (The failure case is carried on the job row's error.)
export type ImportResult =
  | { ok: true; type: "workouts"; workouts: ExtractedWorkout[] }
  | {
      ok: true;
      type: "biomarkers";
      results: ExtractedResult[];
      immunizations: ExtractedImmunization[];
      meta: ExtractionMeta;
    };

export type ImportPreview =
  | ImportResult
  // `skipped` distinguishes a graceful skip (e.g. no ANTHROPIC_API_KEY) from a
  // genuine failure, so the job row can carry status 'skipped' not 'failed'.
  | { ok: false; error: string; skipped?: boolean };

// Run AI extraction and return the parsed rows (or an error). No writes. Used by
// the background job runner below.
async function extractImport(
  type: ImportType,
  text: string,
  profileId: number
): Promise<ImportPreview> {
  const input = (text ?? "").slice(0, MAX_CHARS);
  if (!input.trim())
    return { ok: false, error: "Paste or upload some data first." };

  // Per-profile daily AI cap (rate-limiting Fix 1). This is the /data import
  // path's Claude-extraction chokepoint — the second AI entrypoint alongside the
  // medical upload path — so it must be bounded exactly like that one. Only
  // consume a unit when a Claude call would REALLY dispatch (a key is present);
  // with NO key the extractors below record their own no-key skip, so we don't
  // burn quota when AI is disabled/degraded anyway. On exhaustion, degrade to the
  // graceful terminal 'skipped' (runImportJob maps `skipped: true` → status
  // 'skipped') — the raw source_text stays on the job row, never a hard error.
  if (
    aiConfigured() &&
    !checkAndIncrementAiUsage(
      profileId,
      "extraction",
      extractionDailyLimit(),
      today(profileId)
    ).allowed
  ) {
    return { ok: false, error: AI_DAILY_LIMIT_IMPORT_MESSAGE, skipped: true };
  }

  // Route the dispatch through the process-wide extraction semaphore so it shares
  // the global concurrency budget with the medical upload path (at most N document
  // extractions at once; the rest queue). NOTE: extractWorkouts fans out its own
  // bounded batches internally — see the report; we wrap the whole per-document
  // call rather than nesting the inner chunks under the same fixed-size semaphore
  // (which would deadlock), so the outer permit dominates job-level concurrency.
  if (type === "workouts") {
    const equipmentNames = getEquipment(profileId).map((e) => e.name);
    const r = await extractionSemaphore.run(() =>
      extractWorkouts(input, ALL_LIFT_NAMES, equipmentNames)
    );
    if (r.status === "done")
      return { ok: true, type: "workouts", workouts: r.workouts };
    if (r.status === "skipped")
      return { ok: false, error: r.message, skipped: true };
    return { ok: false, error: r.error };
  }

  const r = await extractionSemaphore.run(() =>
    extractMedicalDocument(
      Buffer.from(input, "utf8"),
      "text/csv",
      "pasted.csv",
      getCanonicalVocabulary()
    )
  );
  if (r.status === "done")
    return {
      ok: true,
      type: "biomarkers",
      results: r.results,
      immunizations: r.immunizations,
      meta: r.meta,
    };
  if (r.status === "skipped")
    return { ok: false, error: r.message, skipped: true };
  return { ok: false, error: r.error };
}

// One-line summary of what an extraction produced, shown on the job card and in
// the completion toast.
function resultSummary(r: ImportResult): string {
  if (r.type === "workouts") {
    const sets = r.workouts.reduce((n, w) => n + w.sets.length, 0);
    return `${r.workouts.length} workout${r.workouts.length === 1 ? "" : "s"} · ${sets} set${sets === 1 ? "" : "s"}`;
  }
  const readings = `${r.results.length} reading${r.results.length === 1 ? "" : "s"}`;
  // Optional-chain: jobs persisted before immunizations were threaded through
  // this type won't carry the field.
  const n = r.immunizations?.length ?? 0;
  const imm = n ? ` · ${n} immunization${n === 1 ? "" : "s"}` : "";
  return readings + imm;
}

// ---- Async import jobs (extract in the background, review, then save) ----

export interface ImportJob {
  id: number;
  type: ImportType;
  status: "processing" | "ready" | "committing" | "failed" | "skipped";
  summary: string | null;
  error: string | null;
  created_at: string;
  // The parsed extraction, present once status is 'ready'.
  result: ImportResult | null;
}

// Lightweight per-job status snapshot for the client poller (no heavy
// result_json), so it can detect processing → ready/failed transitions.
export interface ImportJobState {
  id: number;
  type: ImportType;
  status: ImportJob["status"];
  summary: string | null;
  error: string | null;
}

// Kick off an extraction in the background. Inserts a 'processing' job row and
// returns immediately with its id; the actual AI call runs fire-and-forget (safe
// in this single long-lived Node process — orphans are reset in migrate()). The
// page shows the job as processing and the app-wide poller toasts on completion.
export async function startImport(
  type: ImportType,
  text: string
): Promise<{ ok: true; jobId: number } | { ok: false; error: string }> {
  const { login, profile } = await requireWriteAccess();
  const input = (text ?? "").slice(0, MAX_CHARS);
  if (!input.trim())
    return { ok: false, error: "Paste or upload some data first." };
  if (type !== "workouts" && type !== "biomarkers")
    return { ok: false, error: "Unknown import type." };

  const info = db
    .prepare(
      "INSERT INTO import_jobs (type, status, source_text, profile_id) VALUES (?, 'processing', ?, ?)"
    )
    .run(type, input, profile.id);
  const jobId = Number(info.lastInsertRowid);

  // Fire-and-forget in this long-lived process (mirrors medical extraction).
  // Attach a catch so a stray rejection (e.g. a background revalidatePath outside
  // request scope) can't surface as an unhandled promise rejection — the job's
  // own status is already persisted by runImportJob's internal try/catch.
  // Wrap in the AI-log context so the extraction's events carry this session's
  // login/profile even though the runner is launched fire-and-forget.
  withAiLogContext({ loginId: login.id, profileId: profile.id }, () => {
    void runImportJob(jobId, type, input, profile.id).catch((err) => {
      log.error("import job runner rejected", { jobId, err });
    });
  });

  revalidatePath("/data");
  return { ok: true, jobId };
}

// Background runner: extract, then store the parsed result (status 'ready') or
// the failure reason ('failed'/'skipped') on the job row. Never throws — a crash
// is recorded as a failed job so the row doesn't hang on 'processing'.
async function runImportJob(
  jobId: number,
  type: ImportType,
  text: string,
  profileId: number
) {
  try {
    const res = await extractImport(type, text, profileId);
    if (!res.ok) {
      // A graceful skip (e.g. no API key) is recorded as 'skipped', not 'failed'.
      const status = res.skipped ? "skipped" : "failed";
      db.prepare(
        "UPDATE import_jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ? AND profile_id = ?"
      ).run(status, res.error, jobId, profileId);
    } else {
      db.prepare(
        `UPDATE import_jobs
           SET status = 'ready', result_json = ?, summary = ?, error = NULL,
               updated_at = datetime('now')
         WHERE id = ? AND profile_id = ?`
      ).run(JSON.stringify(res), resultSummary(res), jobId, profileId);
    }
  } catch (err) {
    log.error("import job crashed", { jobId, err });
    db.prepare(
      "UPDATE import_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND profile_id = ?"
    ).run(
      `Extraction crashed: ${err instanceof Error ? err.message : "unknown error"}`,
      jobId,
      profileId
    );
  }
  revalidatePath("/data");
}

interface ImportJobRow {
  id: number;
  type: ImportType;
  status: ImportJob["status"];
  summary: string | null;
  error: string | null;
  created_at: string;
  result_json: string | null;
}

// All import jobs, newest first, with result_json parsed for the review UI.
export async function getImportJobs(): Promise<ImportJob[]> {
  const { profile } = await requireSession();
  const rows = db
    .prepare(
      `SELECT id, type, status, summary, error, created_at, result_json
       FROM import_jobs WHERE profile_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(profile.id) as ImportJobRow[];
  return rows.map((r) => {
    let result: ImportResult | null = null;
    if (r.result_json) {
      try {
        result = JSON.parse(r.result_json) as ImportResult;
      } catch {
        result = null;
      }
    }
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      summary: r.summary,
      error: r.error,
      created_at: r.created_at,
      result,
    };
  });
}

// Lightweight status snapshot the client poller reads on an interval.
export async function getImportJobStates(): Promise<ImportJobState[]> {
  const { profile } = await requireSession();
  return db
    .prepare(
      "SELECT id, type, status, summary, error FROM import_jobs WHERE profile_id = ? ORDER BY id"
    )
    .all(profile.id) as ImportJobState[];
}

// Commit a reviewed job's stored result via the existing commit paths, then
// delete the job row. Reads the result from the DB (never trusts client-passed
// rows), so this is safe to call from a plain button.
export async function commitImportJob(
  jobId: number
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const row = db
    .prepare(
      "SELECT status, result_json FROM import_jobs WHERE id = ? AND profile_id = ?"
    )
    .get(jobId, profile.id) as
    | { status: string; result_json: string | null }
    | undefined;
  if (!row) return { ok: false, error: "That import is no longer available." };
  if (row.status !== "ready" || !row.result_json)
    return { ok: false, error: "This import isn't ready to save yet." };

  let result: ImportResult;
  try {
    result = JSON.parse(row.result_json) as ImportResult;
  } catch {
    return { ok: false, error: "Stored extraction was corrupted." };
  }

  // Claim the job atomically so a double-click can't import the same rows twice:
  // only the first call flips 'ready' → 'committing' and proceeds. On failure we
  // revert to 'ready' so the user can retry.
  const claimed = db
    .prepare(
      "UPDATE import_jobs SET status = 'committing', updated_at = datetime('now') WHERE id = ? AND status = 'ready' AND profile_id = ?"
    )
    .run(jobId, profile.id);
  if (claimed.changes !== 1)
    return { ok: false, error: "This import is already being saved." };

  const revertToReady = () =>
    db
      .prepare(
        "UPDATE import_jobs SET status = 'ready', updated_at = datetime('now') WHERE id = ? AND profile_id = ?"
      )
      .run(jobId, profile.id);

  let message: string;
  try {
    if (result.type === "workouts") {
      const r = await commitWorkouts(result.workouts);
      if (!r.ok) {
        revertToReady();
        return { ok: false, error: r.error };
      }
      message = `Imported ${r.workouts} workout${r.workouts === 1 ? "" : "s"} (${r.sets} set${r.sets === 1 ? "" : "s"}).`;
    } else {
      // Biomarkers and any vaccine doses found in the same paste commit together
      // in one transaction — so an immunization-only paste still saves, and a
      // failure can't leave biomarkers committed while a retry re-imports them.
      const r = await commitBiomarkers(
        result.results,
        result.meta,
        result.immunizations
      );
      if (!r.ok) {
        revertToReady();
        return { ok: false, error: r.error };
      }
      const parts: string[] = [];
      if (r.count)
        parts.push(`${r.count} biomarker reading${r.count === 1 ? "" : "s"}`);
      if (r.bodyMetricCount)
        parts.push(
          `${r.bodyMetricCount} body metric${r.bodyMetricCount === 1 ? "" : "s"}`
        );
      if (r.sampleCount)
        parts.push(
          `${r.sampleCount} growth measurement${r.sampleCount === 1 ? "" : "s"}`
        );
      if (r.medCount)
        parts.push(`${r.medCount} medication${r.medCount === 1 ? "" : "s"}`);
      if (r.immCount)
        parts.push(`${r.immCount} immunization${r.immCount === 1 ? "" : "s"}`);
      // Every projected row was written even if none stayed a plain biomarker
      // reading (e.g. a weights-only paste), so fall back to a generic count.
      message = parts.length
        ? `Imported ${parts.join(", ")}.`
        : "Import saved.";
    }
  } catch (err) {
    revertToReady();
    throw err;
  }

  db.prepare("DELETE FROM import_jobs WHERE id = ? AND profile_id = ?").run(
    jobId,
    profile.id
  );
  revalidatePath("/data");
  return { ok: true, message };
}

// Drop a job (from a failed extraction, or a ready one the user chose not to
// save). No effect on any data already committed.
export async function discardImportJob(jobId: number): Promise<void> {
  const { profile } = await requireWriteAccess();
  db.prepare("DELETE FROM import_jobs WHERE id = ? AND profile_id = ?").run(
    jobId,
    profile.id
  );
  revalidatePath("/data");
}

// AI-supplied dates: require a real ISO calendar date (shape + validity) before
// it lands in a YYYY-MM-DD column.
const isIsoDate = isRealIsoDate;

// Step 2a: import confirmed workouts into activities + exercise_sets. Each
// workout becomes one strength activity; weights convert to kg from their
// source unit (falling back to the user's preferred unit).
export async function commitWorkouts(
  workouts: ExtractedWorkout[]
): Promise<{ ok: true; workouts: number; sets: number } | { ok: false; error: string }> {
  const { login, profile } = await requireWriteAccess();
  if (!Array.isArray(workouts) || workouts.length === 0)
    return { ok: false, error: "Nothing to import." };

  const prefs = getUnitPrefs(login.id);
  // Resolve the extracted equipment name to a user-defined row (case-insensitive).
  // includeRetired: an imported set that names retired gear should still link to
  // the existing row rather than losing its implement (issue #341).
  const equipByName = new Map(
    getEquipment(profile.id, { includeRetired: true }).map((e) => [
      e.name.trim().toLowerCase(),
      e,
    ])
  );
  const insertActivity = db.prepare(
    `INSERT INTO activities (date, type, title, notes, profile_id) VALUES (?, 'strength', ?, ?, ?)`
  );
  const insertSet = db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, weight_kg_right, reps_right,
        duration_sec, duration_sec_right, equipment_id)
     VALUES (?,?,?,?,?,?,?,?,NULL,?)`
  );

  let nWorkouts = 0;
  let nSets = 0;
  const run = db.transaction(() => {
    for (const w of workouts) {
      const sets = Array.isArray(w?.sets) ? w.sets.filter((s) => s?.exercise?.trim()) : [];
      if (sets.length === 0) continue;
      const exNames = [...new Set(sets.map((s) => s.exercise.trim()))];
      const date = isIsoDate(w.date) ? w.date : today(profile.id);
      const title = w.title?.trim() || suggestTitle(exNames);
      const aid = Number(
        insertActivity.run(date, title, w.notes ?? null, profile.id)
          .lastInsertRowid
      );
      const counters: Record<string, number> = {};
      for (const s of sets) {
        const ex = s.exercise.trim();
        counters[ex] = (counters[ex] ?? 0) + 1;
        const unit = s.weight_unit ?? prefs.weightUnit;
        // Logged weight is the TOTAL load as-is — the bar's own weight is never
        // added, so weight / 1RM / volume numbers stay consistent with the source.
        const weightKg = s.weight != null ? toKg(s.weight, unit) : null;
        const weightKgRight = s.weight_right != null ? toKg(s.weight_right, unit) : null;
        const equip = s.equipment ? equipByName.get(s.equipment.trim().toLowerCase()) : undefined;
        insertSet.run(
          aid,
          ex,
          counters[ex],
          weightKg,
          s.reps ?? null,
          weightKgRight,
          s.reps_right ?? null,
          s.duration_sec ?? null,
          equip?.id ?? null
        );
        nSets++;
      }
      nWorkouts++;
    }
  });
  run();

  revalidatePath("/training");
  revalidatePath("/");
  return { ok: true, workouts: nWorkouts, sets: nSets };
}

// Step 2b: import a confirmed paste/CSV extraction. This routes the SAME
// extraction output a file upload produces through the SAME persist core
// (persistDocumentlessImport), so a pasted weight/body-fat reading reaches
// body_metrics (weight charts / growth card), a height/head-circ lands in
// metric_samples, and a pasted prescription is projected into a structured
// intake_items medication — none of which the old direct-INSERT paste path did
// (#418). There is no stored document, so the rows carry a NULL document_id and a
// NULL/'manual' source (manual-like) and are deliberately exempt from the
// import-footprint clear/reassign/tally contract (see persistDocumentlessImport).
export async function commitBiomarkers(
  results: ExtractedResult[],
  meta: ExtractionMeta | null,
  immunizations?: ExtractedImmunization[]
): Promise<
  | {
      ok: true;
      count: number;
      immCount: number;
      bodyMetricCount: number;
      medCount: number;
      sampleCount: number;
    }
  | { ok: false; error: string }
> {
  const { profile } = await requireWriteAccess();
  const rows = Array.isArray(results) ? results : [];
  const imms = Array.isArray(immunizations) ? immunizations : [];
  if (rows.length === 0 && imms.length === 0)
    return { ok: false, error: "Nothing to import." };

  const fallbackDate = isIsoDate(meta?.document_date)
    ? meta.document_date
    : today(profile.id);

  // Reduce the raw extraction to the one canonical PersistInput shape — the SAME
  // adapter the file-upload path uses — so body-metric / height / head-circ /
  // prescription routing all come for free. `raw`/`model` are unused by the
  // documentless writer (no medical_documents row) but the "done" shape requires
  // them, so pass empty placeholders.
  const input = extractionToPersistInput(
    {
      status: "done",
      meta: meta ?? {
        document_type: null,
        source: null,
        patient_name: null,
        patient_sex: null,
        patient_birthdate: null,
        patient_age: null,
        document_date: null,
      },
      results: rows,
      immunizations: imms,
      model: "",
      raw: "",
    },
    fallbackDate
  );

  // One transaction inside the persist core: an immunization-only paste still
  // saves, and a mid-commit failure rolls back everything so a retry can't
  // duplicate already-committed rows.
  const outcome = persistDocumentlessImport(profile.id, input);

  // Register canonical names, backfill the profile (sex/birthdate/name) when
  // unset, and reconcile flags — the same follow-ups every document import runs
  // (shared with lib/import-persist so the two can't drift). These records are
  // standalone (document_id NULL), but the follow-ups are document-agnostic.
  const adopted = applyImportFollowups(profile.id, {
    demographics: input.demographics,
    canonicalNames: input.canonicalNamesToRegister,
    insertedRecordIds: outcome.insertedRecordIds,
  });
  const sampleCount = outcome.heightCount + outcome.headCircCount;
  revalidatePath("/biomarkers");
  revalidatePath("/data");
  revalidatePath("/");
  if (outcome.immCount) revalidatePath("/immunizations");
  if (outcome.bodyMetricCount || sampleCount) {
    revalidatePath("/trends");
    revalidatePath("/body");
  }
  if (outcome.medCount) revalidatePath("/medicine");
  if (adopted.changed) revalidatePath("/settings");
  return {
    ok: true,
    count: outcome.recCount,
    immCount: outcome.immCount,
    bodyMetricCount: outcome.bodyMetricCount,
    medCount: outcome.medCount,
    sampleCount,
  };
}
