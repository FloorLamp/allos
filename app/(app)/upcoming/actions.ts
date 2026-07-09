"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { db, today } from "@/lib/db";
import { markDoseTaken } from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";

// Inline "mark taken" for a due dose surfaced on the Upcoming page. Reuses the
// idempotent markDoseTaken helper (verifies the dose belongs to this profile via
// its parent supplement, logs it once, and decrements tracked supply) — the same
// path the Telegram callback uses — so a dose confirmed here reflects everywhere.
// Marking-only (never un-marks): a taken dose simply drops off the Upcoming list.
export async function markTaken(formData: FormData) {
  const { profile } = requireSession();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return;
  markDoseTaken(profile.id, doseId, null, today(profile.id));
  revalidatePath("/upcoming");
  revalidatePath("/medicine");
  revalidatePath("/");
}

// Quick-snooze durations (days) the Upcoming UI offers per item. Clamped in the
// action so a tampered form can't set an absurd window.
const SNOOZE_MAX_DAYS = 3650;

// Snooze a single due-item: hide it until `today + days`, after which it
// reappears. Upserts on the (profile_id, signal_key) unique index so re-snoozing
// (or snoozing a previously-dismissed item) just moves the date and clears any
// dismiss. Profile-scoped; every statement filters profile_id.
export async function snoozeItem(formData: FormData) {
  const { profile } = requireSession();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  const days = Number(formData.get("days"));
  if (!signalKey || !Number.isFinite(days) || days < 1) return;
  const until = shiftDateStr(
    today(profile.id),
    Math.min(Math.floor(days), SNOOZE_MAX_DAYS)
  );
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, ?, NULL)
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET snooze_until = excluded.snooze_until, dismissed_at = NULL`
  ).run(profile.id, signalKey, until);
  revalidatePath("/upcoming");
}

// Dismiss a single due-item: hide it indefinitely until the user restores it.
// Upserts, clearing any snooze so a dismiss always wins. Profile-scoped.
export async function dismissItem(formData: FormData) {
  const { profile } = requireSession();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return;
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, NULL, datetime('now'))
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET dismissed_at = datetime('now'), snooze_until = NULL`
  ).run(profile.id, signalKey);
  revalidatePath("/upcoming");
}

// Restore a snoozed/dismissed item: drop its suppression row so it reappears on
// Upcoming immediately. Profile-scoped.
export async function restoreItem(formData: FormData) {
  const { profile } = requireSession();
  const signalKey = String(formData.get("signal_key") ?? "").trim();
  if (!signalKey) return;
  db.prepare(
    "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
  ).run(profile.id, signalKey);
  revalidatePath("/upcoming");
}
