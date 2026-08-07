"use server";
import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { deleteProfileSetting } from "@/lib/settings";
import {
  stopMedicationCourses,
  restartMedicationCourse,
  insertMedicationSideEffect,
  updateMedicationSideEffect,
  setMedicationSideEffectResolved,
  deleteMedicationSideEffect,
  promoteMedicationSideEffect,
  logAdministration,
  dismissFinding,
  restoreFinding,
  refillSupply,
  linkMedPrescriber,
  declineMedPrescriber,
  linkMedIndication,
  declineMedIndication,
} from "@/lib/queries";
import { DORMANT_PRN_PREFIX } from "@/lib/dormant-prn";
import { createMedicationShareLink } from "@/lib/share-links-db";
import { expiresAtFor } from "@/lib/share-links";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { getTimezone } from "@/lib/settings";
import { isRealIsoDate, zonedWallTimeToUtc } from "@/lib/date";
import {
  normalizeStopReason,
  normalizeSeverity,
} from "@/lib/medication-history";
import { leftRefillTrackedSet, refillMarkerKey } from "@/lib/refill-nudge";
import { formError, formOk, type FormResult } from "@/lib/types";
import { strOrNull } from "@/lib/parse";

export type MedicationAdministrationResult =
  { ok: true; outcome: "logged" | "duplicate" } | { ok: false; error: string };

// Medication-lifecycle write paths (#746): stop / restart / side effects for the
// standalone Medications page. Split out of the former combined /medicine action
// module — every action here shares the ONE auth tier (requireWriteAccess), so the
// #319 write-access scanner sees a uniform gate. The shared dose/item CRUD
// (add/update/toggle/delete an intake_item, dose check-offs) stays kind-agnostic in
// app/(app)/nutrition/supplement-actions.ts and is imported by the Medication card
// too. These are thin session wrappers over the profile-scoped lib/queries helpers,
// which own the transactions + ownership checks.

// Stop a medication: close its open course (reason + note) and clear `active`;
// optionally capture a side effect at stop time. The course core returns a typed,
// changes-checked outcome (#2132) and this action RENDERS it — an already-stopped med
// or a forged id refuses instead of confirming a write that no-oped.
export async function stopMedication(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that medication.");
  const before = db
    .prepare(
      "SELECT active, quantity_on_hand FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as
    { active: number; quantity_on_hand: number | null } | undefined;
  const outcome = stopMedicationCourses(profile.id, id, {
    date: today(profile.id),
    reason: normalizeStopReason(formData.get("stop_reason")),
    note: strOrNull(formData.get("note")),
    effect: strOrNull(formData.get("effect")),
    severity: normalizeSeverity(formData.get("severity")),
  });
  if (outcome === "not-found") {
    return formError("Couldn't find that medication.");
  }
  if (outcome === "already-stopped") {
    return formError("Already stopped — nothing changed.");
  }
  // Stopping a tracked medication clears `active`, removing it from the refill-nudge
  // tracked set — so drop its low-supply episode marker, exactly as Pause does
  // (`setItemActive`), so a Restart while still low re-fires a fresh nudge instead of
  // being silenced by a stale marker (issue #325 parity: Stop/Restart mirrors
  // Pause/Resume).
  if (
    before &&
    leftRefillTrackedSet(
      { active: !!before.active, quantityOnHand: before.quantity_on_hand },
      { active: false, quantityOnHand: before.quantity_on_hand }
    )
  ) {
    deleteProfileSetting(profile.id, refillMarkerKey(id));
  }
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

// Restart a medication: open a NEW course dated today and set `active` back on.
// Renders the course core's typed outcome (#2132): a stale tab's second Restart on an
// already-open course refuses rather than silently confirming.
export async function restartMedication(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that medication.");
  const outcome = restartMedicationCourse(profile.id, id, today(profile.id));
  if (outcome === "not-found") {
    return formError("Couldn't find that medication.");
  }
  if (outcome === "already-open") {
    return formError("Already active — nothing changed.");
  }
  // Restart re-activates the med, putting a refill-tracked one back INTO the nudge
  // set — the enter-side twin of Stop's leave-side clear above. `leftRefillTrackedSet`
  // only fires on a LEAVE, so drop any lingering low-supply marker here directly, so a
  // med that still sits under threshold re-fires a fresh nudge (a stale marker whose
  // item is a candidate again isn't reached by the tick's self-healing sweep — #325).
  deleteProfileSetting(profile.id, refillMarkerKey(id));
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

export async function addSideEffect(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id")); // the medication (item) id
  const effect = strOrNull(formData.get("effect"));
  if (!id) return formError("Couldn't find that medication.");
  if (!effect) return formError("Enter the side effect.");
  const notedRaw = strOrNull(formData.get("noted_on"));
  const courseRaw = Number(formData.get("course_id"));
  insertMedicationSideEffect(profile.id, id, {
    effect,
    severity: normalizeSeverity(formData.get("severity")),
    notedOn: notedRaw && isRealIsoDate(notedRaw) ? notedRaw : today(profile.id),
    notes: strOrNull(formData.get("notes")),
    courseId: courseRaw > 0 ? courseRaw : null,
  });
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

export async function updateSideEffect(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const effect = strOrNull(formData.get("effect"));
  if (!id) return formError("Couldn't find that side effect.");
  if (!effect) return formError("Enter the side effect.");
  const notedRaw = strOrNull(formData.get("noted_on"));
  updateMedicationSideEffect(profile.id, id, {
    effect,
    severity: normalizeSeverity(formData.get("severity")),
    notedOn: notedRaw && isRealIsoDate(notedRaw) ? notedRaw : null,
    notes: strOrNull(formData.get("notes")),
    resolved:
      formData.get("resolved") === "1" || formData.get("resolved") === "on"
        ? 1
        : 0,
  });
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

// Set a side effect's resolved state to the INTENDED value the card rendered
// ("Mark resolved" posts 1, "Reopen" posts 0) — never a blind toggle, so a stale tab's
// tap refuses with the state that already holds instead of inverting it (#2133).
export async function setSideEffectResolved(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const toRaw = String(formData.get("to") ?? "");
  if (!id || (toRaw !== "0" && toRaw !== "1")) {
    return formError("Couldn't find that side effect.");
  }
  const outcome = setMedicationSideEffectResolved(
    profile.id,
    id,
    toRaw === "1" ? 1 : 0
  );
  switch (outcome) {
    case "not-found":
      return formError("Couldn't find that side effect.");
    case "already-resolved":
      return formError("Already marked resolved — nothing changed.");
    case "already-open":
      return formError("Already reopened — nothing changed.");
    default:
      revalidatePath("/medications");
      revalidatePath("/");
      return formOk();
  }
}

export async function deleteSideEffect(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that side effect.");
  deleteMedicationSideEffect(profile.id, id);
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

// Resolve the quick-log offset the widget submits into the real intake time to
// store: "now" → undefined (the core stamps now); "custom" → an HH:MM wall time
// TODAY in the profile's timezone, converted to the absolute instant. "invalid"
// signals a malformed custom time. The relative "30m"/"1h" offsets retired with
// #2236 — the widget states absolute times through the shared WhenControl, so the
// wire carries only what a user actually said. The far-off/future guard itself
// lives in the auth-blind core (isGivenAtAccepted, #614) so it covers the Telegram
// path too; this only shapes the offset into a Date.
function resolveGivenAt(
  profileId: number,
  offset: string,
  time: string | null
): Date | undefined | "invalid" {
  switch (offset) {
    case "custom": {
      if (!time) return "invalid";
      // The shape check IS the helper's refusal (#2245): it reads a real wall clock
      // or returns null, so an unreadable offset is "invalid" rather than midnight.
      return (
        zonedWallTimeToUtc(getTimezone(profileId), today(profileId), time) ??
        "invalid"
      );
    }
    case "now":
    default:
      return undefined;
  }
}

// Log one PRN (as-needed) administration from the dashboard quick-log widget (#797).
// The auth gate + offset parsing live here; the write core (logAdministration) is
// auth-blind and shared with the Telegram /dose path, so "gave it now / at 4:02pm"
// is one computation. The result preserves whether the write was
// fresh or deduplicated so every caller can give honest feedback; the updated
// count/last-time still surface through revalidation.
export async function logMedicationAdministration(
  formData: FormData
): Promise<MedicationAdministrationResult> {
  // Cross-profile gating (issue #858): the illness-hero cockpit logs a PRN dose for a
  // household member without switching — an explicit `profileId` gates on the TARGET via
  // requireProfileWriteAccess (the #31 cross-profile gate); absent, the active profile is
  // used (requireWriteAccess). The dashboard/medications mounts send no profileId.
  const target = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(target) && target > 0) {
    await requireProfileWriteAccess(target);
    profileId = target;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that medication.");
  const given = resolveGivenAt(
    profileId,
    String(formData.get("offset") ?? "now"),
    strOrNull(formData.get("time"))
  );
  if (given === "invalid") return formError("Enter a valid time.");
  const outcome = logAdministration(profileId, id, given);
  revalidatePath("/medications");
  revalidatePath("/nutrition");
  revalidatePath("/");
  switch (outcome.kind) {
    case "logged":
    case "duplicate":
      return { ok: true, outcome: outcome.kind };
    case "invalid-time":
      return formError("That time is out of range — pick a time today.");
    case "inactive":
      return formError("This medication is paused — resume it to log a dose.");
    case "stale-item":
    default:
      return formError("Couldn't log that — it may have been removed.");
  }
}

// Dismiss a dormant-PRN sweep suggestion (issue #880 item 3, #203 id-keyed hygiene):
// silence one "no doses in 90+ days" card through the shared findings-suppression bus.
// Guarded to the dormant-prn namespace so it can only ever silence one of those keys. The
// key is `dormant-prn:<itemId>`; integer ids never recycle, so it can't mis-suppress a
// later med.
export async function dismissDormantPrn(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith(DORMANT_PRN_PREFIX)) {
    return formError("Couldn't dismiss that suggestion.");
  }
  dismissFinding(profile.id, dedupeKey);
  revalidatePath("/medications");
  return formOk();
}

// Restore a dismissed dormant-PRN suggestion (the undoable-delete spirit, suggest-only).
// Guarded to the dormant-prn namespace.
export async function restoreDormantPrn(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith(DORMANT_PRN_PREFIX)) {
    return formError("Couldn't restore that suggestion.");
  }
  restoreFinding(profile.id, dedupeKey);
  revalidatePath("/medications");
  return formOk();
}

export type MedShareResult =
  { ok: true; path: string } | { ok: false; error: string };

// Mint a tokenized current-medication-list share link (#852 item 4), the #801
// episode-summary precedent applied to the med list. Returns the one-time /share path;
// the raw token is never stored (only its hash). requireWriteAccess gates it; the link
// is audited by its id (never the token). The med list IS the shared content by design
// here (owner opted in), served through the same token-auth + public-path allowlist.
export async function createMedicationShareLinkAction(
  formData: FormData
): Promise<MedShareResult> {
  const { login, profile } = await requireWriteAccess();
  const ttl = String(formData.get("ttl") ?? "");
  const expiresAt = expiresAtFor(ttl, new Date());
  const { id: linkId, token } = createMedicationShareLink(
    profile.id,
    login.id,
    expiresAt
  );
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.shareLinkCreate,
    target: String(linkId),
  });
  revalidatePath("/medications");
  return { ok: true, path: `/share/${token}` };
}

// One-tap "Refilled" (#852 item 3): add a fill's worth of units back to a med's on-hand
// supply and remember the fill size for next time. The auth gate lives here; the
// auth-blind core (refillSupply) does the compare-and-set increment under the write lock
// so a concurrent dose decrement isn't clobbered (#467). `fill_size` is optional — the
// remembered last-fill size is used when it's absent (the one-tap case). A successful
// refill clears the low-supply episode marker so a later drop re-fires a fresh nudge
// (issue #325 parity with restart).
//
// The success arm carries the core's own numbers back (#1893): a refill is ADDITIVE, so
// the affordance needs to know what THIS tap added in order to say "Refilled just now
// (+90)" for a short window — the #798 informational treatment for an accidental
// double-tap. Plain serializable fields, never the better-sqlite3 row.
export type RefillActionResult =
  | { ok: true; fillSize: number; newQuantity: number }
  | { ok: false; error: string };

export async function refillMedication(
  formData: FormData
): Promise<RefillActionResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that medication.");
  const raw = formData.get("fill_size");
  const hasFill = raw != null && String(raw).trim() !== "";
  const fillSize = hasFill ? Number(raw) : null;
  if (fillSize != null && (!Number.isFinite(fillSize) || fillSize <= 0)) {
    return formError("Enter a valid fill size.");
  }
  const outcome = refillSupply(profile.id, id, fillSize);
  switch (outcome.kind) {
    case "refilled":
      deleteProfileSetting(profile.id, refillMarkerKey(id));
      revalidatePath("/medications");
      revalidatePath("/nutrition");
      revalidatePath("/");
      return {
        ok: true,
        fillSize: outcome.fillSize,
        newQuantity: outcome.newQuantity,
      };
    case "needs-size":
      return formError("How many units did you refill? Enter the fill size.");
    case "untracked":
      return formError("Turn on refill tracking to record a refill.");
    case "stale-item":
    default:
      return formError(
        "Couldn't record that refill — it may have been removed."
      );
  }
}

// Promote a medication side effect into a manual allergies/intolerance row.
// The side effect is kept (marked resolved) for the medication's history.
export async function promoteSideEffectToIntolerance(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that side effect.");
  promoteMedicationSideEffect(profile.id, id, today(profile.id));
  revalidatePath("/medications");
  revalidatePath("/records");
  revalidatePath("/");
  return formOk();
}

// ── Medication-link suggest-and-accept (#1051 med↔prescriber, #1052 med↔indication) ──
// Each accepts/declines ONE proposed link the read-time engines surfaced. The write
// cores (lib/queries/med-links) verify ownership + entity type and remember the
// decision in med_link_decisions so a decline stops re-proposing and an accept
// survives a reprocess. Never unconditionally confirms — the cores return a boolean.

// Accept a prescriber near-miss suggestion: link the med to the existing INDIVIDUAL
// provider (#1051). No-op (friendly) when the med/provider aren't valid.
export async function acceptPrescriberLink(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const medId = Number(formData.get("med_id"));
  const providerId = Number(formData.get("provider_id"));
  if (!medId || !providerId) return formError("Couldn't read that suggestion.");
  const ok = linkMedPrescriber(profile.id, medId, providerId);
  if (!ok) return formError("Couldn't link that prescriber.");
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

// Decline a prescriber suggestion: remembered so the gap detector stops proposing it.
export async function declinePrescriberLink(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const medId = Number(formData.get("med_id"));
  const providerId = Number(formData.get("provider_id"));
  if (!medId || !providerId) return formError("Couldn't read that suggestion.");
  declineMedPrescriber(profile.id, medId, providerId);
  revalidatePath("/medications");
  return formOk();
}

// Accept an indication suggestion (or a manual pick): link the med to the condition
// (#1052). No-op (friendly) when the med/condition aren't valid.
export async function acceptIndicationLink(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const medId = Number(formData.get("med_id"));
  const conditionId = Number(formData.get("condition_id"));
  if (!medId || !conditionId)
    return formError("Couldn't read that suggestion.");
  const ok = linkMedIndication(profile.id, medId, conditionId);
  if (!ok) return formError("Couldn't link that condition.");
  revalidatePath("/medications");
  revalidatePath("/records");
  revalidatePath("/");
  return formOk();
}

// Decline an indication suggestion: remembered so it's never re-suggested.
export async function declineIndicationLink(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const medId = Number(formData.get("med_id"));
  const conditionId = Number(formData.get("condition_id"));
  if (!medId || !conditionId)
    return formError("Couldn't read that suggestion.");
  declineMedIndication(profile.id, medId, conditionId);
  revalidatePath("/medications");
  return formOk();
}
