"use server";

import { revalidateRoute } from "@/lib/revalidate";
import {
  getAccessibleProfiles,
  requireSession,
  requireWriteAccess,
} from "@/lib/auth";
import { setIllnessNowUi } from "@/lib/settings";
import { dismissRecentlyResolvedEpisode } from "@/lib/recently-resolved";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { snoozeUntil } from "@/lib/upcoming";
import {
  snoozeFinding,
  dismissFinding,
  markDoseTaken,
  undoDoseConfirm,
  acknowledgeRestToday,
} from "@/lib/queries";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import type {
  DoseConfirmResult,
  DoseUndoResult,
} from "@/lib/dose-outcome-text";
import { isFoodSlot, type FoodSlot } from "@/lib/food-slot";
import { logUsualRoutineCore } from "@/lib/usual-routine-write";
import { getActiveFastCached } from "@/lib/queries/fasting";
import { promptsEndOfFast } from "@/lib/fasting";
import type { UsualFoodLogged } from "@/lib/food-usual-write";
import type { UsualRoutineDoseResult } from "@/lib/usual-routine-write";

// The composed tap's answer. Both halves are reported SEPARATELY and unflattened: the
// surface must be able to say "logged fermented and berries, creatine already logged"
// rather than a count, because the composed answer may never claim more than was
// written (#2458). `groups` carries the server's authoritative per-group counters, the
// same pair a single serving tap answers with.
export type UsualRoutineResult =
  | {
      ok: true;
      window: FoodSlot;
      groups: UsualFoodLogged[];
      doses: UsualRoutineDoseResult[];
      // ONE "End your fast?" offer for the whole bundle (#2756) — a bundled write
      // prompts ONCE, however many servings and doses it landed. The offer itself
      // stands down while a fast is active (#2757), so this is reachable only from a
      // page that went stale across a start; the log still lands either way, because
      // #2419's line is that the OFFER stands down and the LOGGING never does.
      //
      // The DOSES in the bundle are untouched by any of this. Nothing here declines to
      // confirm a dose, and no fast can suppress a dose reminder — that reach is a
      // closed one-kind allowlist in lib/fasting-standdown.ts.
      endFastOffer?: true;
    }
  | { ok: false; error: string };

// Persist the acting profile's illness Now-group collapse/expand state (issue #858): whether
// its own cockpit is collapsed to the one-line headline and which OTHER accessible
// profile's accordion is expanded. It is gated on the active profile's write access
// and stored under it. No
// revalidation — the client already reflects the toggle; this only survives a reload.
export async function saveIllnessNowState(
  collapsedActive: boolean,
  openOtherKey: string | null
) {
  const { profile } = await requireWriteAccess();
  setIllnessNowUi(profile.id, {
    collapsedActive: collapsedActive === true,
    openOtherKey:
      typeof openOtherKey === "string" && openOtherKey.length > 0
        ? openOtherKey
        : null,
  });
}

// Persist the VIEWER's hide of one "Recently resolved — reopen?" line (issue #1548),
// so the X stops resurrecting on reload for the rest of the episode's 7-day window.
//
// Gated on requireSession, NOT requireWriteAccess: this writes only to the acting
// LOGIN's own settings row (a per-login viewer preference), so a read-only caregiver is still entitled to tidy
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
// Revalidates "/" so the server placement model drops the dismissed reopen fact and
// re-evaluates the remaining typed illness context from fresh state.
export async function dismissRecentlyResolved(episodeId: number) {
  const { login } = await requireSession();
  const accessible = await getAccessibleProfiles();
  dismissRecentlyResolvedEpisode(
    login.id,
    accessible.map((p) => p.id),
    typeof episodeId === "number" ? episodeId : Number(episodeId)
  );
  revalidateRoute("/");
}

// "Snooze" on the dashboard coaching atom (findings bus, #39; renamed from "Not
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
  revalidateRoute("/");
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
  revalidateRoute("/");
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
  revalidateRoute("/");
}

// The Data quality atom's dismiss (#1045/#1219 nit): TODAY it shares the
// coaching-observation core above — the `data-quality:` keys ride the same bus and
// pass the same prefix guard — but the two atoms get distinct named actions so
// they can diverge safely (a data-quality-only behavior change must never silently
// alter the coaching rollup's dismiss, and vice versa). Same gate: requireWriteAccess
// inside the delegate.
export async function dismissDataQualityGap(formData: FormData) {
  await dismissCoachingObservation(formData);
}

// Snooze one dashboard attention atom: hide it (via the shared findings
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
  revalidateRoute("/");
  revalidateRoute("/upcoming");
}

// Dismiss one dashboard attention atom: hide it indefinitely (until restored
// from the Upcoming page). Profile-scoped via the shared writer.
export async function dismissAttention(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return;
  dismissFinding(profile.id, signalKey);
  revalidateRoute("/");
  revalidateRoute("/upcoming");
}

// Inline "mark taken" for a due dose surfaced by dashboard placement. Reuses the idempotent
// markDoseTaken (verifies the dose belongs to this profile via its parent
// supplement) — the same path the Upcoming page and Telegram callback use — so a
// dose confirmed here drops off the dashboard and reflects everywhere. Profile-scoped.
//
// The result CARRIES the typed outcome (#2106): the dose-status affordance declares
// `outcome-toast`, and this action had been dropping the outcome — a stale dashboard tab's
// tap on a paused item or a retired dose logged nothing and the row just silently
// re-rendered, indistinguishable from a lost tap. The dashboard atom renders every
// branch through doseConfirmMessage.
export async function markAttentionDose(
  formData: FormData
): Promise<DoseConfirmResult> {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return { ok: false, error: "Couldn't find that dose." };
  const outcome = markDoseTaken(
    profile.id,
    doseId,
    null,
    today(profile.id),
    // The attention card's act-now confirm (#3087).
    "dashboard-hero"
  );
  revalidateRoute("/");
  revalidateRoute("/upcoming");
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  return { ok: true, outcome };
}

// Take back the dashboard atom's "Mark taken" (#2642) — the inverse behind its Undo toast. Same
// gate as the confirm (the acting profile's write access), same revalidation, and the
// same discipline about answering: `undoDoseConfirm` re-derives whether this tap's row is
// still the only thing standing for the day and refuses otherwise, and the button renders
// that typed outcome rather than claiming the confirm came back.
//
// Nothing left the machine on the way in — a dashboard confirm sends no message — so the
// inverse is complete and local: the row goes, the supply it consumed is handed back, and
// the dose is due again, which is precisely the state not tapping would have left.
export async function undoAttentionDose(
  formData: FormData
): Promise<DoseUndoResult> {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return { ok: false, error: "Couldn't find that dose." };
  const outcome = undoDoseConfirm(
    profile.id,
    doseId,
    today(profile.id),
    "dashboard-hero"
  );
  revalidateRoute("/");
  revalidateRoute("/upcoming");
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  return { ok: true, outcome };
}

// The composed "your usual <window>" tap (#2458): one serving of each still-offered
// habitual group PLUS a confirm for each still-pending dose the profile declared in
// that window. The morning is one physical event; this is its one tap.
//
// The user's tap is the write — the app never logs food or a dose on anyone's behalf
// — and the control that raised this named every group and every dose below.
//
// The action validates SHAPE only. WHICH groups and WHICH doses may land is the
// core's question, and it re-derives BOTH halves from fresh server state rather than
// trusting this form, so a forged, replayed or simply stale submission can never
// write outside the bundle that currently stands. There is no `date` field: the core
// resolves the profile's own today, so this path cannot backfill.
export async function logUsualRoutine(
  formData: FormData
): Promise<UsualRoutineResult> {
  const { profile } = await requireWriteAccess();
  const rawWindow = String(formData.get("meal_slot") ?? "").trim();
  if (!isFoodSlot(rawWindow))
    return { ok: false, error: "Unknown meal window." };
  const groups = String(formData.get("groups") ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  const doseIds = String(formData.get("dose_ids") ?? "")
    .split(",")
    .map((raw) => Number(raw.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (groups.length === 0 && doseIds.length === 0)
    return { ok: false, error: "Nothing to log." };
  const outcome = logUsualRoutineCore(
    profile.id,
    rawWindow,
    groups,
    doseIds,
    "dashboard-hero"
  );
  if (outcome.kind === "nothing-to-log")
    return { ok: false, error: "That's already logged." };
  // The follow-up offer, resolved AFTER the write and only when the bundle actually
  // landed FOOD: confirming a dose is not eating, and prompting "End your fast?" over a
  // dose-only tap would be the app inferring a meal from a medication.
  const day = today(profile.id);
  const endFastOffer =
    outcome.groups.length > 0 &&
    promptsEndOfFast(getActiveFastCached(profile.id), day, day);
  revalidateRoute("/");
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  revalidateRoute("/upcoming");
  revalidateRoute("/trends");
  return {
    ok: true,
    window: outcome.window,
    groups: outcome.groups,
    doses: outcome.doses,
    ...(endFastOffer ? { endFastOffer: true as const } : {}),
  };
}
