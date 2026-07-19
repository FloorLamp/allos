"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { today } from "@/lib/db";
import { upsertMoodLog } from "@/lib/offline/writes";
import { formError, formOk, type FormResult } from "@/lib/types";

// Server write path for the daily wellbeing check-in (issue #992). ONE action:
// the dashboard "How are you today?" card posts here for both the one-tap valence
// log and the expanded (energy/anxiety/factors/note) save. The gate shape is the
// standard requireWriteAccess() → parse → auth-blind lib write core →
// revalidatePath; the write core (upsertMoodLog, lib/offline/writes.ts) is the
// SAME one the offline-queue replay and the Telegram check-in button run, so a
// replayed or re-tapped check-in upserts the day's single row identically
// everywhere. Mood surfaces on the dashboard card and the Trends → Body chart, so
// both are revalidated.

export async function logMood(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();

  const rawDate = String(formData.get("date") ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : today(profile.id);

  const opt = (k: string): string | null => {
    const v = formData.get(k);
    return v === null || String(v).trim() === "" ? null : String(v).trim();
  };

  const ok = upsertMoodLog(profile.id, date, {
    valence: String(formData.get("valence") ?? ""),
    energy: opt("energy"),
    anxiety: opt("anxiety"),
    factors: formData.getAll("factors").map((f) => String(f)),
    note: opt("note"),
  });
  if (!ok) return formError("Couldn't save that check-in — try again.");

  revalidatePath("/");
  revalidatePath("/trends");
  return formOk();
}
