// PURE cadence-decision logic for AI recommendation runs (issue #424). No db /
// network (only a pure sibling helper), so it lives in the pure test suite
// (lib/__tests__/recommendation-run.test.ts). The impure orchestration — the
// context/signature gather and the actual AI calls — lives in
// lib/recommendation-engine.ts, which reuses this decision.

import { isOfflineModelTag } from "./offline-narrative";
//
// A "recommendation run" generalizes the two proactive AI features (supplement
// suggestions + the daily insight) into ONE cadence-gated generation, dispatched
// from the web process only (the notify tick never calls Claude — quota atomicity
// assumes a single AI-calling process, lib/ai-usage.ts). This module answers the
// one scheduling question: given the profile's cadence, the last run, the trigger,
// and an input signature, should a run fire now?

// The user-visible cadence for scheduled runs. `off` disables everything;
// `on-upload-only` runs a recommendation when a document import lands new labs but
// never on a schedule; the calendar options additionally run lazily on the first
// page view where the period has elapsed. Intra-day cadence buys nothing once
// signature gating exists (same data → skipped run), so `daily` is the floor.
export type RecommendationCadence =
  "off" | "on-upload-only" | "daily" | "weekly" | "monthly";

export const RECOMMENDATION_CADENCES: readonly RecommendationCadence[] = [
  "off",
  "on-upload-only",
  "daily",
  "weekly",
  "monthly",
];

// Default preserves today's behavior: auto-suggestions fired on a lab import, but
// nothing ran on a schedule. `on-upload-only` keeps the upload trigger live and
// leaves scheduled runs opt-in.
export const DEFAULT_RECOMMENDATION_CADENCE: RecommendationCadence =
  "on-upload-only";

// Human labels for the picker.
export const CADENCE_LABELS: Record<RecommendationCadence, string> = {
  off: "Off",
  "on-upload-only": "On document upload only",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

// What kicked off the evaluation. `document-imported` is the generalized
// auto-suggest hook; `scheduled` is the lazy per-page-view check; `manual` is an
// explicit user request (Generate button) and bypasses the gates.
export type RecommendationTrigger =
  "document-imported" | "scheduled" | "manual";

export function parseCadence(
  raw: string | null | undefined
): RecommendationCadence {
  return RECOMMENDATION_CADENCES.includes(raw as RecommendationCadence)
    ? (raw as RecommendationCadence)
    : DEFAULT_RECOMMENDATION_CADENCE;
}

// The minimum days between scheduled runs for a calendar cadence, or null when the
// cadence has no scheduled component (off / on-upload-only).
export function cadencePeriodDays(
  cadence: RecommendationCadence
): number | null {
  switch (cadence) {
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "monthly":
      return 30;
    default:
      return null;
  }
}

// The global per-profile ceiling on runs/day (admin-set, Server tab). Scheduled
// cadence already caps at 1/day, so this is the backstop against a burst of
// upload/manual runs. Clamped to a sane 1..24; a non-integer/blank falls back to 1.
export const DEFAULT_MAX_RUNS_PER_DAY = 1;
export const MAX_RUNS_PER_DAY_CEILING = 24;

export function clampMaxRunsPerDay(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_RUNS_PER_DAY;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > MAX_RUNS_PER_DAY_CEILING) return MAX_RUNS_PER_DAY_CEILING;
  return i;
}

export type RunDecisionReason =
  | "off" // cadence disabled — never run
  | "cadence-not-due" // scheduled trigger, but the period hasn't elapsed
  | "signature-unchanged" // eligible, but the inputs are identical to the last run
  | "upload" // run because a document import landed
  | "due" // run because the scheduled period elapsed
  | "manual"; // run because the user asked explicitly

export interface RunDecision {
  run: boolean;
  reason: RunDecisionReason;
}

// Whole-day difference between two ISO datetimes (a - b), floored. Non-parseable
// inputs yield Infinity so an unknown "last run" is always treated as due.
function daysSince(now: string, last: string | null): number {
  if (!last) return Infinity;
  const a = Date.parse(now);
  const b = Date.parse(last);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.floor((a - b) / 86_400_000);
}

// The core decision. `manual` always runs (the user asked). Otherwise: `off` never
// runs; a scheduled trigger must have its period elapsed since lastRunAt; and any
// eligible run is finally gated by the input signature — an unchanged signature
// means the same data would produce the same output, so we skip (and the caller
// logs it as a `skipped` AiEvent so the cadence stays auditable).
export function decideRecommendationRun(opts: {
  cadence: RecommendationCadence;
  trigger: RecommendationTrigger;
  lastRunAt: string | null;
  now: string;
  inputSignature: string;
  lastSignature: string | null;
}): RunDecision {
  const { cadence, trigger, lastRunAt, now, inputSignature, lastSignature } =
    opts;

  if (trigger === "manual") return { run: true, reason: "manual" };

  if (cadence === "off") return { run: false, reason: "off" };

  if (trigger === "scheduled") {
    const period = cadencePeriodDays(cadence);
    // on-upload-only has no scheduled component.
    if (period == null) return { run: false, reason: "cadence-not-due" };
    if (daysSince(now, lastRunAt) < period)
      return { run: false, reason: "cadence-not-due" };
  }

  // Eligible (upload with a non-off cadence, or a due scheduled run). Signature
  // gate last: identical inputs → skip.
  if (lastSignature != null && inputSignature === lastSignature)
    return { run: false, reason: "signature-unchanged" };

  return {
    run: true,
    reason: trigger === "document-imported" ? "upload" : "due",
  };
}

// Whether a freshly generated daily insight should overwrite the stored row for its
// date (#633). generateInsight NEVER throws — a transient API blip, output
// truncation, or insight-cap exhaustion returns the deterministic OFFLINE
// composition tagged `offline/*` instead of erroring. Saving that unconditionally
// lets a mid-day cadence run (a page view, an import hook) clobber a good AI insight
// already stored today with degraded "temporarily unavailable" text. So an offline
// result is only worth saving when NOTHING is stored yet (an offline insight still
// beats an empty slot); a real-model result always saves. `hasExisting` is whether a
// prior insight row exists for that date.
export function shouldSaveInsight(opts: {
  newModel: string;
  hasExisting: boolean;
}): boolean {
  return !isOfflineModelTag(opts.newModel) || !opts.hasExisting;
}
