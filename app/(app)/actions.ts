"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { setDashboardLayout } from "@/lib/settings";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { snoozeFinding } from "@/lib/queries";

// Persist the active profile's dashboard customization (issue #156): the widget
// display order and the set of hidden widget ids. Profile-scoped like the other
// per-profile settings; the layout is merged defensively against the registry on
// read, so ids aren't validated here.
export async function saveDashboardLayout(order: string[], hidden: string[]) {
  const { profile } = requireSession();
  setDashboardLayout(profile.id, { order, hidden });
  revalidatePath("/");
}

// "Not today" on the dashboard Coaching widget (findings bus, #39): snooze the top
// recommendation until tomorrow through the shared suppression store, so the
// next-ranked recommendation surfaces for the rest of the day. Guarded to the
// coaching namespace so a tampered form can't snooze an arbitrary finding key.
// Profile-scoped via snoozeFinding.
export async function snoozeCoaching(formData: FormData) {
  const { profile } = requireSession();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith("coaching:")) return;
  snoozeFinding(profile.id, dedupeKey, shiftDateStr(today(profile.id), 1));
  revalidatePath("/");
}
