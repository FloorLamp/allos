// Active goals with a target date (reuses getGoals). The deadline drives the
// band, so an overdue deadline reads as Overdue and an approaching one as
// Today/This week/Later. Goals live on the Training hub's Goals tab — the old
// standalone /goals route has no page (issue #283 found the dead link).
export function goalItems(profileId: number): UpcomingItem[] {
  return getGoals(profileId)
    .filter((g) => isGoalLive(g) && g.target_date)
    .map((g) => ({
      key: `goal:${g.id}`,
      domain: "goal" as const,
      title: g.title,
      detail: g.category ? `${g.category} goal` : "Goal deadline",
      href: "/training?tab=goals",
      dueDate: g.target_date,
    }));
}

// Unmet weekly frequency targets (reuses getFrequencyTargetProgress). Hidden for
// age-restricted profiles, mirroring the Training surface. A weekly concern, so
// each unmet target sits in This week with a progress due-text.
export function trainingItems(profileId: number): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  // Deload-week softening (#741): the mesocycle's deload week is SUPPOSED to be
  // lighter, so a region/group frequency target being "behind" isn't a real gap —
  // suppress those findings that week (decided in the ONE gather; type targets like
  // cardio still surface). Same flag every deload surface reads.
  const deload =
    getRoutineCycleStatus(profileId, today(profileId))?.isDeloadWeek ?? false;
  return (
    getFrequencyTargetProgress(profileId)
      .filter((p) => !p.met)
      // Wellness-practice targets (#1259) get their OWN pace-aware item (practiceItems)
      // with the distinct `practice:` key namespace — never mislabeled "Weekly training
      // target" here.
      .filter((p) => p.target.scope_kind !== "practice")
      .filter(
        (p) =>
          !(
            deload &&
            (p.target.scope_kind === "region" ||
              p.target.scope_kind === "group")
          )
      )
      .map((p) => ({
        key: trainingSignalKey(p.target.id),
        domain: "training" as const,
        title: frequencyScopeLabel(p.target.scope_kind, p.target.scope_value),
        detail: "Weekly training target",
        href: "/training",
        dueDate: null,
        band: "week" as const,
        dueText: `${p.count}/${p.per_week} this week`,
      }))
  );
}

// The outdoor-session PLANNING item (#1724 part 5) — Upcoming is the planning surface,
// so this is where "Saturday is the best window for your ride" lives; the digest's
// This-week line renders the SAME `planningLine` computation as a glance (#221).
//
// CALM by construction: banded to `week` (never Today, never the hero), no due date, and
// it only appears when outdoor viability is genuinely SCARCE — a week where every day
// works produces nothing, and a week where NO day works produces nothing either, because
// there is no session to recommend and nagging about weather nobody can change is the
// escalation the attention doctrine forbids. ZERO NEW SENDS: this is a page item, and the
// digest line rides the morning message that already goes out.
//
// Dismissible through the shared bus, keyed per (activity, week start), so declining
// this week's plan never silences next week's.
export function outdoorPlanItems(profileId: number): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  return getOutdoorPlans(profileId, today(profileId)).map((plan) => ({
    key: plan.dedupeKey,
    domain: "training" as const,
    title: `Best window for your ${plan.activity.toLowerCase()} this week`,
    detail: plan.line,
    href: "/training",
    dueDate: null,
    band: "week" as const,
    dueText: "Plan",
  }));
}

// Wellness-practice weekly targets running BEHIND their floor (#1259). The calm,
// coaching-tier twin of the Telegram practice nudge — SAME `practice:<id>` key so a
// dismissal here silences the push (the #227 workout-nudge bus pattern). Only surfaces a
// target that is behind pace AND not at/above its ceiling: on-track or "that's plenty"
// weeks stay quiet. A weekly concern, so it sits in the This-week band with a progress
// due-text (a range shows the ceiling: "2/3–5 this week"). Reuses getFrequencyTargetProgress
// (one computation); hidden for age-restricted profiles, mirroring the Training surface.
export function practiceItems(profileId: number): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  return getFrequencyTargetProgress(profileId)
    .filter((p) => p.target.scope_kind === "practice")
    .filter((p) => !p.met && !p.atCeiling && p.pace === "behind")
    .map((p) => ({
      key: practiceSignalKey(p.target.id),
      domain: "practice" as const,
      title: p.target.scope_value,
      detail: "Weekly practice target",
      href: "/wellness",
      dueDate: null,
      band: "week" as const,
      practiceTargetId: p.target.id,
      dueText:
        p.per_week_max != null && p.per_week_max > p.per_week
          ? `${p.count}/${p.per_week}–${p.per_week_max} this week`
          : `${p.count}/${p.per_week} this week`,
    }));
}

// The daily-step afternoon presence (#1723 part 2). RIDE-THE-NAG, not a new send:
// this is one calm Upcoming row, which means it also appears in every surface that
// already formats collectUpcoming — the Upcoming page, the dashboard bands, and any
// message built from that aggregation. NO dedicated step nudge exists or is created;
// the doctrine default (the system may reduce contact unilaterally, never increase
// it) holds, and a later owner decision is what it would take to change that.
//
// Calm by construction: no due date, `should`-tier semantics (counted, never
// escalated), dismissible through the shared bus like any other finding, and keyed
// per DAY so a dismissal silences today's observation and tomorrow starts clean.
// Silent by default — see getStepsPaceObservation for the five ways it says nothing,
// including the stale-data case that stops a late sync batch manufacturing a verdict.
export function stepsPaceItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  const obs = getStepsPaceObservation(profileId, today);
  if (!obs) return [];
  return [
    {
      key: stepsPaceKey(obs.date),
      domain: "training" as const,
      title: "Steps today",
      detail: obs.detail,
      href: trendsSectionHref("body"),
      dueDate: null,
      band: "today" as const,
      dueText: "Today",
    },
  ];
}

// Endurance event days (#839): each active plan's event as a dated forward-looking item,
// so the EVENT DAY rides the Upcoming page + the calendar feed (domain "training" is a
// FeedCategory). Hidden for age-restricted profiles, mirroring the Training surface. The
// key namespace is DISTINCT from the coaching long-session finding prefix ("endurance:"),
// so the event marker and the calm long-session nudge never collide. Not suppressible — a
// dated event is a hard commitment, not a dismissable nudge.
// `distanceUnit` is the viewer's display unit (#1019): the web boundary threads
// the login's pref; login-less callers — calendar feed, digest — default to
// canonical km. The `key` is unit-independent, so suppression identity never shifts.
export function enduranceEventItems(
  profileId: number,
  today: string,
  distanceUnit: DistanceUnit = "km"
): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  return getActiveEndurancePlans(profileId)
    .filter((p) => p.eventDate >= today)
    .map((p) => {
      const disc =
        p.discipline === "run"
          ? "Run"
          : p.discipline === "ride"
            ? "Ride"
            : "Swim";
      const dist = fmtDistance(p.targetDistanceKm, distanceUnit);
      const name = p.eventName?.trim() || `${dist} ${disc}`;
      return {
        key: `endurance-event:${p.id}`,
        domain: "training" as const,
        title: `Event: ${name}`,
        detail: `${disc} · ${dist}`,
        href: "/training" as const,
        dueDate: p.eventDate,
        suppressible: false,
      };
    });
}

// Provider-ordered / manually-entered care-plan items with a planned date (issue
// #84). Reuses getCarePlanItems (profile-scoped read) and the pure adapter, which
// keeps only OPEN (non-completed/cancelled) DATED items and bands them by their
// real planned_date. Each carries its row id for the inline "Mark done" form.
// NOTE (v1): no dedup yet against the preventive-care engine — an ordered
// colonoscopy and a catalog "colorectal screening due" can both appear; the issue
// punts that to a follow-up.
export function carePlanItems(profileId: number): UpcomingItem[] {
  // Exclude LINKED follow-ups (source_kind set, #700) — those are surfaced by the
  // dedicated care-tier followUpItems builder (legible + resolution-aware), so the
  // generic careplan generator handles only the plain planned-care lines. Without
  // this filter a tracked follow-up would double-surface (careplan + followup).
  return carePlanUpcomingItems(
    getCarePlanItems(profileId).filter((c) => c.source_kind == null)
  );
}

// Mark a care-plan item completed (issue #84) — the write behind the Upcoming
// "Mark done" fast path. Sets status = 'completed' so the pure adapter drops it
// from the due-list on the next read. Profile-scoped (WHERE id AND profile_id), so
// a tampered id for another profile is a no-op.
export function markCarePlanItemDone(profileId: number, id: number): void {
  db.prepare(
    "UPDATE care_plan_items SET status = 'completed' WHERE id = ? AND profile_id = ?"
  ).run(id, profileId);
}
import { isTrainingRestricted } from "../../age-gate";
import { carePlanUpcomingItems } from "../../care-plan-upcoming";
import { db, today } from "../../db";
import { getActiveEndurancePlans } from "../../endurance-plans";
import { frequencyScopeLabel, isGoalLive } from "../../goals";
import { practiceSignalKey } from "../../practice";
import { getRoutineCycleStatus } from "../../routines";
import type { DistanceUnit } from "../../settings";
import type { UpcomingItem } from "../../upcoming";
import { fmtDistance } from "../../units";
import { trainingSignalKey } from "../../workout-nudge";
import { getOutdoorPlans } from "../weather-training";
import { getCarePlanItems } from "../clinical";
import { getFrequencyTargetProgress } from "../frequency-targets";
import { getGoals } from "../training";
import { getStepsPaceObservation } from "../steps-target";
import { stepsPaceKey } from "../../steps-target";
import { trendsSectionHref } from "../../trends-sections";
