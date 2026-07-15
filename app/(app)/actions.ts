"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { setDashboardLayout } from "@/lib/settings";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { snoozeUntil } from "@/lib/upcoming";
import { snoozeFinding, dismissFinding, markDoseTaken } from "@/lib/queries";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";

// Persist the active profile's dashboard customization: the widget
// display order and the set of hidden widget ids. Profile-scoped like the other
// per-profile settings; the layout is merged defensively against the registry on
// read, so ids aren't validated here.
export async function saveDashboardLayout(order: string[], hidden: string[]) {
  const { profile } = await requireWriteAccess();
  setDashboardLayout(profile.id, { order, hidden });
  revalidatePath("/");
}

// "Not today" on the dashboard Coaching widget (findings bus, #39): snooze the top
// recommendation until tomorrow through the shared suppression store, so the
// next-ranked recommendation surfaces for the rest of the day. Guarded to the
// coaching namespace so a tampered form can't snooze an arbitrary finding key.
// Profile-scoped via snoozeFinding.
export async function snoozeCoaching(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith("coaching:")) return;
  snoozeFinding(profile.id, dedupeKey, shiftDateStr(today(profile.id), 1));
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
export async function markAttentionDose(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return;
  markDoseTaken(profile.id, doseId, null, today(profile.id));
  revalidatePath("/");
  revalidatePath("/upcoming");
  revalidatePath("/nutrition");
  revalidatePath("/medications");
}
