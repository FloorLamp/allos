"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
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
import { gateItemProfile } from "./gate-item";
import { isPastWriteAccepted } from "@/lib/log-manifest";

// Server write path for the daily wellbeing check-in (issue #992). ONE action:
// the dashboard "How are you today?" card posts here for both the one-tap valence
// log and the expanded (energy/anxiety/factors/note) save. The gate shape is the
// standard requireWriteAccess() → parse → auth-blind lib write core →
// revalidatePath; the write core (upsertMoodLog, lib/offline/writes.ts) is the
// SAME one the offline-queue replay and the Telegram check-in button run, so a
// replayed or re-tapped check-in upserts the day's single row identically
// everywhere. Mood surfaces on the dashboard card and the Trends → Overview → body census chart, so
// both are revalidated.

export async function logMood(formData: FormData): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);

  const rawDate = String(formData.get("date") ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : today(profileId);
  // WINDOWS BIND OFFERS, NOT THE DOMAIN (#4425). Quick-log day chips remain bounded
  // for stale-tap protection; the record's dated form can state any real past day,
  // like every other `/history` add/correction door. Both land through the same core.
  const dated = formData.get("date_reach") === "dated";
  const accepted = dated
    ? isPastWriteAccepted(today(profileId), date)
    : isMoodDateAccepted(today(profileId), date);
  if (!accepted) {
    return formError(
      dated ? "Choose today or an earlier date." : MOOD_DATE_OUT_OF_WINDOW_ERROR
    );
  }

  const opt = (k: string): string | null => {
    const v = formData.get(k);
    return v === null || String(v).trim() === "" ? null : String(v).trim();
  };

  const ok = upsertMoodLog(
    profileId,
    date,
    {
      valence: String(formData.get("valence") ?? ""),
      energy: opt("energy"),
      anxiety: opt("anxiety"),
      factors: formData.getAll("factors").map((f) => String(f)),
      note: opt("note"),
    },
    // WHAT THE FORM COULD SEE (#3416). Posted only by the quick logger's cold offline
    // open, which builds the mood form from the device's own day and queue and so
    // cannot show a check-in already stored for that day — and which reaches this
    // action, not the queue, when the connection comes back between the open and the
    // tap. Absent everywhere else: every other mount pre-fills from the stored row.
    formData.get("day_unseen") === "1" ? "day-unseen" : "saw-the-day"
  );
  if (!ok) return formError("Couldn't save that check-in — try again.");

  revalidateRoute("/");
  revalidateRoute("/trends");
  revalidateRoute("/sleep");
  revalidateRoute("/history");
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
  revalidateRoute("/");
  revalidateRoute("/settings/notifications");
  return formOk();
}
