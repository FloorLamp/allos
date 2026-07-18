// Read/derive layer for endurance event plans (issue #839). Gathers the CURRENT logged
// weekly volume + this-week actuals per discipline and combines them with the pure
// trajectory engine (lib/endurance-plan) into the plan-card + recommendation-arm models
// every surface renders — one computation (#221). All SQL filters profile_id.

import { db, today } from "../db";
import { getWeekStart } from "../settings";
import { startOfWeekStr } from "../date";
import { parseComponents, type ActivityComponent } from "../types";
import {
  buildEndurancePlanCard,
  computeEnduranceTrajectory,
  detectLongSessionKm,
  disciplineForActivityName,
  enduranceArmFor,
  type EnduranceArm,
  type EndurancePlan,
  type EndurancePlanCard,
  type EndurancePlanDiscipline,
  type LoggedSession,
} from "../endurance-plan";
import { getActiveEndurancePlans } from "../endurance-plans";

// One logged session mapped to a discipline: its week-start, distance, and long-run label.
interface DisciplineSession {
  weekStart: string;
  distanceKm: number;
  workoutType: string | null;
}

// Scan the profile's cardio efforts (top-level rows + cardio components), keep those whose
// activity NAME maps to `discipline`, and bucket by week-start. Distance-based (a plan is
// a distance goal), carrying the Strava workout_type label for long-run detection.
function disciplineSessions(
  profileId: number,
  discipline: EndurancePlanDiscipline
): DisciplineSession[] {
  const weekStart = getWeekStart(profileId);
  const rows = db
    .prepare(
      `SELECT date, type, title, distance_km, workout_type, components
         FROM activities
        WHERE profile_id = ? AND (type = 'cardio' OR components IS NOT NULL)
        ORDER BY date ASC, id ASC`
    )
    .all(profileId) as {
    date: string;
    type: string;
    title: string;
    distance_km: number | null;
    workout_type: string | null;
    components: string | null;
  }[];

  const out: DisciplineSession[] = [];
  for (const r of rows) {
    const comps: ActivityComponent[] = parseComponents(r.components);
    const cardioComps = comps.filter(
      (c) => c?.type === "cardio" && typeof c.name === "string" && c.name.trim()
    );
    if (cardioComps.length) {
      for (const c of cardioComps) {
        if (disciplineForActivityName(c.name) !== discipline) continue;
        out.push({
          weekStart: startOfWeekStr(r.date, weekStart),
          distanceKm: c.distance_km ?? 0,
          workoutType: r.workout_type,
        });
      }
    } else if (r.type === "cardio" && r.title.trim()) {
      if (disciplineForActivityName(r.title) !== discipline) continue;
      out.push({
        weekStart: startOfWeekStr(r.date, weekStart),
        distanceKm: r.distance_km ?? 0,
        workoutType: r.workout_type,
      });
    }
  }
  return out;
}

// This-week actuals + the last-completed-week volume for a discipline. `currentVolumeKm`
// is the base the trajectory projects from (recompute-from-actuals): a missed week lowers
// it and the remaining plan auto-adjusts.
interface DisciplineVolume {
  currentVolumeKm: number;
  thisWeekVolumeKm: number;
  thisWeekSessions: number;
  thisWeekLongestKm: number;
}

function disciplineVolume(
  profileId: number,
  discipline: EndurancePlanDiscipline,
  todayStr: string
): DisciplineVolume {
  const weekStart = getWeekStart(profileId);
  const thisWeekStart = startOfWeekStr(todayStr, weekStart);
  const sessions = disciplineSessions(profileId, discipline);

  const byWeek = new Map<string, LoggedSession[]>();
  for (const s of sessions) {
    const arr = byWeek.get(s.weekStart) ?? [];
    arr.push({ distanceKm: s.distanceKm, workoutType: s.workoutType });
    byWeek.set(s.weekStart, arr);
  }
  const sum = (arr: LoggedSession[] | undefined) =>
    (arr ?? []).reduce((a, s) => a + s.distanceKm, 0);

  // Last COMPLETED week = the most recent week-start strictly before this week.
  const completed = [...byWeek.keys()].filter((w) => w < thisWeekStart).sort();
  const lastCompleted = completed.at(-1);
  const thisWeekSessions = byWeek.get(thisWeekStart) ?? [];

  return {
    currentVolumeKm: lastCompleted ? sum(byWeek.get(lastCompleted)) : 0,
    thisWeekVolumeKm: sum(thisWeekSessions),
    thisWeekSessions: thisWeekSessions.length,
    thisWeekLongestKm: detectLongSessionKm(thisWeekSessions),
  };
}

// The plan card for one plan (plan + recomputed trajectory + this-week actuals).
export function getEndurancePlanCard(
  profileId: number,
  plan: EndurancePlan,
  todayStr: string
): EndurancePlanCard {
  const vol = disciplineVolume(profileId, plan.discipline, todayStr);
  const trajectory = computeEnduranceTrajectory({
    today: todayStr,
    eventDate: plan.eventDate,
    discipline: plan.discipline,
    targetDistanceKm: plan.targetDistanceKm,
    currentWeeklyVolumeKm: vol.currentVolumeKm,
    weekStart: getWeekStart(profileId),
  });
  return buildEndurancePlanCard({
    plan,
    trajectory,
    actualVolumeKm: vol.thisWeekVolumeKm,
    actualLongSessionKm: vol.thisWeekLongestKm,
    sessionsThisWeek: vol.thisWeekSessions,
  });
}

// Every ACTIVE plan's card, soonest event first (skips already-past events). Profile-
// scoped. The Training overview renders these; the finding builder + recommendation arm
// read the same models.
export function getEndurancePlanCards(
  profileId: number,
  todayStr = today(profileId)
): EndurancePlanCard[] {
  return getActiveEndurancePlans(profileId)
    .filter((p) => p.eventDate >= todayStr)
    .map((p) => getEndurancePlanCard(profileId, p, todayStr));
}

// The plan-aware cardio ARM for the recommendation model (#221) — the soonest active
// plan's calm one-line note. `illnessActive` HOLDS the arm (illness pause, #837): the
// card still renders on Training overview, but the nagging note is suppressed. Null when
// no active plan (or during an open illness episode).
export function getEnduranceArm(
  profileId: number,
  todayStr: string,
  illnessActive = false
): EnduranceArm | null {
  if (illnessActive) return null;
  const cards = getEndurancePlanCards(profileId, todayStr);
  if (cards.length === 0) return null;
  return enduranceArmFor(cards[0]);
}
