// Impure orchestration for AI recommendation runs (issue #424). Ties the pure
// cadence decision (lib/recommendation-run.ts) to the two existing proactive AI
// features — supplement suggestions and the daily insight — behind ONE
// cadence-gated, signature-deduped, quota-clamped run.
//
// Dispatch happens only in the WEB process (never the notify tick — quota
// atomicity assumes a single AI-calling process, lib/ai-usage.ts):
//   - document-imported: the generalized autoSuggest hook (lib/medical-pipeline).
//   - scheduled: a lazy check on the first authenticated page view (app dashboard).
//   - manual: not wired here yet; the on-demand buttons keep their own paths.
//
// Everything is fire-and-forget and self-contained: runRecommendation never throws
// into its caller, and degrades to no-ops when AI is unconfigured (the inner
// features already do). The PURE scheduling decision is unit-tested; this module is
// exercised indirectly and stays thin.

import { db, today } from "./db";
import { isTaskConfigured } from "./ai-resolve";
import { recordAiEvent } from "./ai-log";
import { checkAndIncrementAiUsage } from "./ai-usage";
import { createLogger } from "./log";
import {
  getRecommendationCadence,
  getRecommendationLastRunAt,
  getRecommendationLastSignature,
  setRecommendationLastRunAt,
  setRecommendationLastSignature,
  getRecommendationMaxRunsPerDay,
} from "./settings";
import {
  decideRecommendationRun,
  shouldSaveInsight,
  type RecommendationTrigger,
} from "./recommendation-run";
import { getInsight } from "./queries/intake/insights";
import {
  autoSuggestFromBiomarkers,
  generateAndStoreSuggestions,
} from "./supplement-suggest";
import { generateInsight, saveInsight } from "./ai";

const log = createLogger("recommendation");

// A cheap, deterministic signature of the run's inputs. Captures new labs, new
// activity, and the active intake set (started/stopped meds shift the lab-trend
// context). Compared for EQUALITY only — an unchanged signature means the same
// data would produce the same output, so the run is skipped. Every read is
// profile-scoped. AUTOINCREMENT ids make MAX(id) a monotone "new rows" witness.
export function computeRecommendationSignature(profileId: number): string {
  const mr = db
    .prepare(
      "SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM medical_records WHERE profile_id = ?"
    )
    .get(profileId) as { c: number; m: number };
  const act = db
    .prepare(
      "SELECT COUNT(*) AS c, COALESCE(MAX(date), '') AS d FROM activities WHERE profile_id = ?"
    )
    .get(profileId) as { c: number; d: string };
  const intake = db
    .prepare(
      "SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM intake_items WHERE profile_id = ? AND active = 1"
    )
    .get(profileId) as { c: number; m: number };
  return `mr:${mr.c}:${mr.m}|act:${act.c}:${act.d}|intake:${intake.c}:${intake.m}`;
}

interface RunOpts {
  trigger: RecommendationTrigger;
  // For the document-imported trigger: the just-imported record ids to scope the
  // supplement suggestions to (mirrors the old autoSuggest hook).
  recordIds?: number[];
  // Resolves the reader's display units for the insight; absent in background
  // contexts (canonical units then).
  loginId?: number;
}

// Evaluate the cadence and, when due, run the recommendation. Fire-and-forget:
// callers `void` this. Returns the decision reason for tests/diagnostics.
export async function runRecommendation(
  profileId: number,
  opts: RunOpts
): Promise<string> {
  try {
    // No key → the inner features would no-op anyway; skip the whole dance so a
    // lazy page view doesn't churn signatures/markers on an offline instance.
    if (!isTaskConfigured("insight")) return "not-configured";

    const cadence = getRecommendationCadence(profileId);
    const signature = computeRecommendationSignature(profileId);
    const lastRunAt = getRecommendationLastRunAt(profileId);
    const lastSignature = getRecommendationLastSignature(profileId);
    const now = new Date().toISOString();

    const decision = decideRecommendationRun({
      cadence,
      trigger: opts.trigger,
      lastRunAt,
      now,
      inputSignature: signature,
      lastSignature,
    });

    if (!decision.run) {
      // A DUE run gated only by an unchanged signature is worth recording (and
      // advancing the run marker so a scheduled trigger doesn't re-check every
      // page view). off / cadence-not-due are silent — they'd spam the log.
      if (decision.reason === "signature-unchanged") {
        recordAiEvent({
          feature: "recommendation",
          status: "skipped",
          detail: `${opts.trigger} — inputs unchanged since last run`,
        });
        setRecommendationLastRunAt(profileId, now);
      }
      return decision.reason;
    }

    // Global per-profile daily clamp (admin-set). A cap hit advances the run marker
    // so a scheduled trigger stops re-attempting every page view until tomorrow.
    if (
      !checkAndIncrementAiUsage(
        profileId,
        "recommendation",
        getRecommendationMaxRunsPerDay()
      ).allowed
    ) {
      recordAiEvent({
        feature: "recommendation",
        status: "skipped",
        detail: `${opts.trigger} — daily recommendation run cap reached`,
      });
      setRecommendationLastRunAt(profileId, now);
      return "capped";
    }

    const startedAt = Date.now();
    // Supplement half: scope to the just-imported records on an upload (respects
    // the auto-suggest toggle), else a full-lab scan for a scheduled/other run.
    let suggested = 0;
    try {
      suggested =
        opts.trigger === "document-imported" && opts.recordIds?.length
          ? await autoSuggestFromBiomarkers(profileId, opts.recordIds)
          : (await generateAndStoreSuggestions(profileId)).inserted;
    } catch (err) {
      log.error("recommendation: suggestion step failed", { profileId, err });
    }

    // Insight half: refresh today's daily coaching insight (idempotent upsert).
    let insightModel = "";
    try {
      const date = today(profileId);
      const result = await generateInsight(profileId, date, opts.loginId);
      // Don't let a transient offline-fallback (API blip / truncation / cap
      // exhaustion — generateInsight never throws) clobber a good AI insight
      // already stored today; only save an offline result when the slot is empty
      // (#633).
      if (
        shouldSaveInsight({
          newModel: result.model,
          hasExisting: getInsight(profileId, date) !== undefined,
        })
      ) {
        saveInsight(profileId, date, result);
      }
      insightModel = result.model;
    } catch (err) {
      log.error("recommendation: insight step failed", { profileId, err });
    }

    recordAiEvent({
      feature: "recommendation",
      status: "ok",
      durationMs: Date.now() - startedAt,
      detail: `${opts.trigger} run — ${suggested} suggestion(s), insight ${insightModel || "unavailable"}`,
    });

    // Advance the markers only after a run actually fired, so a crash mid-run
    // leaves the cadence due and a retry can complete it.
    setRecommendationLastRunAt(profileId, now);
    setRecommendationLastSignature(profileId, signature);
    return decision.reason;
  } catch (err) {
    log.error("recommendation run failed", { profileId, err });
    return "error";
  }
}
