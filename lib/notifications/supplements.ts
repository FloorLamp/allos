// Builds the supplement-reminder notification for a time-of-day window, reusing
// the schedule helpers so workout/rest-day and situational logic is honored.
// The DB-touching gather lives here; the message formatting is the pure
// renderWindowMessage in ./supplement-format.

import { today } from "../db";
import { lastNDates } from "../date";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  getActivityDates,
  getSupplementLogsInRange,
} from "../queries";
import { getActiveSituations } from "../settings";
import {
  adherenceSummary,
  doseStrip,
  indexTakenByDose,
} from "../supplement-adherence";
import { isDueOn, timeBucket, type TimeBucket } from "../supplement-schedule";
import type { SupplementDose } from "../types";
import {
  renderWindowMessage,
  type ReminderWindow,
  type WindowDose,
} from "./supplement-format";
import type { NotificationMessage } from "./types";

export type { ReminderWindow };

// Rolling window for the streak + adherence percentage shown on each line —
// matches the supplements page's strip length.
const ADHERENCE_DAYS = 14;

// Map a dose's (5-value) time bucket to one of the 4 reminder windows: "Anytime"
// folds into the morning (so it's reminded once a day); "Before sleep" maps to
// the dedicated bedtime send.
function bucketWindow(b: TimeBucket): ReminderWindow {
  switch (b) {
    case "Midday":
      return "Midday";
    case "Evening":
      return "Evening";
    case "Before sleep":
      return "Bedtime";
    case "Morning":
    case "Anytime":
    default:
      return "Morning";
  }
}

// Gather the due doses in `window` on `date` from an already-fetched dose list,
// each tagged with whether it's been logged and its recent adherence. Taking the
// doses as an argument lets the callback path resolve a tapped dose's window and
// collect that window in a single query.
function gatherWindowDoses(
  profileId: number,
  window: ReminderWindow,
  date: string,
  doses: SupplementDose[]
): WindowDose[] {
  const supplements = getSupplements(profileId).filter((s) => s.active);
  if (supplements.length === 0) return [];

  const suppById = new Map(supplements.map((s) => [s.id, s]));
  const taken = getTakenDoseIds(profileId, date);
  const skipped = getSkippedDoseIds(profileId, date);
  const activeSituations = new Set(getActiveSituations(profileId));
  const ctx = {
    isWorkoutDay: getActivitiesByDate(profileId, date).length > 0,
    activeSituations,
  };

  // Inputs for the per-dose streak + adherence percentage. Anchored on the real
  // today (not `date`, which may be a prior day's reminder tapped late) so the
  // column window lines up with getSupplementLogsInRange's own today-anchored
  // range and with adherenceSummary's "last column is today, still pending" rule.
  const windowDates = lastNDates(today(profileId), ADHERENCE_DAYS);
  const workoutDays = new Set(getActivityDates(profileId));
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profileId, ADHERENCE_DAYS)
  );

  const entries: WindowDose[] = [];
  for (const dose of doses) {
    const supp = suppById.get(dose.item_id);
    if (!supp) continue;
    if (!isDueOn(supp, ctx)) continue;
    if (bucketWindow(timeBucket(dose.time_of_day)) !== window) continue;
    // A dose is "due" on a past date when its supplement was due that day
    // (workout/situational logic); situations are only known as of now.
    const dd = takenByDose.get(dose.id);
    const strip = doseStrip(
      windowDates,
      (d) =>
        isDueOn(supp, { isWorkoutDay: workoutDays.has(d), activeSituations }),
      dd?.taken ?? new Set<string>(),
      dd?.skipped ?? new Set<string>()
    );
    entries.push({
      dose,
      supp,
      taken: taken.has(dose.id),
      skipped: skipped.has(dose.id),
      adherence: adherenceSummary(strip),
    });
  }
  return entries;
}

// Every dose due in `window` on `date`, each tagged with whether it's already
// been logged. Includes taken doses (unlike a plain "what's left" query) so a
// reminder — or a rebuilt message after a tap — reflects the whole session.
export function collectWindowDoses(
  profileId: number,
  window: ReminderWindow,
  date: string
): WindowDose[] {
  return gatherWindowDoses(
    profileId,
    window,
    date,
    getSupplementDoses(profileId)
  );
}

// Reminder for supplements due in `window` today, or null when nothing is due —
// including when every dose for the window is already logged, so a reminder is
// never sent just to say everything's done.
export function buildSupplementReminder(
  profileId: number,
  window: ReminderWindow
): NotificationMessage | null {
  const date = today(profileId);
  const entries = collectWindowDoses(profileId, window, date);
  if (entries.length === 0) return null;
  // Every dose resolved — taken OR deliberately skipped (#232) — means nothing
  // is pending, so no reminder goes out (a skip stops re-nudging like a take).
  if (entries.every((e) => e.taken || e.skipped)) return null;
  return renderWindowMessage(profileId, window, date, entries);
}

// Resolve a tapped dose's window and collect that window's session in one dose
// fetch. Null when the dose isn't found for this profile; the returned entries
// can still be empty (e.g. the supplement was deactivated or is no longer due),
// which the caller treats as "can't rebuild the session view".
export function windowSessionForDose(
  profileId: number,
  doseId: number,
  date: string
): { window: ReminderWindow; entries: WindowDose[] } | null {
  const doses = getSupplementDoses(profileId);
  const tapped = doses.find((d) => d.id === doseId);
  if (!tapped) return null;
  const window = bucketWindow(timeBucket(tapped.time_of_day));
  return { window, entries: gatherWindowDoses(profileId, window, date, doses) };
}
