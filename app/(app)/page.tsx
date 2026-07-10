import type { ReactNode } from "react";
import {
  IconFlask,
  IconCalendarEvent,
  IconClipboardList,
  IconScale,
  IconBarbell,
} from "@tabler/icons-react";
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
  getMedicalRecords,
  getScheduledAppointments,
  getCarePlanItems,
  gatherCoachingInput,
  getFindingSuppressions,
  collectAttention,
  attentionCountForProfile,
} from "@/lib/queries";
import { recommendCoaching } from "@/lib/coaching";
import { activeByKey, coachingDedupeKey } from "@/lib/findings";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
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
import { formatLongDate, daysRemainingLabel } from "@/lib/format-date";
import { currentStreak, flexibleStreak } from "@/lib/streak";
import { daysOfSupplyLeft, isLowSupply } from "@/lib/refill";
import { bandForItem, upcomingDueText } from "@/lib/upcoming";
import { carePlanUpcomingItems } from "@/lib/care-plan-upcoming";
import { getWeeklyRecap } from "@/lib/notifications/weekly-recap-data";
import { resolveWidgetList } from "@/lib/dashboard-widgets";
import { PageHeader } from "@/components/ui";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import DashboardGrid, {
  type GridWidget,
} from "@/components/dashboard/DashboardGrid";
import NeedsAttentionHero from "@/components/dashboard/NeedsAttentionHero";
import HouseholdStrip, {
  type HouseholdStripEntry,
} from "@/components/dashboard/HouseholdStrip";
import WidgetEmpty from "@/components/dashboard/WidgetEmpty";
import QuickStatsWidget from "@/components/dashboard/QuickStatsWidget";
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
import RecentLabsWidget, {
  type RecentLabRow,
} from "@/components/dashboard/RecentLabsWidget";
import NextAppointmentWidget, {
  type NextAppointment,
} from "@/components/dashboard/NextAppointmentWidget";
import CarePlanDueWidget, {
  type CarePlanDueRow,
} from "@/components/dashboard/CarePlanDueWidget";
import { saveDashboardLayout } from "./actions";

export const dynamic = "force-dynamic";

// Lab-ish medical categories the Recent labs widget surfaces (parity with the
// Upcoming retest signal): actual labs/biomarkers, not vitals/scans/prescriptions.
const LAB_CATEGORIES = new Set(["lab", "biomarker"]);

export default async function Dashboard() {
  const { login, profile } = await requireSession();
  // Age-restricted profiles don't see the fitness surfaces (Training, AI
  // Insights), so their fitness dashboard widgets are dropped by the registry
  // merge (see lib/dashboard-widgets.ts / lib/age-gate.ts).
  const restricted = isTrainingRestricted(profile.id);
  const on = today(profile.id);
  const units = getUnitPrefs(login.id);

  // Tier 1 — the "Needs attention" hero. Pinned + non-hideable, so it's computed
  // unconditionally (outside the customizable grid). Renders the merged, severity-
  // ordered attention model that shares its underlying reads with the Telegram
  // digest and the Upcoming list — one source of truth (issue #171).
  const attention = collectAttention(profile.id, on);

  // Tier 2 — the household strip. A caregiver reaching 2+ profiles gets a per-
  // profile attention count for their OTHER profiles (same gate as the Household
  // nav entry). Bounded work: a household is a handful of profiles, each count a
  // few profile-scoped reads. Grants are respected — getAccessibleProfiles returns
  // only reachable profiles, and the switch action re-checks.
  const accessible = await getAccessibleProfiles();
  const householdEntries: HouseholdStripEntry[] =
    accessible.length > 1
      ? accessible
          .filter((p) => p.id !== profile.id)
          .map((p) => ({
            profile: p,
            count: attentionCountForProfile(p.id, today(p.id)),
          }))
      : [];

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

  // recent-labs (medical): the current reading per lab/biomarker marker, flagged
  // markers surfaced first so an out-of-range result is the headline.
  let labRows: RecentLabRow[] = [];
  if (has("recent-labs")) {
    labRows = getMedicalRecords(profile.id, { current: true })
      .filter((r) => LAB_CATEGORIES.has(r.category))
      .slice()
      .sort((a, b) => {
        const af = a.flag && a.flag !== "normal" ? 0 : 1;
        const bf = b.flag && b.flag !== "normal" ? 0 : 1;
        return af - bf || b.date.localeCompare(a.date);
      })
      .slice(0, 6)
      .map((r) => {
        const name = r.canonical_name?.trim() || r.name;
        return {
          name,
          value: r.value,
          unit: r.unit,
          flag: r.flag,
          date: r.date,
          href: r.canonical_name?.trim()
            ? `/biomarkers/view?name=${encodeURIComponent(name)}`
            : "/biomarkers",
        };
      });
  }

  // next-appointment (medical): the soonest scheduled visit — a future one if any,
  // else the most-recent still-scheduled (missed) one worth chasing.
  let nextAppt: NextAppointment | null = null;
  let hasScheduledAppt = false;
  if (has("next-appointment")) {
    const scheduled = getScheduledAppointments(profile.id)
      .slice()
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    hasScheduledAppt = scheduled.length > 0;
    const soonest =
      scheduled.find((a) => a.scheduled_at.slice(0, 10) >= on) ??
      scheduled[scheduled.length - 1];
    if (soonest) {
      const d = soonest.scheduled_at.slice(0, 10);
      const detailParts = [soonest.provider_name, soonest.location].filter(
        Boolean
      );
      nextAppt = {
        title: soonest.title?.trim() || soonest.provider_name || "Appointment",
        whenLabel: formatLongDate(d),
        dueText: daysRemainingLabel(d, on) ?? d,
        detail: detailParts.length ? detailParts.join(" · ") : null,
      };
    }
  }

  // care-plan-due (medical): open, dated provider-ordered items, soonest first.
  let carePlanRows: CarePlanDueRow[] = [];
  if (has("care-plan-due")) {
    carePlanRows = carePlanUpcomingItems(getCarePlanItems(profile.id))
      .slice()
      .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
      .slice(0, 4)
      .map((it) => ({
        key: it.key,
        title: it.title,
        detail: it.detail ?? null,
        dueText: upcomingDueText(it, on),
        overdue: bandForItem(it, on) === "overdue",
      }));
  }

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

  // Data-aware empty set (issue #171): a data-aware widget whose domain has no data
  // yet renders an onboarding CTA instead of a blank card. Computed from the same
  // reads the widget consumes, so the CTA shows exactly when the widget would be
  // empty.
  const emptyIds = new Set<string>();
  if (has("recent-labs") && labRows.length === 0) emptyIds.add("recent-labs");
  if (has("next-appointment") && !hasScheduledAppt)
    emptyIds.add("next-appointment");
  if (has("care-plan-due") && carePlanRows.length === 0)
    emptyIds.add("care-plan-due");
  if (has("weight-trend") && bodyMetrics.length === 0)
    emptyIds.add("weight-trend");
  if (has("recent-activity") && recent.length === 0)
    emptyIds.add("recent-activity");

  // The onboarding CTA for a data-aware widget whose domain is empty — the
  // dashboard doubling as the setup checklist, each empty widget pointing at the
  // pipeline that fills it.
  function emptyNode(id: string): ReactNode {
    switch (id) {
      case "recent-labs":
        return (
          <WidgetEmpty
            title="Recent labs"
            icon={IconFlask}
            message="No lab results yet. Import a lab report or connect a portal to track your biomarkers."
            ctaLabel="Import labs"
            ctaHref="/data"
          />
        );
      case "next-appointment":
        return (
          <WidgetEmpty
            title="Next appointment"
            icon={IconCalendarEvent}
            message="No appointments scheduled. Add one to see it here and get reminders."
            ctaLabel="Add appointment"
            ctaHref="/appointments"
          />
        );
      case "care-plan-due":
        return (
          <WidgetEmpty
            title="Care plan"
            icon={IconClipboardList}
            message="No care-plan items yet. Import a visit summary to track provider-ordered care."
            ctaLabel="Import records"
            ctaHref="/data"
          />
        );
      case "weight-trend":
        return (
          <WidgetEmpty
            title="Weight trend"
            icon={IconScale}
            message="No weigh-ins yet. Connect Health Connect or log your weight to see the trend."
            ctaLabel="Connect Health Connect"
            ctaHref="/integrations/health-connect"
          />
        );
      case "recent-activity":
        return (
          <WidgetEmpty
            title="Recent activity"
            icon={IconBarbell}
            message="No workouts logged. Connect Health Connect or log a workout to get started."
            ctaLabel="Connect Health Connect"
            ctaHref="/integrations/health-connect"
          />
        );
      default:
        return null;
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
      case "recent-labs":
        return <RecentLabsWidget rows={labRows} />;
      case "next-appointment":
        return <NextAppointmentWidget appointment={nextAppt} />;
      case "care-plan-due":
        return <CarePlanDueWidget items={carePlanRows} />;
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
    node:
      def.dataAware && emptyIds.has(def.id)
        ? emptyNode(def.id)
        : renderWidget(def.id),
  }));

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Today is ${formatLongDate(on)} — here's your health at a glance.`}
      />
      <div className="mb-6">
        <NeedsAttentionHero items={attention} />
      </div>
      <HouseholdStrip entries={householdEntries} />
      <DashboardGrid widgets={gridWidgets} saveAction={saveDashboardLayout} />
    </div>
  );
}
