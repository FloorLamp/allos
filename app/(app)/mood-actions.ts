"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { today } from "@/lib/db";
import { upsertMoodLog } from "@/lib/offline/writes";
import {
  decideMoodKeep,
  isMoodDateAccepted,
  MOOD_DATE_OUT_OF_WINDOW_ERROR,
} from "@/lib/mood";
import {
  getMoodCheckinIgnored,
  getProfileMoodCheckin,
  resetMoodCheckinIgnored,
} from "@/lib/settings";
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
  // The #2128 backfill bound — the dose-log-window discipline (lib/dose-log-window.ts):
  // the day chips supply a recent past date, and a well-formed date outside that
  // window is refused rather than written, so a stale tab or crafted request can't
  // land a far-off check-in. (The offline REPLAY path calls upsertMoodLog directly
  // and deliberately keeps landing on its captured date — see lib/mood.ts.)
  if (!isMoodDateAccepted(today(profile.id), date)) {
    return formError(MOOD_DATE_OUT_OF_WINDOW_ERROR);
  }

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
  revalidatePath("/sleep");
  return formOk();
}

// Resume an AUTO-PAUSED check-in (issue #1668). The pause is derived state, never a
// stored flag — `enabled` stays true and `shouldSendMoodCheckin` remains the single
// decision — so "resuming" is exactly the streak reset that logging a mood already
// performs. One mechanism, three entry points: a logged mood, the final reminder's
// "Keep daily check-ins" button, and this action.
//
// Typed outcome, never an unconditional confirm: the streak may already have been
// re-armed (someone logged a mood on another device), and the check-in may have been
// turned off since the card rendered.
export async function resumeMoodCheckins(): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const outcome = decideMoodKeep({
    enabled: getProfileMoodCheckin(profile.id),
    ignoredCount: getMoodCheckinIgnored(profile.id),
  });
  if (outcome === "not-enabled") {
    return formError(
      "Check-ins are off — turn them on in Settings → Notifications."
    );
  }
  if (outcome === "kept") resetMoodCheckinIgnored(profile.id);
  revalidatePath("/");
  revalidatePath("/settings/notifications");
  return formOk();
}
