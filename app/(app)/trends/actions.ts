"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
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
import { withAiLogContext } from "@/lib/ai-log";
import { today } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";

// Generate (or regenerate) the AI daily insight for a date and store it for the
// active profile. Moved here from the former standalone /insights page when AI
// Insights was folded into the Trends "Insights" tab (sidebar consolidation).
// The Trends page hides this tab entirely for age-restricted profiles, so the
// generate form is only ever rendered for eligible profiles.
export async function generateForDate(formData: FormData) {
  const { login, profile } = requireSession();
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
    () => generateInsight(profile.id, date)
  );
  saveInsight(profile.id, date, result);
  revalidatePath("/trends");
  revalidatePath("/");
}

// Pin / unpin a Trends-Overview tile for the active profile (issue #212, Phase 2).
// The pin key ("metric:weight" | "bio:LDL Cholesterol") toggles in the per-profile
// `trend_pins` list; pinned tiles render first on the Overview. profileId is
// resolved from the session — any login acting as the profile may pin (it's
// per-profile data), so this is requireSession, not requireAdmin.
export async function toggleTrendPin(formData: FormData) {
  const { profile } = requireSession();
  const key = String(formData.get("key") ?? "").trim();
  if (!key) return;
  setTrendPins(profile.id, togglePin(getTrendPins(profile.id), key));
  revalidatePath("/trends");
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

// Saved views (issue #212, Phase 3). Save the current hub state under a name for
// the active profile — per-profile data, so requireSession (any login acting as
// the profile may save), not requireAdmin. Re-saving the same name overwrites it.
export async function saveTrendView(formData: FormData) {
  const { profile } = requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const params = paramsFromForm(formData, getTrendPins(profile.id));
  setTrendViews(
    profile.id,
    addView(getTrendViews(profile.id), { name, params })
  );
  revalidatePath("/trends");
}

// Delete a saved view by name.
export async function deleteTrendView(formData: FormData) {
  const { profile } = requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  setTrendViews(profile.id, deleteView(getTrendViews(profile.id), name));
  revalidatePath("/trends");
}

// Apply a saved view: restore its pins snapshot (when it captured one) and redirect
// to the hub with the view's range/tab/compare params — reusing the SAME URL
// vocabulary the DateRangeControl / CompareControls already read. Unknown name is a
// no-op back to /trends.
export async function applyTrendView(formData: FormData) {
  const { profile } = requireSession();
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
