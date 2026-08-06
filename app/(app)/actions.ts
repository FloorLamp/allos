"use server";

import { revalidatePath } from "next/cache";
import {
  getAccessibleProfiles,
  requireSession,
  requireWriteAccess,
} from "@/lib/auth";
import {
  setAttentionHeroCollapsed,
  setDashboardLayout,
  setIllnessHeroUi,
} from "@/lib/settings";
import { dismissRecentlyResolvedEpisode } from "@/lib/recently-resolved";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { snoozeUntil } from "@/lib/upcoming";
import {
  snoozeFinding,
  dismissFinding,
  markDoseTaken,
  acknowledgeRestToday,
} from "@/lib/queries";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import type { DoseConfirmResult } from "@/lib/dose-outcome-text";

// Persist the active profile's dashboard customization: the widget
// display order and the set of hidden widget ids. Profile-scoped like the other
// per-profile settings; the layout is merged defensively against the registry on
// read, so ids aren't validated here.
export async function saveDashboardLayout(order: string[], hidden: string[]) {
  const { profile } = await requireWriteAccess();
  setDashboardLayout(profile.id, { order, hidden });
  revalidatePath("/");
}

// Persist the acting profile's illness-hero collapse/expand state (issue #858): whether
// its own cockpit is collapsed to the one-line headline and which OTHER accessible
// profile's accordion is expanded. A per-viewer UI preference (like the dashboard
// layout), so it's gated on the active profile's write access and stored under it. No
// revalidation — the client already reflects the toggle; this only survives a reload.
export async function saveIllnessHeroState(
  collapsedActive: boolean,
  openOtherId: number | null
) {
  const { profile } = await requireWriteAccess();
  setIllnessHeroUi(profile.id, {
    collapsedActive: collapsedActive === true,
    openOtherId: typeof openOtherId === "number" ? openOtherId : null,
  });
}

// Persist the VIEWER's "Needs attention" hero collapse preference (issue #1413,
// section B). Per-login, so it follows the reader across profile switches.
//
// Gated on requireSession, NOT requireWriteAccess: this writes only to the acting
// LOGIN's own settings row, so a read-only viewer of someone else's profile is
// still entitled to choose how tall the hero is on their own screen. No
// revalidation — the client already reflects the toggle; this only makes it
// survive a reload.
//
// This can never hide the hero or its count (#449): the stored flag is one input
// to attentionHeroState, which ignores it entirely for a safety-locked hero.
export async function saveAttentionHeroCollapsed(collapsed: boolean) {
  const { login } = await requireSession();
  setAttentionHeroCollapsed(login.id, collapsed === true);
}

// Persist the VIEWER's hide of one "Recently resolved — reopen?" line (issue #1548),
// so the X stops resurrecting on reload for the rest of the episode's 7-day window.
//
// Gated on requireSession, NOT requireWriteAccess, for the same reason as
// saveAttentionHeroCollapsed: this writes only to the acting LOGIN's own settings row
// (a per-login viewer preference), so a read-only caregiver is still entitled to tidy
// their own dashboard. It grants no reach in the other direction either — the hide is
// per-login, so a co-caregiver's copy of the line is untouched.
//
// AUTHORIZATION OF THE ID lives here, at the request boundary: the login's accessible
// profiles are resolved and handed to the auth-blind write core, which refuses any
// episode id outside that set's currently-reopen-eligible ids. So a tampered payload
// can neither name a stranger's episode nor pad the stored list. The refusal is a
// silent no-op by design — the action is idempotent and the caller has already hidden
// the row optimistically; there is nothing for a viewer to correct.
//
// Revalidates "/": unlike the collapse preference, the dismissal changes WHICH server-
// rendered band the dashboard's household-history promo link belongs to (#1549), so
// the page must re-render rather than trust the client's optimistic hide.
export async function dismissRecentlyResolved(episodeId: number) {
  const { login } = await requireSession();
  const accessible = await getAccessibleProfiles();
  dismissRecentlyResolvedEpisode(
    login.id,
    accessible.map((p) => p.id),
    typeof episodeId === "number" ? episodeId : Number(episodeId)
  );
  revalidatePath("/");
}

// "Snooze" on the dashboard Coaching widget (findings bus, #39; renamed from "Not
// today" in #1150 so it doesn't read as a "I'll rest" stance next to "Training
// anyway"): snooze the top recommendation until tomorrow through the shared
// suppression store, so the next-ranked recommendation surfaces for the rest of the
// day. Applies to ALL coaching rec types (train/cardio/rest). Guarded to the coaching
// namespace so a tampered form can't snooze an arbitrary finding key. Profile-scoped
// via snoozeFinding.
export async function snoozeCoaching(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith("coaching:")) return;
  snoozeFinding(profile.id, dedupeKey, shiftDateStr(today(profile.id), 1));
  revalidatePath("/");
}

// The rest-nudge reason ids the "Training anyway" acknowledgment may carry — a tampered
// form can't inject arbitrary reason strings into the stored marker.
const REST_REASON_IDS = new Set([
  "rest-sleep",
  "rest-rhr",
  "rest-overtraining",
  "rest-load",
]);

// "Training anyway" on the dashboard Coaching rest card (#1150): a DECLARATION OF
// INTENT ("I'm training despite this"), the opposite of the snooze dismissal — it
// records a per-day acknowledgment (DISTINCT from the #39 snooze store; it never
// touches upcoming_dismissals), and the card transforms in place into calm
// recovery-aware training guidance instead of hiding. Today-only: a still-firing signal
// returns tomorrow, so it can't bury a persisting signal for good. Profile-scoped via
// acknowledgeRestToday. The submitted reason ids are the firing signals shown on the
// card, validated against the known rest ids.
export async function acknowledgeRest(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const reasonIds = String(formData.get("reason_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => REST_REASON_IDS.has(s));
  acknowledgeRestToday(profile.id, reasonIds);
  revalidatePath("/");
}

// Dismiss a coaching observation from the dashboard rollup (issue #449). The rollup
// aggregates all four #45 observational domains, so it guards the WHOLE rule-findings
// prefix registry (dedupeKeyHasKnownPrefix) rather than a single namespace, then
// writes to the SAME shared suppression store the origin tabs use — so a dashboard
// dismiss silences the finding on its tab too ("dismiss once, silence everywhere").
// Profile-scoped via dismissFinding.
export async function dismissCoachingObservation(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKeyHasKnownPrefix(dedupeKey)) return;
  dismissFinding(profile.id, dedupeKey);
  revalidatePath("/");
}

// The Data quality widget's dismiss (#1045/#1219 nit): TODAY it shares the
// coaching-observation core above — the `data-quality:` keys ride the same bus and
// pass the same prefix guard — but the two widgets get distinct named actions so
// they can diverge safely (a data-quality-only behavior change must never silently
// alter the coaching rollup's dismiss, and vice versa). Same gate: requireWriteAccess
// inside the delegate.
export async function dismissDataQualityGap(formData: FormData) {
  await dismissCoachingObservation(formData);
}

// Snooze one attention item from the hero: hide it (via the shared findings
// suppression store) until today + `days`, after which it reappears — matching the
// Upcoming page's snooze exactly (same key, same store, same snoozeUntil clamp), so
// a snooze here also silences the Telegram digest/push and the Upcoming list.
// Profile-scoped.
export async function snoozeAttention(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  const until = snoozeUntil(today(profile.id), Number(formData.get("days")));
  if (!signalKey || until == null) return;
  snoozeFinding(profile.id, signalKey, until);
  revalidatePath("/");
  revalidatePath("/upcoming");
}

// Dismiss one attention item from the hero: hide it indefinitely (until restored
// from the Upcoming page). Profile-scoped via the shared writer.
export async function dismissAttention(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return;
  dismissFinding(profile.id, signalKey);
  revalidatePath("/");
  revalidatePath("/upcoming");
}

// Inline "mark taken" for a due dose surfaced on the hero. Reuses the idempotent
// markDoseTaken (verifies the dose belongs to this profile via its parent
// supplement) — the same path the Upcoming page and Telegram callback use — so a
// dose confirmed here drops off the hero and reflects everywhere. Profile-scoped.
//
// The result CARRIES the typed outcome (#2106): the dose-status affordance declares
// `outcome-toast`, and this action had been dropping the outcome — a stale hero tab's
// tap on a paused item or a retired dose logged nothing and the row just silently
// re-rendered, indistinguishable from a lost tap. The hero's button renders every
// branch through doseConfirmMessage.
export async function markAttentionDose(
  formData: FormData
): Promise<DoseConfirmResult> {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return { ok: false, error: "Couldn't find that dose." };
  const outcome = markDoseTaken(profile.id, doseId, null, today(profile.id));
  revalidatePath("/");
  revalidatePath("/upcoming");
  revalidatePath("/nutrition");
  revalidatePath("/medications");
  return { ok: true, outcome };
}
