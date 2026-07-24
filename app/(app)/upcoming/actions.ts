"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  markDoseTaken,
  snoozeFinding,
  dismissFinding,
  restoreFinding,
  recordPreventiveDone,
  setPreventiveOverride,
  markCarePlanItemDone,
} from "@/lib/queries";
import { snoozeUntil } from "@/lib/upcoming";
import { preventiveRuleByKey } from "@/lib/preventive-catalog";
import { resolveFollowUpCore } from "@/lib/followup-write";
import { formError, formOk, type FormResult } from "@/lib/types";
import { requireSession } from "@/lib/auth";
import { dismissMultiviewHint } from "@/lib/settings";
import { explainFinding } from "@/lib/explain-finding";
import type { Reason } from "@/lib/reasons";

// Resolve the target profile for a per-item write on the (possibly multi-view)
// Upcoming page (issue #1096). Every row carries its OWN profileId — on a multi-view
// page a dose confirmed on Sam's row must write to SAM, not the acting profile — so
// each write form posts `profile_id` and the action gates the ITEM's profile via
// requireProfileWriteAccess (asserts reachable AND write; a read-only-granted or
// ungranted member is bounced). With no `profile_id` (a legacy/single-view form) it
// falls back to the active-profile requireWriteAccess gate — which also keeps the
// write-access scanner satisfied by the literal call it recognizes. Returns the
// gated target profile id; callers derive that member's own today() from it.
async function gateItemProfile(formData: FormData): Promise<number> {
  const pid = Number(formData.get("profile_id"));
  if (pid > 0) {
    await requireProfileWriteAccess(pid);
    return pid;
  }
  const { profile } = await requireWriteAccess();
  return profile.id;
}

// "Why is this flagged?" (issue #878, Phase 1). Narrate a finding's OWN reason payload
// via the Light tier, or fall back to the deterministic structured rendering. Read-only
// (requireSession) — it computes no fact and writes nothing; the reasons come from the
// server-rendered item and are sanitized in explainFinding against the closed union, so
// an echoed payload can't smuggle an unknown code into the prompt.
export type ExplainFindingResult =
  { ok: true; text: string; offline: boolean } | { ok: false; error: string };

export async function explainFindingAction(
  formData: FormData
): Promise<ExplainFindingResult> {
  await requireSession();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Couldn't read that finding." };
  const detail = String(formData.get("detail") ?? "") || null;
  let reasons: Reason[] = [];
  try {
    const parsed = JSON.parse(String(formData.get("reasons") ?? "[]"));
    if (Array.isArray(parsed)) reasons = parsed as Reason[];
  } catch {
    reasons = [];
  }
  const result = await explainFinding({ title, detail, reasons });
  return { ok: true, text: result.text, offline: result.offline };
}

// Inline "mark taken" for a due dose surfaced on the Upcoming page. Reuses the
// idempotent markDoseTaken helper (verifies the dose belongs to this profile via
// its parent supplement, logs it once, and decrements tracked supply) — the same
// path the Telegram callback uses — so a dose confirmed here reflects everywhere.
// Marking-only (never un-marks): a taken dose simply drops off the Upcoming list.
export async function markTaken(formData: FormData): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return formError("Couldn't find that dose.");
  markDoseTaken(pid, doseId, null, today(pid));
  revalidatePath("/upcoming");
  revalidatePath("/nutrition");
  revalidatePath("/medications");
  revalidatePath("/");
  return formOk();
}

// Inline "mark done" for a due preventive visit/screening on the Upcoming page
// (issue #82). Records a satisfaction dated today into the shared stream the pure
// assessor reads — the same fast path as a dose "mark taken" — so the item drops
// off Upcoming (and the assessor advances the next-due). The rule key is validated
// against the static catalog so a tampered form can't write an unknown key.
// Profile-scoped; recordPreventiveDone is idempotent per (rule, date).
export async function markPreventiveDone(
  formData: FormData
): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const ruleKey = String(formData.get("rule_key") ?? "").trim();
  if (!ruleKey || !preventiveRuleByKey(ruleKey))
    return formError("Couldn't find that preventive item.");
  recordPreventiveDone(pid, ruleKey, today(pid));
  revalidatePath("/upcoming");
  revalidatePath("/");
  return formOk();
}

// Inline "mark done" for a provider-ordered care-plan item on the Upcoming page
// (issue #84). Marks the row completed via the profile-scoped writer (WHERE id AND
// profile_id, so a tampered id can't touch another profile's row) — the same fast
// path as a dose "mark taken" — so the item drops off Upcoming and the /care-plan
// page reflects the completion.
export async function markCarePlanDone(
  formData: FormData
): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const id = Number(formData.get("care_plan_item_id"));
  if (!id) return formError("Couldn't find that care-plan item.");
  markCarePlanItemDone(pid, id);
  revalidatePath("/upcoming");
  revalidatePath("/records");
  revalidatePath("/");
  return formOk();
}

// Override a preventive rule as declined (an informed opt-out) or not applicable
// (the anatomy escape hatch). Both drop the item out of the actionable set. The
// kind is whitelisted and the rule key validated against the catalog. Upserts on
// (profile_id, rule_key). Profile-scoped.
export async function overridePreventive(
  formData: FormData
): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const ruleKey = String(formData.get("rule_key") ?? "").trim();
  const kind = String(formData.get("kind") ?? "");
  if (!ruleKey || !preventiveRuleByKey(ruleKey))
    return formError("Couldn't find that preventive item.");
  if (kind !== "declined" && kind !== "not_applicable")
    return formError("Choose an override option.");
  setPreventiveOverride(pid, ruleKey, kind);
  revalidatePath("/upcoming");
  revalidatePath("/");
  return formOk();
}

// Resolve a finding follow-up (#700), confirm-first (#560): record the outcome
// (resolved / stable / changed) against the matched later record and close the
// follow-up. Domain-agnostic — the write core dispatches on the follow-up's
// source_kind (imaging → a later study, labs → a later reading), so this ONE action +
// control serves every adapter. It validates the outcome and re-checks both the
// follow-up and the resolving record under profile_id, so a tampered id can't resolve
// another profile's row. A resolving_study_id of 0/empty records the outcome without
// pinning a record (the field name is legacy — it carries any domain's resolving id).
export async function resolveFollowUp(formData: FormData): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const carePlanItemId = Number(formData.get("care_plan_item_id"));
  const resolution = String(formData.get("resolution") ?? "");
  const resolvingStudyId = Number(formData.get("resolving_study_id")) || null;
  if (!carePlanItemId) return formError("Couldn't find that follow-up.");
  const res = resolveFollowUpCore(
    pid,
    carePlanItemId,
    resolution,
    resolvingStudyId
  );
  if (res.kind === "invalid-resolution")
    return formError("Choose resolved, stable, or changed.");
  if (res.kind === "not-found")
    return formError("Couldn't find that follow-up.");
  revalidatePath("/upcoming");
  revalidatePath("/results");
  revalidatePath("/records");
  revalidatePath("/");
  return formOk();
}

// Dismiss the one-time multi-profile viewing hint on Upcoming (issue #1327 fix 7).
// Login-scoped discoverability, not a per-profile write — so it gates on requireSession
// (any live login may dismiss its OWN hint) and stores the "seen" flag against the
// login, never a profile. Idempotent; revalidates so the banner drops immediately.
export async function dismissMultiviewHintAction(): Promise<FormResult> {
  const { login } = await requireSession();
  dismissMultiviewHint(login.id);
  revalidatePath("/upcoming");
  return formOk();
}

// Snooze a single due-item: hide it until `today + days`, after which it
// reappears. The window is validated + clamped by the shared snoozeUntil helper
// (one source of truth for the snooze policy, shared with the dashboard hero).
// Delegates to the shared findings-suppression writer (upserts on the
// (profile_id, signal_key) index so re-snoozing — or snoozing a previously-
// dismissed item — just moves the date and clears any dismiss). Profile-scoped.
export async function snoozeItem(formData: FormData): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  const until = snoozeUntil(today(pid), Number(formData.get("days")));
  if (!signalKey) return formError("Couldn't find that item.");
  if (until == null) return formError("Choose how long to snooze.");
  snoozeFinding(pid, signalKey, until);
  revalidatePath("/upcoming");
  return formOk();
}

// Dismiss a single due-item: hide it indefinitely until the user restores it.
// Delegates to the shared writer (upserts, clearing any snooze so a dismiss always
// wins). Profile-scoped.
export async function dismissItem(formData: FormData): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return formError("Couldn't find that item.");
  dismissFinding(pid, signalKey);
  revalidatePath("/upcoming");
  return formOk();
}

// Restore a snoozed/dismissed item: drop its suppression row so it reappears on
// Upcoming immediately. Profile-scoped.
export async function restoreItem(formData: FormData): Promise<FormResult> {
  const pid = await gateItemProfile(formData);
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return formError("Couldn't find that item.");
  restoreFinding(pid, signalKey);
  revalidatePath("/upcoming");
  return formOk();
}
