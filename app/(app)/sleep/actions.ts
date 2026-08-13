"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { today, writeTx } from "@/lib/db";
import { isRealIsoDate, shiftDateStr } from "@/lib/date";
import { normalizeMoodInput } from "@/lib/mood";
import { deleteMetricRow } from "@/lib/metric-readings";
import { insertVitals, upsertMoodLog } from "@/lib/offline/writes";
import { canEditManualSleepOnDate } from "@/lib/queries/metrics";
import { SLEEP_MOOD_HISTORY_DAYS } from "@/lib/queries/sleep";
import { parseReadingTarget } from "@/lib/reading-placement";
import { formError, formOk, type FormResult } from "@/lib/types";
import { normalizeVitalsInput } from "@/lib/vitals-input";

// The `metric_samples` key nightly sleep duration is stored under. Spelled here
// because this action must REFUSE any other metric: the target token is posted by
// the client, so "a metric_samples row of this profile" is not narrow enough — the
// Sleep log may only delete rows of the quantity it is a log of.
const SLEEP_MINUTES_METRIC = "sleep_min";

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
    // The sleep form states no event time — it posts hours for a night, not a
    // clock — so this core has no statement to judge and can never answer a
    // refusal here (#2363). `wrote` is the whole of its answer.
    if (
      hasSleep &&
      !insertVitals(profile.id, date, {
        sleepHours,
      }).wrote
    ) {
      throw new Error("Validated sleep entry was not written");
    }
    if (hasMood && !upsertMoodLog(profile.id, date, moodInput)) {
      throw new Error("Validated mood entry was not written");
    }
    return null;
  });
  if (writeError) return formError(writeError);

  revalidateRoute("/");
  revalidateRoute("/sleep");
  revalidateRoute("/trends");
  revalidateRoute("/results");
  return formOk();
}

/**
 * Delete ONE row behind a line of the Sleep and Mood log (issue #2556).
 *
 * The table listed rows it could not remove: a mistyped manual duration or a
 * mis-tapped check-in had no delete path anywhere. This adds the AFFORDANCE, not a
 * write path — `deleteMetricRow` (lib/metric-readings.ts) has owned per-reading
 * deletion since #2032, including the #507/#508 re-import tombstone and the #2123
 * undo capture, and it already splits the mood store off to its own write core
 * because mood is store-private (#992).
 *
 * What lives HERE is the gate, the narrowing and the revalidation, exactly as the
 * house rules put them at the action boundary. The narrowing matters: `target` is a
 * posted string, so this refuses everything that is not one of the two rows this
 * surface actually lists — a `sleep_min` sample, or the day's mood check-in. A
 * crafted token naming a steps sample or another store is a rejected no-op, and
 * profile scoping is still the core's own `WHERE profile_id = ?` underneath.
 *
 * There is deliberately no second editability re-check for sleep. The row is named
 * by ID, so an integration sync landing between render and tap cannot redirect the
 * delete onto its row; the manual sample the user asked to remove is the one that
 * goes, tombstoned so the next sync cannot bring it back.
 *
 * Returns the undo id in the shape `useUndoableDelete` expects — null where the
 * store had nothing to capture.
 */
export async function deleteSleepMoodRow(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { profile } = await requireWriteAccess();
  const target = parseReadingTarget(String(formData.get("target") ?? ""));
  if (!target) return { undoId: null };
  const allowed =
    (target.store === "metric_samples" &&
      target.metric === SLEEP_MINUTES_METRIC) ||
    (target.store === "mood" && target.series === "valence");
  if (!allowed) return { undoId: null };

  const outcome = deleteMetricRow(profile.id, target);
  if (!outcome.ok) return { undoId: null };
  // The same fan-out `saveSleepMoodEntry` uses: the scatter and the log above are
  // rendered from these rows, and both Trends and Results chart them.
  revalidateRoute("/");
  revalidateRoute("/sleep");
  revalidateRoute("/trends");
  revalidateRoute("/results");
  return { undoId: outcome.undoId };
}
