"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today, writeTx } from "@/lib/db";
import { isRealIsoDate, shiftDateStr } from "@/lib/date";
import { normalizeMoodInput } from "@/lib/mood";
import { insertVitals, upsertMoodLog } from "@/lib/offline/writes";
import { canEditManualSleepOnDate } from "@/lib/queries/metrics";
import { SLEEP_MOOD_HISTORY_DAYS } from "@/lib/queries/sleep";
import { formError, formOk, type FormResult } from "@/lib/types";
import { normalizeVitalsInput } from "@/lib/vitals-input";

// One atomic write boundary for the Sleep and Mood Log editor. The shared write
// cores remain the sole persistence implementations; this action validates both
// payloads before opening one IMMEDIATE transaction, so a rejected mood can never
// leave an already-committed sleep correction behind (or vice versa).
export async function saveSleepMoodEntry(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  const end = today(profile.id);
  const start = shiftDateStr(end, -(SLEEP_MOOD_HISTORY_DAYS - 1));
  if (!isRealIsoDate(date) || date < start || date > end) {
    return formError("Choose a date within the visible log range.");
  }

  const sleepHours = String(formData.get("sleep_hours") ?? "").trim();
  const valence = String(formData.get("valence") ?? "").trim();
  const hasSleep = sleepHours !== "";
  const hasMood = valence !== "";
  if (!hasSleep && !hasMood) return formError("Nothing to save.");

  if (hasSleep) {
    const normalized = normalizeVitalsInput({ sleepHours });
    if ("error" in normalized) return formError(normalized.error);
  }

  const moodInput = {
    valence,
    energy: formData.get("energy"),
    anxiety: formData.get("anxiety"),
    factors: formData.getAll("factors"),
    note: formData.get("note"),
  };
  if (hasMood) {
    const normalized = normalizeMoodInput(moodInput);
    if ("error" in normalized) return formError(normalized.error);
  }

  const writeError = writeTx(() => {
    if (hasSleep && !canEditManualSleepOnDate(profile.id, date)) {
      return "Synced sleep entries cannot be edited here.";
    }
    if (
      hasSleep &&
      !insertVitals(profile.id, date, {
        sleepHours,
      })
    ) {
      throw new Error("Validated sleep entry was not written");
    }
    if (hasMood && !upsertMoodLog(profile.id, date, moodInput)) {
      throw new Error("Validated mood entry was not written");
    }
    return null;
  });
  if (writeError) return formError(writeError);

  revalidatePath("/");
  revalidatePath("/sleep");
  revalidatePath("/trends");
  revalidatePath("/results");
  return formOk();
}
