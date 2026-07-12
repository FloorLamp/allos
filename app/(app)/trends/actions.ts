"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireWriteAccess } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import {
  getTrendPins,
  setTrendPins,
  getTrendViews,
  setTrendViews,
} from "@/lib/settings";
import { togglePin } from "@/lib/trend-pins";
import {
  addView,
  deleteView,
  findView,
  viewToQuery,
  type TrendViewParams,
} from "@/lib/trend-views";
import { generateInsight, saveInsight } from "@/lib/ai";
import {
  generateRecapNarrative,
  generateLabTrendInterpretation,
} from "@/lib/ai-narrative";
import { withAiLogContext } from "@/lib/ai-log";
import { dismissFinding, saveNarrative } from "@/lib/queries";
import type { NarrativePeriod } from "@/lib/recap-narrative";
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
  revalidatePath("/trends");
  revalidatePath("/");
}

// Generate (or regenerate) the AI weekly/monthly recap narrative and store it for
// the active profile (issue #20). Like the daily insight, the Insights tab is
// age-gated, so this re-checks the gate on the write path and bounces a direct
// POST for a restricted profile. The narrative narrates over the same rule-based
// recap the dashboard widget shows; without an API key it stores the offline
// composition (still useful, still persisted).
export async function generateRecap(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  if (isTrainingRestricted(profile.id)) redirect("/");
  const raw = String(formData.get("period") ?? "").trim();
  const period: NarrativePeriod = raw === "month" ? "month" : "week";
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
  revalidatePath("/trends");
  revalidatePath("/");
}

// Generate (or regenerate) the AI lab-trend interpretation and store it for the
// active profile (issue #20). Surfaced on the Biomarkers tab, which is NOT age-
// gated (unlike Insights), so no age check here — but still a write path, so
// requireWriteAccess. The read is grounded in the biomarker trajectory findings +
// medication timeline + conditions; degrades to the offline composition.
export async function generateLabTrend() {
  const { login, profile } = await requireWriteAccess();
  const result = await withAiLogContext(
    { loginId: login.id, profileId: profile.id },
    () => generateLabTrendInterpretation(profile.id)
  );
  saveNarrative(profile.id, {
    kind: result.kind,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    summary: result.summary,
    model: result.model,
  });
  revalidatePath("/trends");
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
  revalidatePath("/trends");
  return formOk();
}

// Dismiss a biomarker trajectory finding (issues #41/#564). The flag and the
// trajectory are two views of one concern about one analyte, so this writes the
// SHARED analyte-level acknowledgment key ("biomarker-flag:<family>") the finding
// carries as `supersedes` — silencing BOTH the trajectory watch and the analyte's
// dashboard flag ("dismiss once, silence everywhere"), at the #482 family level so
// it covers D2/D3/total. Guarded to the flag namespace so this action can only ever
// write a biomarker acknowledgment key; profile-scoped via dismissFinding.
export async function dismissTrajectory(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const ackKey = String(formData.get("ack_key") ?? "").trim();
  if (!ackKey.startsWith("biomarker-flag:"))
    return formError("Couldn't dismiss that finding.");
  dismissFinding(profile.id, ackKey);
  revalidatePath("/trends");
  revalidatePath("/");
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
  revalidatePath("/trends");
  return formOk();
}

// Pin / unpin a Trends-Overview tile for the active profile.
// The pin key ("metric:weight" | "bio:LDL Cholesterol") toggles in the per-profile
// `trend_pins` list; pinned tiles render first on the Overview. profileId is
// resolved from the session — any login acting as the profile may pin (it's
// per-profile data), so this is requireWriteAccess, not requireAdmin.
export async function toggleTrendPin(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const key = String(formData.get("key") ?? "").trim();
  if (!key) return formError("Couldn't find that tile.");
  setTrendPins(profile.id, togglePin(getTrendPins(profile.id), key));
  revalidatePath("/trends");
  return formOk();
}

// Read the hub's current URL state off the submitted form into a params bag. The
// client injects the live ?from/to/tab/cmpA/cmpB/cmpn values as hidden inputs, so
// a saved view captures exactly what the user is looking at. The pins snapshot is
// taken server-side from the profile's current trend_pins (not the form), so it
// can't be forged.
function paramsFromForm(formData: FormData, pins: string[]): TrendViewParams {
  const s = (k: string): string | undefined => {
    const v = String(formData.get(k) ?? "").trim();
    return v || undefined;
  };
  return {
    from: s("from"),
    to: s("to"),
    tab: s("tab"),
    cmpA: s("cmpA"),
    cmpB: s("cmpB"),
    cmpn: String(formData.get("cmpn") ?? "") === "1",
    pins,
  };
}

// Saved views. Save the current hub state under a name for
// the active profile — per-profile data, so requireWriteAccess (any login acting as
// the profile may save), not requireAdmin. Re-saving the same name overwrites it.
export async function saveTrendView(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Name your view.");
  const params = paramsFromForm(formData, getTrendPins(profile.id));
  setTrendViews(
    profile.id,
    addView(getTrendViews(profile.id), { name, params })
  );
  revalidatePath("/trends");
  return formOk();
}

// Delete a saved view by name.
export async function deleteTrendView(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Couldn't find that view.");
  setTrendViews(profile.id, deleteView(getTrendViews(profile.id), name));
  revalidatePath("/trends");
  return formOk();
}

// Apply a saved view: restore its pins snapshot (when it captured one) and redirect
// to the hub with the view's range/tab/compare params — reusing the SAME URL
// vocabulary the DateRangeControl / CompareControls already read. Unknown name is a
// no-op back to /trends.
export async function applyTrendView(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  const view = name ? findView(getTrendViews(profile.id), name) : null;
  if (!view) redirect("/trends");
  if (view.params.pins) {
    setTrendPins(profile.id, view.params.pins);
    revalidatePath("/trends");
  }
  const qs = viewToQuery(view.params);
  redirect(qs ? `/trends?${qs}` : "/trends");
}
