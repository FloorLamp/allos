"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { requireWriteAccess } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { generateInsight, saveInsight } from "@/lib/ai";
import { generateRecapNarrative } from "@/lib/ai-narrative";
import { withAiLogContext } from "@/lib/ai-log";
import { dismissFinding, saveNarrative } from "@/lib/queries";
import type { NarrativePeriod } from "@/lib/recap-narrative";
import { parseRecapScale } from "@/lib/recap-scale";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";

// Generate (or regenerate) the AI daily insight for a date and store it for the
// active profile. Moved here from the former standalone /insights page when AI
// Insights was folded into the Trends "Insights" tab (sidebar consolidation).
// The Trends page hides this tab entirely for age-restricted profiles, so the
// generate form is only ever rendered for eligible profiles.
export async function generateForDate(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  // Re-check the age gate on the write path: the Insights tab (and its generate
  // form) is spliced out of the UI for age-restricted profiles, but a direct
  // POST would otherwise still run the AI work. Bounce to the dashboard exactly
  // as the Trends/Training pages do for direct navigation (see lib/age-gate.ts).
  if (isTrainingRestricted(profile.id)) redirect("/");
  // Fall back to today for a missing/non-ISO date rather than generating an
  // insight for a garbage key ("Friday" / "2026-13-45").
  const raw = String(formData.get("date") ?? "").trim();
  const date = isRealIsoDate(raw) ? raw : today(profile.id);
  const result = await withAiLogContext(
    { loginId: login.id, profileId: profile.id },
    () => generateInsight(profile.id, date, login.id)
  );
  saveInsight(profile.id, date, result);
  revalidateRoute("/trends");
  revalidateRoute("/");
}

// Generate (or regenerate) the AI period recap narrative and store it for
// the active profile (issue #20). Like the daily insight, the Insights tab is
// age-gated, so this re-checks the gate on the write path and bounces a direct
// POST for a restricted profile. The narrative narrates over the same rule-based
// recap the dashboard widget shows; without an API key it stores the offline
// composition (still useful, still persisted).
export async function generateRecap(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  if (isTrainingRestricted(profile.id)) redirect("/");
  // The narrative period IS the recap scale (#2178) — parsed through the registry's
  // own parser, so a fourth scale needs no change here and an unknown value falls back
  // to `week` rather than being refused.
  const period: NarrativePeriod = parseRecapScale(
    String(formData.get("period") ?? "").trim()
  );
  const result = await withAiLogContext(
    { loginId: login.id, profileId: profile.id },
    () => generateRecapNarrative(profile.id, period, login.id)
  );
  saveNarrative(profile.id, {
    kind: result.kind,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    summary: result.summary,
    model: result.model,
  });
  revalidateRoute("/trends");
  revalidateRoute("/");
}

// Dismiss a "What's trending" digest chip (findings bus, #39): hide it through the
// shared suppression store keyed by "digest:<series-key>:<direction>", so it stays
// dismissed only while the SAME-direction trend persists (a reversal is a new key
// and resurfaces). Guarded to the digest namespace; profile-scoped via
// dismissFinding.
export async function dismissDigest(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith("digest:"))
    return formError("Couldn't dismiss that trend.");
  dismissFinding(profile.id, dedupeKey);
  revalidateRoute("/trends");
  return formOk();
}

// Dismiss a body-metric hygiene finding (issue #45, domain 5): a probable-error
// day-over-day weight jump. Hides it through the shared suppression store keyed by
// "body-hygiene:weight-jump:<id>". Guarded to the body-hygiene namespace (like
// dismissTrajectory) so this action can only silence a body-hygiene key; profile-
// scoped via dismissFinding.
export async function dismissBodyHygiene(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith("body-hygiene:"))
    return formError("Couldn't dismiss that finding.");
  dismissFinding(profile.id, dedupeKey);
  revalidateRoute("/trends");
  return formOk();
}

// `saveTrendsCardOrder` / `resetTrendsCardOrder` lived here until #1643. They wrote
// #1490's per-tab arrangement blob and never gained a UI caller, so the Body tab's
// arrangement now runs on the ONE store the ★ already writes (`saved_items`): the
// star toggle is app/(app)/saved-actions.ts `toggleSavedItem`, the sequence is its
// `reorderSaved`, and lib/trends-card-rank.ts `bodyCardOrder` composes pinned-first
// over the ranked remainder. There is no second arrangement action to keep in step.

// `saveTrendView` / `deleteTrendView` / `applyTrendView` (and their `paramsFromForm`
// helper) lived here until #1653. The Trends overhaul deleted `SavedViewsBar` and
// its render call, so the Views strip and its "Save current" button were the only
// entry points into them and nothing reached them any more — leaving three
// still-POSTable Server Actions reading and writing a `trend_views` blob no surface
// showed. The pure list math (lib/trend-views.ts) and the `getTrendViews` /
// `setTrendViews` settings accessors went with them; the stored rows are simply
// inert. e2e/trends-saved-views.spec.ts keeps the browser guard that neither those
// rows nor anything else brings the strip back.
