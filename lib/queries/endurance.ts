// Read/derive layer for endurance event plans (issue #839). Gathers the CURRENT logged
// weekly volume + this-week actuals per discipline and combines them with the pure
// trajectory engine (lib/endurance-plan) into the plan-card + recommendation-arm models
// every surface renders — one computation (#221). All SQL filters profile_id.

import { db, today } from "../db";
import { isDraftActivityRow, type DraftCandidateRow } from "../activity-draft";
import { getWeekStart } from "../settings";
import { startOfWeekStr } from "../date";
import { parseComponents, type ActivityComponent } from "../types";
import {
  buildEndurancePlanCard,
  coachedPlan,
  computeEnduranceTrajectory,
  detectLongSessionKm,
  disciplineForActivityName,
  enduranceArmFor,
  weeksToEvent,
  type EnduranceArm,
  type CoachedEndurancePlan,
  type EndurancePlan,
  type EndurancePlanCard,
  type EndurancePlanDiscipline,
  type LoggedSession,
} from "../endurance-plan";
import { getActiveEndurancePlans, getEndurancePlan } from "../endurance-plans";

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
  plan: CoachedEndurancePlan,
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
  todayStr: string = today(profileId)
): EndurancePlanCard[] {
  return getEnduranceEvents(profileId, todayStr)
    .map((e) => e.card)
    .filter((c): c is EndurancePlanCard => c !== null);
}

// An upcoming ACTIVE event and its trajectory, if it has one (#3285). This is the
// wider set `getEndurancePlanCards` narrows: EVERY active future event, with a card
// only where the cardio pair makes one derivable. A lifting meet is a real row here
// and a null card — not a missing event — which is what lets the Overview render it
// beside the marathon without a second component or a second store.
export interface EnduranceEvent {
  plan: EndurancePlan;
  card: EndurancePlanCard | null;
  // The countdown, computed here for EVERY event rather than read off the trajectory,
  // so a meet counts down by the same rule as a marathon. Identical to
  // `card.trajectory.weeksToEvent` where a card exists — the trajectory calls the same
  // pure helper with the same profile week-start.
  weeksToEvent: number;
}

export function getEnduranceEvents(
  profileId: number,
  todayStr: string = today(profileId)
): EnduranceEvent[] {
  return getActiveEndurancePlans(profileId)
    .filter((p) => p.eventDate >= todayStr)
    .map((p) => {
      const coached = coachedPlan(p);
      return {
        plan: p,
        card: coached
          ? getEndurancePlanCard(profileId, coached, todayStr)
          : null,
        weeksToEvent: weeksToEvent(
          todayStr,
          p.eventDate,
          getWeekStart(profileId)
        ),
      };
    });
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

// ── The event page (#3285 item 2): plan, day and result in one place ─────────────

// One activity as the event page lists it: the day's sessions, each saying whether
// it is linked, and any linked session (a link made on the event's day survives the
// day being edited afterwards, so the linked set is read by link and not by date).
export interface EventDayActivity {
  id: number;
  date: string;
  type: string;
  title: string;
  distanceKm: number | null;
  durationMin: number | null;
  workoutType: string | null;
  linked: boolean;
  // Already the result of a DIFFERENT event of the profile's — same day, two
  // events. An activity is the result of at most one event, so linking it here
  // MOVES it; the row says so rather than letting the tap take it silently.
  linkedElsewhere: boolean;
}

export interface EventDay {
  plan: EndurancePlan;
  // This event's result first, then the day's FREE sessions, then any session
  // already linked to another event — the offer nearest to "yours" first and the
  // one that would take a result off another event last.
  activities: EventDayActivity[];
}

// Profile-scoped; undefined when the plan is not the profile's.
//
// DRAFTS DO NOT APPEAR (#3056 / #3189–#3191), for the reason every sibling reader
// applies the same rule: a create-at-start session that logged nothing is an address,
// not an entry — and this list is one tap from making one the event's RESULT. The
// rule is not restated in SQL; the query gathers the draft-candidate columns
// `isDraftActivityRow` already reads off a row, and the fold applies THAT function.
// Still ONE prepared statement — the "has any set" half folds on as a correlated
// EXISTS (`idx_sets_activity` serves it). `getWorkoutPresence` is the census's ONE
// argued exception and this is not it: the dock keeps the husk so a live session can
// be finished or discarded, while an event's result is a thing that was done.
export function getEventDay(
  profileId: number,
  planId: number
): EventDay | undefined {
  const plan = getEndurancePlan(profileId, planId);
  if (!plan) return undefined;
  const rows = db
    .prepare(
      `SELECT a.id, a.date, a.type, a.title, a.distance_km, a.duration_min,
              a.workout_type, a.endurance_plan_id,
              a.start_time, a.end_time, a.components, a.notes, a.source,
              EXISTS (
                SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
              ) AS has_sets
         FROM activities a
        WHERE a.profile_id = ? AND (a.date = ? OR a.endurance_plan_id = ?)
        ORDER BY CASE WHEN a.endurance_plan_id = ? THEN 0
                      WHEN a.endurance_plan_id IS NULL THEN 1
                      ELSE 2 END,
                 a.date ASC, a.start_time ASC, a.id ASC`
    )
    .all(profileId, plan.eventDate, plan.id, plan.id) as (DraftCandidateRow & {
    id: number;
    date: string;
    type: string;
    title: string;
    distance_km: number | null;
    workout_type: string | null;
    endurance_plan_id: number | null;
    /** 0 or 1 — the draft rule only asks whether ANY set exists (`setCount > 0`). */
    has_sets: number;
  })[];
  return {
    plan,
    activities: rows
      .filter((r) => !isDraftActivityRow(r, r.has_sets))
      .map((r) => ({
        id: r.id,
        date: r.date,
        type: r.type,
        title: r.title,
        distanceKm: r.distance_km,
        durationMin: r.duration_min,
        workoutType: r.workout_type,
        linked: r.endurance_plan_id === plan.id,
        linkedElsewhere:
          r.endurance_plan_id != null && r.endurance_plan_id !== plan.id,
      })),
  };
}
