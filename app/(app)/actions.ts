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
import { isRealIsoDate, shiftDateStr } from "@/lib/date";
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
import {
  usualRoutineDayOffers,
  type UsualRoutineDayOffer,
} from "@/lib/queries/usual-routine";
import { LOGGED_VIA_FIELD, parseWebOrigin, type StampedFormData } from "@/lib/logged-via";
import {
  logUsualRoutineCore,
  recordUsualBackfillAudit,
} from "@/lib/usual-routine-write";
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
      // Grams the tap actually wrote (#4379), or null when protein was not part of the
      // bundle that stood at write time — reported, never assumed, like every half.
      protein: number | null;
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

// Dismiss one dashboard attention atom: hide it until it is restored from the
// Upcoming page. Profile-scoped via the shared writer. A flagged-biomarker atom
// posts the analyte acknowledgment key, which since #3225 also ends at the next draw
// of that marker family (lib/queries/upcoming/suppressions.ts).
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
// write outside the bundle that currently stands. The `date` field is optional and
// defaults to today (#4118); its reach is the CORE's bound, not this parse.
export async function logUsualRoutine(
  formData: StampedFormData
): Promise<UsualRoutineResult> {
  const { login, profile } = await requireWriteAccess();
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
  const proteinGrams = Number(formData.get("protein_grams") ?? 0);
  // A SUBMISSION NAMING NOTHING. Shape only, like every field here — the core still
  // decides what may land. The scoop counts as something named (#4379/#4765): a bundle
  // whose food half is the scoop alone posts no slugs, so counting only groups and doses
  // would refuse a tap the offer had legitimately made. Neither web control can build
  // that post today (FoodLogBar's own note carries the reasoning), so this term changes
  // no outcome — it is here so this gate says the same thing about a food half as
  // `usualRoutineOffer` and the two controls do, rather than a fourth thing.
  if (groups.length === 0 && doseIds.length === 0 && !(proteinGrams > 0))
    return { ok: false, error: "Nothing to log." };
  const day = today(profile.id);
  const rawDate = String(formData.get("date") ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : day;
  const outcome = logUsualRoutineCore(
    profile.id,
    rawWindow,
    date,
    groups,
    doseIds,
    // READ, NOT NAMED (#3087). This control is not on the attention card: it is the
    // dashboard's usual-routine atom AND the phone dock's raised puck in the quick-log
    // sheet, one component posting this one action from two regions. A literal here
    // would record `dashboard-hero` for both — the flagship one-tap's food rows and
    // dose rows, on a surface it was never mounted on. The two mountings that reach
    // this each declare their region; `page` is the honest fallback for a third that
    // does not, exactly as it is everywhere else.
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
    undefined,
    // THE SCOOP THE BUTTON PROMISED (#4379). Shape only, like every other field here:
    // the core re-derives whether protein still stands and writes nothing if it does
    // not, so a forged number on a window with no protein habit lands nowhere. What the
    // number itself may be is `addProteinGramsCore`'s own bound.
    proteinGrams > 0 ? proteinGrams : undefined
  );
  if (outcome.kind === "invalid-date")
    return { ok: false, error: "That day is out of range." };
  if (outcome.kind === "nothing-to-log")
    return { ok: false, error: "That's already logged." };
  // A DATED bundle is audited (#4118) — the rule and the row shape live beside the
  // write core so the Telegram surface files the identical one (#4306).
  recordUsualBackfillAudit(login.id, profile.id, outcome, day);
  // The follow-up offer, resolved AFTER the write and only when the bundle actually
  // landed FOOD: confirming a dose is not eating, and prompting "End your fast?" over a
  // dose-only tap would be the app inferring a meal from a medication. The day the write
  // USED, not today — reconstructing Tuesday is not a reason to end today's fast.
  const endFastOffer =
    (outcome.groups.length > 0 || outcome.protein !== null) &&
    promptsEndOfFast(getActiveFastCached(profile.id), outcome.date, day);
  revalidateRoute("/");
  revalidateRoute("/nutrition");
  // THE RECORD, TOO (#4438). The retired food-only spelling revalidated `/history` and
  // this one did not, so once the nutrition bar posts the composed action every surface
  // it used to refresh has to be here or the bundle's servings would land off-screen on
  // the page built for finding gaps.
  revalidateRoute("/history");
  revalidateRoute("/medications");
  revalidateRoute("/upcoming");
  revalidateRoute("/trends");
  return {
    ok: true,
    window: outcome.window,
    groups: outcome.groups,
    doses: outcome.doses,
    protein: outcome.protein,
    ...(endFastOffer ? { endFastOffer: true as const } : {}),
  };
}

// ── WHAT A DATED "usual" TAP WOULD WRITE ON ONE DAY (#4118) ──────────────────
//
// The read half of the dated write, for the `/history` add door, as a Server Action:
// the door's date is a FIELD the reader changes, so the offer cannot be resolved once
// at render and left there — a label is a promise, and a promise about Tuesday shown
// while the field says Thursday is a lie the write core would then refuse.
//
// The derivation itself is `usualRoutineDayOffers` (lib/queries/usual-routine.ts), so
// the page's server render and this re-read are ONE computation and cannot answer
// differently for the same day.
//
// Gated on WRITE access rather than read: this answers "what would a tap write", and
// offering a caregiver-view a control that can only refuse is worse than offering
// nothing (#2458's own rule). A malformed date is an empty answer rather than an error
// — the field is mid-edit half the time.
export async function usualRoutineOffersOn(
  date: string
): Promise<UsualRoutineDayOffer[]> {
  const { profile } = await requireWriteAccess();
  if (!isRealIsoDate(date)) return [];
  return usualRoutineDayOffers(profile.id, date);
}
