import type { ReactNode } from "react";
import { today } from "@/lib/db";
import {
  getActivities,
  getActivityDates,
  getDashboardStats,
  getGoals,
  getGoalProgressMap,
  getFrequencyTargetProgress,
  getInsight,
  getSupplementLogsForDate,
  getSupplements,
  getSupplementDoses,
  getWeights,
  getImmunizations,
  getImmunityTiters,
  gatherCoachingInput,
  getFindingSuppressions,
} from "@/lib/queries";
import { recommendCoaching } from "@/lib/coaching";
import { activeByKey, coachingDedupeKey } from "@/lib/findings";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import {
  getDashboardLayout,
  getUnitPrefs,
  getUserBirthdate,
  getUserSex,
  getStoredAge,
} from "@/lib/settings";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import { assessSchedule } from "@/lib/immunization-status";
import { dispWeight } from "@/lib/units";
import { formatLongDate } from "@/lib/format-date";
import { currentStreak, flexibleStreak } from "@/lib/streak";
import { daysOfSupplyLeft, isLowSupply } from "@/lib/refill";
import { buildDigest } from "@/lib/notifications/digest";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { getWeeklyRecap } from "@/lib/notifications/weekly-recap-data";
import { resolveWidgetList } from "@/lib/dashboard-widgets";
import { PageHeader } from "@/components/ui";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import DashboardGrid, {
  type GridWidget,
} from "@/components/dashboard/DashboardGrid";
import QuickStatsWidget from "@/components/dashboard/QuickStatsWidget";
import TodayActionsWidget from "@/components/dashboard/TodayActionsWidget";
import WeightTrendWidget from "@/components/dashboard/WeightTrendWidget";
import TodaysInsightWidget from "@/components/dashboard/TodaysInsightWidget";
import ImmunizationsWidget from "@/components/dashboard/ImmunizationsWidget";
import RecentActivityWidget from "@/components/dashboard/RecentActivityWidget";
import ActiveGoalsWidget from "@/components/dashboard/ActiveGoalsWidget";
import WeeklyRoutineWidget from "@/components/dashboard/WeeklyRoutineWidget";
import CoachingWidget from "@/components/dashboard/CoachingWidget";
import LowSupplyWidget, {
  type LowSupplyItem,
} from "@/components/dashboard/LowSupplyWidget";
import StreakWidget from "@/components/dashboard/StreakWidget";
import WeeklyRecapWidget from "@/components/dashboard/WeeklyRecapWidget";
import { saveDashboardLayout } from "./actions";

export const dynamic = "force-dynamic";

export default function Dashboard() {
  const { login, profile } = requireSession();
  // Age-restricted profiles don't see the fitness surfaces (Training, AI
  // Insights), so their fitness dashboard widgets are dropped by the registry
  // merge (see lib/dashboard-widgets.ts / lib/age-gate.ts).
  const restricted = isTrainingRestricted(profile.id);
  const on = today(profile.id);
  const units = getUnitPrefs(login.id);

  // Resolve the eligible widget set (visible + hidden) for this profile first,
  // then fetch only the data those widgets need — a net win over the old
  // unconditional fetching. Every eligible widget is rendered server-side so
  // Customize mode can preview/re-enable a hidden one without a round-trip.
  const list = resolveWidgetList(getDashboardLayout(profile.id), restricted);
  const eligible = new Set(list.map((w) => w.def.id));
  const has = (id: string) => eligible.has(id);

  // Supplements are shared by quick-stats (taken/total) and low-supply.
  const supplements =
    has("quick-stats") || has("low-supply")
      ? getSupplements(profile.id).filter((s) => s.active)
      : [];

  // quick-stats
  const stats = has("quick-stats") ? getDashboardStats(profile.id) : null;
  const takenToday = has("quick-stats")
    ? getSupplementLogsForDate(profile.id, on)
    : null;

  // today-actions: the pre-built morning-digest model.
  const digest = has("today-actions")
    ? buildDigest(gatherDigestInput(profile.id, profile.name))
    : null;

  // weight-trend
  const bodyMetrics = has("weight-trend")
    ? getWeights(profile.id, 60)
        .slice()
        .reverse()
        .map((w) => ({
          date: w.date,
          value: dispWeight(w.weight_kg, units.weightUnit),
        }))
    : [];

  // todays-insight
  const insight = has("todays-insight")
    ? (getInsight(profile.id, on) ?? null)
    : null;

  // recent-activity
  const recent = has("recent-activity") ? getActivities(profile.id, 6) : [];

  // active-goals
  const goals = has("active-goals")
    ? getGoals(profile.id)
        .filter((g) => g.status === "active" && !g.archived)
        .slice(0, 4)
    : [];
  const goalProgress = has("active-goals")
    ? getGoalProgressMap(profile.id, goals)
    : new Map();

  // weekly-routine
  const freqTargets = has("weekly-routine")
    ? getFrequencyTargetProgress(profile.id)
    : [];

  // coaching: the ranked, rule-based recommendations (deterministic, no AI).
  // Fitness-gated in the registry, so restricted profiles never reach this.
  // Snoozed recommendations (findings bus, #39) drop out here, so a "Not today"
  // on the top rec surfaces the next-ranked one until the snooze expires.
  const coachingRecs = has("coaching")
    ? activeByKey(
        recommendCoaching(
          gatherCoachingInput(profile.id, units.weightUnit, units.distanceUnit)
        ),
        (r) => coachingDedupeKey(r.id),
        getFindingSuppressions(profile.id),
        on
      )
    : [];

  // low-supply: items with a tracked quantity running at/below the threshold.
  // Dosed roughly once per dose row per day (parity with the supplements page).
  let lowSupplyItems: LowSupplyItem[] = [];
  if (has("low-supply")) {
    const doseCount = new Map<number, number>();
    for (const d of getSupplementDoses(profile.id)) {
      doseCount.set(d.supplement_id, (doseCount.get(d.supplement_id) ?? 0) + 1);
    }
    lowSupplyItems = supplements
      .map((s) => ({
        s,
        days: daysOfSupplyLeft(
          s.quantity_on_hand,
          s.qty_per_dose,
          doseCount.get(s.id) ?? 0
        ),
      }))
      .filter((x) => isLowSupply(x.days))
      .map((x) => ({
        id: x.s.id,
        name: x.s.name,
        daysLeft: x.days as number,
        kind: x.s.kind,
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  // streak — headline is the rest-tolerant flexible streak; the strict
  // consecutive-days streak rides along as secondary context.
  const streakDates = has("streak") ? getActivityDates(profile.id) : [];
  const streak = has("streak") ? flexibleStreak(on, streakDates) : 0;
  const strictStreak = has("streak") ? currentStreak(on, streakDates) : 0;

  // weekly-recap — the last seven days, rule-based (no AI). Same gather as the
  // weekly notification, so the card and the digest always agree.
  const weeklyRecap = has("weekly-recap")
    ? getWeeklyRecap(profile.id, units.weightUnit)
    : null;

  // immunizations: next-due / overdue against the schedule. Age comes from the
  // birthdate, or the stored whole-year age fallback when no DOB is set. Skip the
  // work when neither is known (the card then shows a static nudge).
  let immSummary: ReturnType<typeof assessSchedule> | null = null;
  if (has("immunizations")) {
    const immBirthdate = getUserBirthdate(profile.id);
    const immStoredAge = immBirthdate ? null : getStoredAge(profile.id);
    const immAgeMonths = immBirthdate
      ? ageInMonthsFromBirthdate(immBirthdate, on)
      : immStoredAge != null
        ? immStoredAge * 12
        : null;
    if (immAgeMonths != null) {
      immSummary = assessSchedule(
        getImmunizations(profile.id).map((r) => ({
          vaccine: r.vaccine,
          date: r.date,
        })),
        immAgeMonths,
        getUserSex(profile.id),
        on,
        getImmunityTiters(profile.id).map((t) => ({
          marker: t.marker,
          status: t.status,
        }))
      );
    }
  }

  // Map a widget id to its server-rendered node. Kept a plain switch so the
  // registry stays pure (no JSX in lib/).
  function renderWidget(id: string): ReactNode {
    switch (id) {
      case "quick-stats":
        return (
          <QuickStatsWidget
            restricted={restricted}
            last7={stats?.last7 ?? 0}
            activityCount={stats?.activityCount ?? 0}
            latestWeight={stats?.latestWeight ?? null}
            activeGoals={stats?.activeGoals ?? 0}
            takenCount={takenToday?.size ?? 0}
            supplementCount={supplements.length}
            weightUnit={units.weightUnit}
          />
        );
      case "today-actions":
        return <TodayActionsWidget model={digest} />;
      case "starred-biomarkers":
        return <StarredBiomarkers />;
      case "weight-trend":
        return (
          <WeightTrendWidget data={bodyMetrics} weightUnit={units.weightUnit} />
        );
      case "todays-insight":
        return <TodaysInsightWidget insight={insight} />;
      case "immunizations":
        return <ImmunizationsWidget summary={immSummary} />;
      case "recent-activity":
        return <RecentActivityWidget recent={recent} today={on} />;
      case "active-goals":
        return <ActiveGoalsWidget goals={goals} goalProgress={goalProgress} />;
      case "weekly-routine":
        return <WeeklyRoutineWidget freqTargets={freqTargets} />;
      case "coaching":
        return <CoachingWidget recs={coachingRecs} />;
      case "low-supply":
        return <LowSupplyWidget items={lowSupplyItems} />;
      case "streak":
        return <StreakWidget streak={streak} strictStreak={strictStreak} />;
      case "weekly-recap":
        return weeklyRecap ? <WeeklyRecapWidget recap={weeklyRecap} /> : null;
      default:
        return null;
    }
  }

  const gridWidgets: GridWidget[] = list.map(({ def, visible }) => ({
    id: def.id,
    label: def.label,
    span: def.span,
    visible,
    node: renderWidget(def.id),
  }));

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Today is ${formatLongDate(on)} — here's your health at a glance.`}
      />
      <DashboardGrid widgets={gridWidgets} saveAction={saveDashboardLayout} />
    </div>
  );
}
