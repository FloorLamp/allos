// Weekly-recap DB gather + send orchestration (issue #32). Pulls the per-profile
// facts the recap summarizes from the already-scoped query layer, hands them to the
// pure buildWeeklyRecap, and dispatches the rendered message. Called once per week
// per profile from the notify tick (on the chosen weekday/hour), hard-deduped to one
// send per profile per day via notify_last_weekly_recap — so a retry the same day
// can't double-send and the next week's same weekday (a new date) fires again.
//
// The SAME gatherRecapInput powers the dashboard Weekly-recap widget, so the card
// and the notification always show identical numbers.

import { today } from "../db";
import { shiftDateStr } from "../date";
import {
  getActivities,
  getVolumeByDate,
  getStrengthByExercise,
  getCardioByActivity,
  getWeights,
  getGoals,
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getActivitiesByDate,
} from "../queries";
import { recentPRs, recentCardioPRs } from "../coaching";
import { isDueOn } from "../supplement-schedule";
import { currentStreak, flexibleStreak } from "../streak";
import {
  buildWeeklyRecap,
  recapWindow,
  renderRecapMessage,
  inWindow,
  type RecapInput,
  type RecapWorkout,
  type WeeklyRecap,
  type WorkoutType,
} from "../weekly-recap";
import { getActiveSituations, setProfileSetting } from "../settings";
import type { WeightUnit } from "../settings";
import { dispatch } from "./index";
import { createLogger } from "../log";

const log = createLogger("notify");

function asWorkout(a: { date: string; type: string }): RecapWorkout {
  const type: WorkoutType =
    a.type === "cardio" ? "cardio" : a.type === "sport" ? "sport" : "strength";
  return { date: a.date, type };
}

function sumVolume(
  rows: { date: string; volume: number }[],
  start: string,
  end: string
): number {
  return rows
    .filter((r) => inWindow(r.date, start, end))
    .reduce((acc, r) => acc + (r.volume || 0), 0);
}

// Supplement adherence (taken / due) across the window, using the same due-dose
// derivation as the digest (isDueOn honoring workout-day + active situations).
function windowAdherence(
  profileId: number,
  start: string,
  end: string
): { taken: number; due: number } | null {
  const active = getSupplements(profileId).filter((s) => s.active);
  if (active.length === 0) return null;
  const suppById = new Map(active.map((s) => [s.id, s]));
  const doses = getSupplementDoses(profileId).filter((d) =>
    suppById.has(d.supplement_id)
  );
  if (doses.length === 0) return null;
  const situations = new Set(getActiveSituations(profileId));

  let taken = 0;
  let due = 0;
  for (let d = start; d <= end; d = shiftDateStr(d, 1)) {
    const isWorkoutDay = getActivitiesByDate(profileId, d).length > 0;
    const dueIds = doses
      .filter((dose) =>
        isDueOn(suppById.get(dose.supplement_id)!, {
          isWorkoutDay,
          activeSituations: situations,
        })
      )
      .map((dose) => dose.id);
    if (dueIds.length === 0) continue;
    const takenSet = getTakenDoseIds(profileId, d);
    due += dueIds.length;
    taken += dueIds.filter((id) => takenSet.has(id)).length;
  }
  return due > 0 ? { taken, due } : null;
}

// Gather the recap facts for one profile over the trailing seven days. weightUnit
// controls how the values render (the dashboard passes the login's preference; the
// notification uses canonical kg). distanceUnit only feeds the cardio stats query.
export function gatherRecapInput(
  profileId: number,
  weightUnit: WeightUnit = "kg",
  days = 7
): RecapInput {
  const td = today(profileId);
  const win = recapWindow(td, days);

  const activities = getActivities(profileId).map(asWorkout);
  const workouts = activities.filter((w) =>
    inWindow(w.date, win.start, win.end)
  );
  const prevWorkouts = activities.filter((w) =>
    inWindow(w.date, win.prevStart, win.prevEnd)
  );

  const volumeRows = getVolumeByDate(profileId);
  const volumeKg = sumVolume(volumeRows, win.start, win.end);
  const prevVolumeKg = sumVolume(volumeRows, win.prevStart, win.prevEnd);

  // PRs (strength + cardio) set within the recap window; labels are canonical
  // exercise / activity display names, de-duplicated in first-seen order.
  const strengthPRs = recentPRs(getStrengthByExercise(profileId), td, days);
  const cardioPRs = recentCardioPRs(
    getCardioByActivity(profileId, "km"),
    td,
    days
  );
  const prLabels: string[] = [];
  const seen = new Set<string>();
  for (const p of strengthPRs) {
    if (!seen.has(p.exercise)) {
      seen.add(p.exercise);
      prLabels.push(p.exercise);
    }
  }
  for (const p of cardioPRs) {
    if (!seen.has(p.activity)) {
      seen.add(p.activity);
      prLabels.push(p.activity);
    }
  }

  // Pull enough recent rows to cover the window even at a few weigh-ins per day
  // (a monthly window spans more days than the historical 60-row cap assumed).
  const weights = getWeights(profileId, Math.max(60, days * 4))
    .filter((w) => w.weight_kg != null && inWindow(w.date, win.start, win.end))
    .map((w) => ({ date: w.date, weightKg: w.weight_kg as number }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const activityDates = activities.map((a) => a.date);
  const goalsCompleted = getGoals(profileId)
    .filter(
      (g) =>
        g.status === "achieved" &&
        !g.archived &&
        g.target_date != null &&
        inWindow(g.target_date, win.start, win.end)
    )
    .map((g) => g.title);

  return {
    today: td,
    weightUnit,
    periodDays: days,
    workouts,
    prevWorkouts,
    volumeKg,
    prevVolumeKg,
    prLabels,
    adherence: windowAdherence(profileId, win.start, win.end),
    weights,
    streak: flexibleStreak(td, activityDates),
    strictStreak: currentStreak(td, activityDates),
    goalsCompleted,
  };
}

// Convenience for the dashboard widget: gather + build in one call.
export function getWeeklyRecap(
  profileId: number,
  weightUnit: WeightUnit = "kg"
): WeeklyRecap {
  return buildWeeklyRecap(gatherRecapInput(profileId, weightUnit));
}

// Gather + build a recap over an arbitrary window length (issue #20): the AI
// narrative generator reuses this so the weekly/monthly AI read narrates over the
// SAME rule-based recap facts the dashboard widget/notification already show.
export function getPeriodRecap(
  profileId: number,
  days: number,
  weightUnit: WeightUnit = "kg"
): WeeklyRecap {
  return buildWeeklyRecap(gatherRecapInput(profileId, weightUnit, days));
}

// Build + send this profile's weekly recap for `date`. Marks the day done (dedup)
// whether it sent or found nothing to say, so it isn't recomputed every hour. Sends
// in canonical kg (the notification has no login-unit context).
export async function runWeeklyRecap(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  const dedupKey = "notify_last_weekly_recap";
  const recap = buildWeeklyRecap(gatherRecapInput(profileId, "kg"));
  const msg = renderRecapMessage(recap, profileName);
  if (!msg) {
    setProfileSetting(profileId, dedupKey, date);
    log.info("weekly recap: nothing to send", { profile: profileId });
    return { failed: false };
  }

  const results = await dispatch(profileId, msg);
  if (results.length === 0) {
    // No channel configured — leave unmarked so it can send once configured.
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) setProfileSetting(profileId, dedupKey, date);
  return { failed };
}
