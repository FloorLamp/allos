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
import { daysBetweenDateStr, shiftDateStr } from "../date";
import {
  getActivitiesSince,
  getActivityDates,
  getVolumeByDate,
  getStrengthByExercise,
  getCardioByActivity,
  getWeights,
  getGoals,
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  getZone2MinutesInWindow,
  getSleepRegularity,
} from "../queries";
import { recentPRs, recentCardioPRs } from "../coaching";
import { totalEstimatedKcal, type DatedWeight } from "../calorie-estimate";
import { isDueOn } from "../supplement-schedule";
import { currentStreak, flexibleStreak } from "../streak";
import {
  buildWeeklyRecap,
  resolveRecapWindow,
  renderRecapMessage,
  pickRecapNarrative,
  inWindow,
  type RecapInput,
  type RecapWorkout,
  type WeeklyRecap,
  type WorkoutType,
} from "../weekly-recap";
import { getRecentNarratives } from "../queries";
import {
  getActiveSituations,
  getSituationEvents,
  getWeekMode,
  getWeekStart,
  getZone2WeeklyTargetMin,
  setProfileSetting,
} from "../settings";
import { situationHistoryResolver } from "../trend-annotations";
import { illnessDaysInWindow } from "../illness-episode-store";
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

// Supplement adherence (taken / skipped / due) across the window, using the same
// due-dose derivation as the digest (isDueOn honoring workout-day + active
// situations). Deliberate skips (#232) are tallied separately so the recap can
// show them alongside taken and exclude them from the percentage denominator.
function windowAdherence(
  profileId: number,
  start: string,
  end: string
): { taken: number; skipped: number; due: number } | null {
  const active = getSupplements(profileId).filter((s) => s.active);
  if (active.length === 0) return null;
  const suppById = new Map(active.map((s) => [s.id, s]));
  const doses = getSupplementDoses(profileId).filter((d) =>
    suppById.has(d.item_id)
  );
  if (doses.length === 0) return null;
  // Per-day situation resolver (#654): each past day in the recap window is scored
  // against the situations active THAT day, not today's toggle applied retroactively.
  const situationsOn = situationHistoryResolver(
    getActiveSituations(profileId),
    getSituationEvents(profileId)
  );

  let taken = 0;
  let skipped = 0;
  let due = 0;
  for (let d = start; d <= end; d = shiftDateStr(d, 1)) {
    const isWorkoutDay = getActivitiesByDate(profileId, d).length > 0;
    const dueIds = doses
      .filter((dose) =>
        isDueOn(suppById.get(dose.item_id)!, {
          isWorkoutDay,
          activeSituations: situationsOn(d),
        })
      )
      .map((dose) => dose.id);
    if (dueIds.length === 0) continue;
    const takenSet = getTakenDoseIds(profileId, d);
    const skippedSet = getSkippedDoseIds(profileId, d);
    due += dueIds.length;
    taken += dueIds.filter((id) => takenSet.has(id)).length;
    skipped += dueIds.filter((id) => skippedSet.has(id)).length;
  }
  return due > 0 ? { taken, skipped, due } : null;
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
  // "This week" per the profile's week_mode for the 7-day recap (issue #223), so
  // the recap window matches the routine counters / journal; monthly (#20) falls
  // back to a trailing window inside resolveRecapWindow.
  const weekMode = getWeekMode(profileId);
  const weekStart = getWeekStart(profileId);
  const win = resolveRecapWindow(td, days, weekMode, weekStart);

  // Only the recap's two windows (current + previous) reduce these, and win.prevStart
  // is the earliest bound of either, so bound the load there (issue #389) instead of
  // pulling all history (SELECT *, incl. the components TEXT) to discard all but ~14
  // days. The streak below needs full history, so it reads getActivityDates directly.
  const allActivities = getActivitiesSince(profileId, win.prevStart);
  const activities = allActivities.map(asWorkout);
  const workouts = activities.filter((w) =>
    inWindow(w.date, win.start, win.end)
  );
  const prevWorkouts = activities.filter((w) =>
    inWindow(w.date, win.prevStart, win.prevEnd)
  );

  const volumeRows = getVolumeByDate(profileId);
  const volumeKg = sumVolume(volumeRows, win.start, win.end);
  const prevVolumeKg = sumVolume(volumeRows, win.prevStart, win.prevEnd);

  // Estimated calorie burn (issue #151) from MANUAL activities: each scored against
  // the bodyweight nearest its date, so a full (unfiltered) weight series is needed
  // for the nearest-in-time lookup — not just the in-window weigh-ins below.
  const weightSeries: DatedWeight[] = getWeights(profileId)
    .filter((w) => w.weight_kg != null)
    .map((w) => ({ date: w.date, weightKg: w.weight_kg as number }));
  const estimatedKcal = totalEstimatedKcal(
    allActivities.filter((a) => inWindow(a.date, win.start, win.end)),
    weightSeries
  );
  const prevEstimatedKcal = totalEstimatedKcal(
    allActivities.filter((a) => inWindow(a.date, win.prevStart, win.prevEnd)),
    weightSeries
  );

  // PRs (strength + cardio) set within the recap window; labels are canonical
  // exercise / activity display names, de-duplicated in first-seen order. The PR
  // helpers' `within` is INCLUSIVE both ends, so it must be the number of days from
  // the window start to today — derived from `win.start` so it tracks whichever
  // window resolveRecapWindow produced (a calendar week can be a partial, <7-day
  // span). This matches the workout window exactly, so a PR dated on `win.prevEnd`
  // (whose workout lands in the *previous* window) never leaks in (issues #190/#223).
  const withinDays = daysBetweenDateStr(win.start, td) ?? days - 1;
  const strengthPRs = recentPRs(
    getStrengthByExercise(profileId),
    td,
    withinDays
  );
  const cardioPRs = recentCardioPRs(
    getCardioByActivity(profileId, "km"),
    td,
    withinDays
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

  // Streaks walk back arbitrarily far, so they need the FULL date history — not the
  // windowed `activities` above. getActivityDates is the cheap DISTINCT-dates read
  // (currentStreak/flexibleStreak read it as a set, so dedup is irrelevant).
  const activityDates = getActivityDates(profileId);
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
    weekMode,
    weekStart,
    workouts,
    prevWorkouts,
    volumeKg,
    prevVolumeKg,
    estimatedKcal,
    prevEstimatedKcal,
    prLabels,
    adherence: windowAdherence(profileId, win.start, win.end),
    weights,
    streak: flexibleStreak(td, activityDates),
    strictStreak: currentStreak(td, activityDates),
    goalsCompleted,
    // Sick days within the window (issue #837) — the recovery-context honesty line,
    // from the SAME illness_episodes rows the illness surfaces use (one derivation).
    illnessDays: illnessDaysInWindow(profileId, win.start, win.end),
    // Zone 2 aerobic-base minutes over the SAME window (win is a days-1 inclusive
    // range, #190) — null when no HR zone model exists (line then omitted).
    zone2Min: getZone2MinutesInWindow(profileId, win.start, win.end),
    zone2Target: getZone2WeeklyTargetMin(profileId),
    // Sleep Regularity Index (#160) over the trailing 28-night window — the SAME
    // pure computeSleepRegularity the Trends sleep card renders (one computation).
    // Null (line omitted) below the minimum-nights gate.
    ...(() => {
      const reg = getSleepRegularity(profileId);
      return {
        sri: reg?.sri ?? null,
        socialJetlagMin: reg?.socialJetlagMin ?? null,
      };
    })(),
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
  // Surface the stored AI recap narrative when one exists for this window (#421).
  // READ-ONLY — the tick must never call Claude (quota atomicity assumes a single
  // AI-calling process); it only SELECTs a narrative the web process already
  // generated, falling back to the bullet lines when there is none.
  const narrative = pickRecapNarrative(
    getRecentNarratives(profileId, ["week"], 5),
    recap
  );
  const msg = renderRecapMessage(recap, profileName, narrative);
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
