"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { today, writeTx } from "@/lib/db";
import { isRealIsoDate, shiftDateStr } from "@/lib/date";
import { normalizeMoodInput } from "@/lib/mood";
import { deleteMetricRow } from "@/lib/metric-readings";
import {
  insertVitals,
  resolveSleepWindow,
  upsertMoodLog,
} from "@/lib/offline/writes";
import { canEditManualSleepOnDate } from "@/lib/queries/metrics";
import { SLEEP_MOOD_HISTORY_DAYS } from "@/lib/queries/sleep";
import { parseReadingTarget } from "@/lib/reading-placement";
import { formError, formOk, type FormResult } from "@/lib/types";
import { getTimezone } from "@/lib/settings";
import { formatHm } from "@/lib/sleep-summary";
import { retimeSleepSessionCore } from "@/lib/sleep-retime-db";
import {
  normalizeVitalsInput,
  sleepWindowFromClocks,
} from "@/lib/vitals-input";

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
      !insertVitals(
        profile.id,
        date,
        { sleepHours },
        // The Sleep page's own form. ONLINE — this action runs on a live request; the
        // offline queue's replay is the only caller of this core that is a replay.
        "page"
      ).wrote
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

/**
 * Move a hedged sleep session onto the window a person states (issue #5021).
 *
 * #4299 left a contradicted night two states, hedged or deleted, and a person who KNEW
 * when they slept had to lose the night to keep the record honest. This is the third,
 * and the person is the only thing that triggers it — the ruling that forbade a SILENT
 * shift stands, and nothing here infers a window.
 *
 * The clocks arrive as two wall clocks against the row's wake day, which is how every
 * stated sleep window reaches this app, so they fold through the same
 * `sleepWindowFromClocks` + `resolveSleepWindow` pair the manual entry uses rather than
 * a second reading of what "23:30 to 06:40" means. The MOVE, the refusals and the undo
 * capture are `retimeSleepSessionCore`'s (lib/sleep-retime-db.ts); what lives here is
 * the gate, the fold and the revalidation.
 *
 * Returns the undo token in the shape `useUndoableDelete` expects, so a re-time offers
 * the same Undo as a delete and through the same toast.
 */
export async function retimeSleepSession(
  formData: FormData
): Promise<{ undoId: number | null; error?: string }> {
  const { profile } = await requireWriteAccess();
  const sampleId = Number(formData.get("sample_id"));
  const date = String(formData.get("date") ?? "").trim();
  if (!Number.isInteger(sampleId) || sampleId <= 0 || !isRealIsoDate(date)) {
    return { undoId: null, error: "That sleep session is no longer there." };
  }
  const stated = sleepWindowFromClocks(
    String(formData.get("bed_time") ?? ""),
    String(formData.get("wake_time") ?? "")
  );
  const resolved = stated
    ? resolveSleepWindow(getTimezone(profile.id), date, stated)
    : null;
  if (!resolved) {
    return { undoId: null, error: "Enter a bed time and a wake time." };
  }

  const outcome = retimeSleepSessionCore(profile.id, sampleId, {
    bedAt: resolved.startedAt,
    wakeAt: resolved.endedAt,
  });
  switch (outcome.kind) {
    case "not-found":
      return { undoId: null, error: "That sleep session is no longer there." };
    case "not-hedged":
      // The lock is the default and this door is the exception to it, so the refusal
      // names the exception rather than the lock.
      return {
        undoId: null,
        error: "Only a night flagged against your heart rate can be re-timed.",
      };
    case "invalid-window":
      return {
        undoId: null,
        error:
          "Enter a window in the past, with a wake time after the bed time.",
      };
    case "length-changed":
      // The one refusal a person can act on, so it says the number they have to match.
      // Why it exists is in lib/sleep-retime-db.ts: a different length has no single
      // delta, and both alternatives fabricate the stage breakdown.
      return {
        undoId: null,
        error: `Keep the same length — this session is ${formatHm(
          outcome.storedMinutes
        )}. To log a different amount, delete it and add the hours.`,
      };
    case "retimed":
      break;
  }

  // The same fan-out the delete uses: the hero, the log and the scatter read these
  // rows, and both Trends and Results chart them.
  revalidateRoute("/");
  revalidateRoute("/sleep");
  revalidateRoute("/trends");
  revalidateRoute("/results");
  return { undoId: outcome.undoId };
}
