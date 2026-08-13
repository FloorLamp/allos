// Active goals with a target date (reuses getOutcomeGoals). The deadline drives the
// band, so an overdue deadline reads as Overdue and an approaching one as
// Today/This week/Later. Goals live on the Training hub's Goals tab — the old
// standalone /goals route has no page (issue #283 found the dead link).
export function goalItems(profileId: number): UpcomingItem[] {
  return getOutcomeGoals(profileId)
    .filter((g) => isGoalLive(g) && g.target_date)
    .map((g) => ({
      key: `goal:${g.id}`,
      domain: "goal" as const,
      title: g.title,
      // Named by the goal's own KIND, so an exercise-linked goal and a freeform one
      // with the same title are told apart, and the band stops mixing "Goal
      // deadline" with a raw user-cased word (#2615 item 4).
      detail: goalUpcomingDetail(g),
      href: "/training?tab=goals",
      dueDate: g.target_date,
    }));
}

// What an unmet weekly FLOOR target IS on the Upcoming page, per scope kind (#2578).
//
// `frequency_targets` is scope-generic machinery, and reading a row's presence in it
// as "a training target" put "Berries — Weekly training target" on the live page with
// a barbell glyph and a /training link. The scope is what the row is ABOUT, so the
// scope decides the identity: the domain (which picks the row's glyph), the honest
// detail line, and a destination that actually holds the target. Identity, not
// filtering — every one of these targets belongs on the page.
//
// Two scope kinds declare `null` — this builder renders no row for them — and
// neither is an omission:
//   • `practice` — wellness practices get their OWN pace-aware item (practiceItems),
//     with the distinct `practice:` key namespace and a ceiling-aware due-text.
//   • `substance` — a `cap`-direction tenant of the cadence ledger, so it never
//     reaches a floor reader at all (#998's anti-nudge rule, stated positively in
//     getFrequencyTargetProgress). A cap target must never be rendered "3 to go".
//
// Total over FrequencyScopeKind on purpose (the CADENCE_SCOPES discipline): an eighth
// scope kind is a compile error here rather than a silent fall-through back into the
// training identity, which is exactly how food_group and mobility_region got one.
//
// The KEY is unchanged for every scope: `trainingSignalKey` is keyed on the target
// id, is shared with the workout nudge's suppression bus (#245), and every stored
// dismissal in `upcoming_dismissals` uses it. Identity is what was wrong; the key was
// never wrong, so re-keying would only orphan dismissals.
const WEEKLY_TARGET_IDENTITY: Record<
  FrequencyScopeKind,
  { domain: UpcomingDomain; detail: string; href: AppRoute } | null
> = {
  region: {
    domain: "training",
    detail: "Weekly training target",
    href: "/training",
  },
  group: {
    domain: "training",
    detail: "Weekly training target",
    href: "/training",
  },
  type: {
    domain: "training",
    detail: "Weekly training target",
    href: "/training",
  },
  // A food-group serving target (#579/#580). It lives on the Nutrition Food tab's
  // weekly-habits card, which is where its progress, its trend strip and its untrack
  // control are — /training holds nothing about it.
  food_group: {
    domain: "nutrition-target",
    detail: "Weekly nutrition target",
    href: nutritionTabHref("food"),
  },
  // A mobility-region habit (#840). It DOES live on the Training hub (the mobility
  // card), so the href is right and only the identity was wrong: mobilizing a region
  // is not training it — that distinction is the whole reason the `mobility_region`
  // scope exists beside `region` (#482).
  mobility_region: {
    domain: "mobility-target",
    detail: "Weekly mobility target",
    href: "/training",
  },
  practice: null,
  substance: null,
};

// The weekly FLOOR targets the Upcoming page is ABOUT, before the unmet filter:
// everything getFrequencyTargetProgress reports, minus the wellness-practice scope
// (which has its own pace-aware item) and minus the deload-softened region/group
// scopes. Factored out so the count line's denominator and the items themselves are
// drawn from the SAME set — a "2 of 4 on pace" whose 4 didn't match what the page
// lists would be a second definition of "your weekly targets" (#221).
function weeklyFloorTargets(profileId: number): FrequencyTargetProgress[] {
  // Deload-week softening (#741): the mesocycle's deload week is SUPPOSED to be
  // lighter, so a region/group frequency target being "behind" isn't a real gap —
  // suppress those findings that week (decided in the ONE gather; type targets like
  // cardio still surface). Same flag every deload surface reads.
  const deload =
    getRoutineCycleStatus(profileId, today(profileId))?.isDeloadWeek ?? false;
  return (
    getFrequencyTargetProgress(profileId)
      // Every scope kind WEEKLY_TARGET_IDENTITY declares a row for. `practice` is the
      // one this drops (it has its own pace-aware item); `substance` never arrives
      // here at all, because getFrequencyTargetProgress is floor-direction only.
      .filter((p) => weeklyTargetIdentity(p) !== null)
      .filter(
        (p) =>
          !(
            deload &&
            (p.target.scope_kind === "region" ||
              p.target.scope_kind === "group")
          )
      )
  );
}

function weeklyTargetIdentity(p: FrequencyTargetProgress) {
  return WEEKLY_TARGET_IDENTITY[p.target.scope_kind as FrequencyScopeKind];
}

// The morning digest's weekly-progress line (#1819 item 4): "2 of 3 training targets
// on pace — behind on Back, Chest", or null for a profile with no weekly TRAINING
// targets (and for an age-restricted one, mirroring the items).
//
// Scoped to the `training` domain's own targets since #2578, and that is what keeps
// the invariant rather than breaking it. The digest applies this phrase in place of a
// band's per-domain count, so its denominator has to be the set of rows that count
// covers — and those rows are the `training`-domain ones. Before the identity split
// the phrase said "4 training targets" over a set that included berries; counting
// them here now would say "3" over a band holding 2. The nutrition and mobility rows
// are counted plainly by their own domains in the same band, which is honest and
// costs no new digest surface.
export function trainingPaceLine(profileId: number): string | null {
  if (isTrainingRestricted(profileId)) return null;
  return weeklyTargetPaceLine(
    weeklyFloorTargets(profileId)
      .filter((p) => weeklyTargetIdentity(p)?.domain === "training")
      .map((p) => ({
        label: frequencyScopeLabel(p.target.scope_kind, p.target.scope_value),
        pace: p.pace,
      }))
  );
}

// Unmet weekly frequency targets (reuses getFrequencyTargetProgress). Hidden for
// age-restricted profiles, mirroring the Training surface. A weekly concern, so
// each unmet target sits in This week with a progress due-text. The row's domain,
// detail and destination come from its SCOPE (WEEKLY_TARGET_IDENTITY, #2578) — a
// food-group target is not a training target with a barbell on it.
export function trainingItems(profileId: number): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  return weeklyFloorTargets(profileId)
    .filter((p) => !p.met)
    .map((p) => {
      const identity = weeklyTargetIdentity(p)!;
      return {
        key: trainingSignalKey(p.target.id),
        domain: identity.domain,
        title: frequencyScopeLabel(p.target.scope_kind, p.target.scope_value),
        detail: identity.detail,
        href: identity.href,
        dueDate: null,
        band: "week" as const,
        dueText: `${p.count}/${p.per_week} this week`,
      };
    });
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
// a tampered id for another profile answers `not-found`.
//
// A changes-checked LIFECYCLE transition (#2140): the guard read and the CAS share
// one writeTx (lib/tx.ts), with the read status as the swap's expectation, so a
// forged id and a stale tap on an item meanwhile closed each get a typed outcome
// instead of an unconditional confirm. Only an OPEN item (isCarePlanItemOpen — the
// same predicate that decides whether the surface offers the tap) transitions;
// a closed one reports the status that actually persists.
export function markCarePlanItemDone(
  profileId: number,
  id: number
): CarePlanDoneOutcome {
  return writeTx((tx) => {
    const row = readForUpdate<{ status: string | null }>(
      tx,
      db.prepare(
        "SELECT status FROM care_plan_items WHERE id = ? AND profile_id = ?"
      ),
      id,
      profileId
    );
    if (!row) return { kind: "not-found" };
    if (!isCarePlanItemOpen(row.status))
      return { kind: "already-closed", status: row.status! };
    casUpdate(
      tx,
      db.prepare(
        "UPDATE care_plan_items SET status = 'completed' WHERE id = ? AND profile_id = ? AND status IS ?"
      ),
      id,
      profileId,
      row.status
    );
    return { kind: "completed" };
  });
}
import { isTrainingRestricted } from "../../age-gate";
import {
  carePlanUpcomingItems,
  isCarePlanItemOpen,
  type CarePlanDoneOutcome,
} from "../../care-plan-upcoming";
import { db, today, writeTx } from "../../db";
import { casUpdate, readForUpdate } from "../../tx";
import { getActiveEndurancePlans } from "../../endurance-plans";
import { goalUpcomingDetail, isGoalLive } from "../../outcome-goals";
import {
  frequencyScopeLabel,
  weeklyTargetPaceLine,
  type FrequencyScopeKind,
} from "../../frequency-targets";
import { nutritionTabHref, type AppRoute } from "../../hrefs";
import { practiceSignalKey } from "../../practice";
import { getRoutineCycleStatus } from "../../routines";
import type { DistanceUnit } from "../../settings";
import type { UpcomingDomain, UpcomingItem } from "../../upcoming";
import { fmtDistance } from "../../units";
import { trainingSignalKey } from "../../workout-nudge";
import { getOutdoorPlans } from "../weather-training";
import { getCarePlanItems } from "../clinical";
import {
  getFrequencyTargetProgress,
  type FrequencyTargetProgress,
} from "../frequency-targets";
import { getOutcomeGoals } from "../training";
import { getStepsPaceObservation } from "../steps-target";
import { stepsPaceKey } from "../../steps-target";
import { trendsSectionHref } from "../../trends-sections";
