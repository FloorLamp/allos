"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  markDoseTaken,
  snoozeFinding,
  dismissFinding,
  restoreFinding,
  recordPreventiveDone,
  setPreventiveOverride,
} from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";
import { preventiveRuleByKey } from "@/lib/preventive-catalog";

// Inline "mark taken" for a due dose surfaced on the Upcoming page. Reuses the
// idempotent markDoseTaken helper (verifies the dose belongs to this profile via
// its parent supplement, logs it once, and decrements tracked supply) — the same
// path the Telegram callback uses — so a dose confirmed here reflects everywhere.
// Marking-only (never un-marks): a taken dose simply drops off the Upcoming list.
export async function markTaken(formData: FormData) {
  const { profile } = requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return;
  markDoseTaken(profile.id, doseId, null, today(profile.id));
  revalidatePath("/upcoming");
  revalidatePath("/medicine");
  revalidatePath("/");
}

// Inline "mark done" for a due preventive visit/screening on the Upcoming page
// (issue #82). Records a satisfaction dated today into the shared stream the pure
// assessor reads — the same fast path as a dose "mark taken" — so the item drops
// off Upcoming (and the assessor advances the next-due). The rule key is validated
// against the static catalog so a tampered form can't write an unknown key.
// Profile-scoped; recordPreventiveDone is idempotent per (rule, date).
export async function markPreventiveDone(formData: FormData) {
  const { profile } = requireWriteAccess();
  const ruleKey = String(formData.get("rule_key") ?? "").trim();
  if (!ruleKey || !preventiveRuleByKey(ruleKey)) return;
  recordPreventiveDone(profile.id, ruleKey, today(profile.id));
  revalidatePath("/upcoming");
  revalidatePath("/");
}

// Override a preventive rule as declined (an informed opt-out) or not applicable
// (the anatomy escape hatch). Both drop the item out of the actionable set. The
// kind is whitelisted and the rule key validated against the catalog. Upserts on
// (profile_id, rule_key). Profile-scoped.
export async function overridePreventive(formData: FormData) {
  const { profile } = requireWriteAccess();
  const ruleKey = String(formData.get("rule_key") ?? "").trim();
  const kind = String(formData.get("kind") ?? "");
  if (!ruleKey || !preventiveRuleByKey(ruleKey)) return;
  if (kind !== "declined" && kind !== "not_applicable") return;
  setPreventiveOverride(profile.id, ruleKey, kind);
  revalidatePath("/upcoming");
  revalidatePath("/");
}

// Quick-snooze durations (days) the Upcoming UI offers per item. Clamped in the
// action so a tampered form can't set an absurd window.
const SNOOZE_MAX_DAYS = 3650;

// Snooze a single due-item: hide it until `today + days`, after which it
// reappears. Delegates to the shared findings-suppression writer (upserts on the
// (profile_id, signal_key) index so re-snoozing — or snoozing a previously-
// dismissed item — just moves the date and clears any dismiss). Profile-scoped.
export async function snoozeItem(formData: FormData) {
  const { profile } = requireWriteAccess();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  const days = Number(formData.get("days"));
  if (!signalKey || !Number.isFinite(days) || days < 1) return;
  const until = shiftDateStr(
    today(profile.id),
    Math.min(Math.floor(days), SNOOZE_MAX_DAYS)
  );
  snoozeFinding(profile.id, signalKey, until);
  revalidatePath("/upcoming");
}

// Dismiss a single due-item: hide it indefinitely until the user restores it.
// Delegates to the shared writer (upserts, clearing any snooze so a dismiss always
// wins). Profile-scoped.
export async function dismissItem(formData: FormData) {
  const { profile } = requireWriteAccess();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return;
  dismissFinding(profile.id, signalKey);
  revalidatePath("/upcoming");
}

// Restore a snoozed/dismissed item: drop its suppression row so it reappears on
// Upcoming immediately. Profile-scoped.
export async function restoreItem(formData: FormData) {
  const { profile } = requireWriteAccess();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return;
  restoreFinding(profile.id, signalKey);
  revalidatePath("/upcoming");
}
