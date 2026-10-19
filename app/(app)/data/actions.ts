"use server";
import { requireSession,requireWriteAccess } from "@/lib/auth";
import { commitBiomarkersCore,commitWorkoutsCore } from "@/lib/import-commit";

import { extractionSemaphore } from "@/lib/ai-concurrency";
import { withAiLogContext } from "@/lib/ai-log";
import { isTaskConfigured } from "@/lib/ai-resolve";
import { checkAndIncrementAiUsage,extractionDailyLimit } from "@/lib/ai-usage";
import { db,today } from "@/lib/db";
import { getEquipment } from "@/lib/equipment";
import { isStrengthTrainingRelevant } from "@/lib/life-stage";
import { ALL_LIFT_NAMES } from "@/lib/lifts";
import { createLogger } from "@/lib/log";
import {
extractMedicalDocument,
type ExtractedImmunization,
type ExtractedResult,
type ExtractionMeta,
} from "@/lib/medical-extract";
import { getCanonicalVocabulary } from "@/lib/queries";
import { revalidateRoute } from "@/lib/revalidate";
import { getProfileAge } from "@/lib/settings";
import { userErrorCopy } from "@/lib/user-error-copy";
import {
extractWorkouts,
type ExtractedWorkout,
} from "@/lib/workout-extract";

const log = createLogger("import");

// Surfaced (as the job's error) when the profile's daily AI extraction cap is hit
// on the /data import path: the raw pasted/loaded content is STILL persisted on the
// job row (source_text), only the Claude extraction is skipped. This reuses the
// SAME 'skipped' terminal status the no-API-key path already sets (runImportJob
// maps `skipped: true` → status 'skipped'), so the jobs list shows the existing
// degraded state — no new UI surface, no lost content, never a hard-errored request.
const AI_DAILY_LIMIT_IMPORT_MESSAGE =
  "Daily AI limit reached — import saved but not auto-extracted. It won't be sent to the model today; retry it tomorrow.";

export type ImportType = "workouts" | "clinical-results";

// Cap pasted/loaded text so a runaway paste can't blow the request budget.
const MAX_CHARS = 200_000;

// The successful shape of an extraction, stored in a job's result_json and fed
// to the review preview. (The failure case is carried on the job row's error.)
export type ImportResult =
  | {
      ok: true;
      type: "workouts";
      workouts: ExtractedWorkout[];
      // Pure-cardio rows the strength-only extractor skipped (#420) — reported so
      // the review/toast can say "N cardio rows skipped" instead of dropping them
      // silently. Optional so an older stored result_json (pre-#420) reads as none.
      cardioSkipped?: number;
    }
  | {
      ok: true;
      type: "clinical-results";
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
    isTaskConfigured("extraction") &&
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
      return {
        ok: true,
        type: "workouts",
        workouts: r.workouts,
        cardioSkipped: r.cardioSkipped,
      };
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
      type: "clinical-results",
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
    const base = `${r.workouts.length} workout${r.workouts.length === 1 ? "" : "s"} · ${sets} set${sets === 1 ? "" : "s"}`;
    const skipped = r.cardioSkipped ?? 0;
    return skipped > 0
      ? `${base} · ${skipped} cardio row${skipped === 1 ? "" : "s"} skipped`
      : base;
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

// The poller's lightweight per-job snapshot moved to lib/toaster-poll.ts with the
// poll itself (#1878): it is now a WIRE shape, owned by the module that parses it.

// Kick off an extraction in the background. Inserts a 'processing' job row and
// returns immediately with its id; the actual AI call runs fire-and-forget in the
// web process. A crash orphan is reaped by the boot-time reset (resetInterruptedWork
// in lib/migrations/boot-tasks.ts) — which is AGE-GATED on the extraction lease so a
// sibling process booting (the hourly notify tick) can't fail this still-running job
// (issue #461); it is NOT "safe because single-process" — multiple processes share
// the DB. The page shows the job as processing and the app-wide poller toasts on
// completion.
export async function startImport(
  type: ImportType,
  text: string
): Promise<{ ok: true; jobId: number } | { ok: false; error: string }> {
  const { login, profile } = await requireWriteAccess();
  const input = (text ?? "").slice(0, MAX_CHARS);
  if (!input.trim())
    return { ok: false, error: "Paste or upload some data first." };
  if (type !== "workouts" && type !== "clinical-results")
    return { ok: false, error: "Unknown import type." };
  if (
    type === "workouts" &&
    !isStrengthTrainingRelevant(getProfileAge(profile.id))
  )
    return {
      ok: false,
      error: "Strength workout imports aren’t available for this profile’s age.",
    };

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

  revalidateRoute("/data");
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
    // The raw cause goes to the operator log; the import surface renders this
    // column, so it gets house copy (#3198). It used to read
    // `Extraction crashed: <whatever was thrown>` — a sentence minted by code that
    // never considered a reader.
    log.error("import job crashed", { jobId, err });
    db.prepare(
      "UPDATE import_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND profile_id = ?"
    ).run(
      userErrorCopy(err, { doing: "read this import" }),
      jobId,
      profileId
    );
  }
  revalidateRoute("/data");
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

// The client poller's status snapshot USED to live here as a read action. It is
// now the route handler app/api/jobs/imports — a Server Action's response carries
// a freshly rendered page tree that Next applies, so polling one repainted the
// page under a half-typed record form outside the dirty-form registry (#1878).
// See lib/toaster-poll.ts.

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
      // The strength-only paste path skips pure-cardio rows; report the count so
      // they're not dropped silently (#420).
      const skipped = result.cardioSkipped ?? 0;
      message =
        `Imported ${r.workouts} workout${r.workouts === 1 ? "" : "s"} (${r.sets} set${r.sets === 1 ? "" : "s"}).` +
        (skipped > 0
          ? ` Skipped ${skipped} cardio row${skipped === 1 ? "" : "s"} (strength-only import).`
          : "");
    } else {
      // Clinical results and any vaccine doses found in the same paste commit together
      // in one transaction — so an immunization-only paste still saves, and a
      // failure can't leave clinical results committed while a retry re-imports them.
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
  revalidateRoute("/data");
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
  revalidateRoute("/data");
}

export async function commitWorkouts(workouts: ExtractedWorkout[]) {
  const {login, profile} = await requireWriteAccess();
  return commitWorkoutsCore(profile.id, login.id, workouts);
}
export async function commitBiomarkers(results: ExtractedResult[], meta: ExtractionMeta | null, immunizations?: ExtractedImmunization[]) {
  const {profile} = await requireWriteAccess();
  return commitBiomarkersCore(profile.id, results, meta, immunizations);
}
