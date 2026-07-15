import type { ReactNode } from "react";
import { IconFlask, IconScale } from "@tabler/icons-react";
import { today } from "@/lib/db";
import {
  getGoals,
  getGoalProgressMap,
  getFrequencyTargetProgress,
  getBodyMetricDailySeries,
  getMedicalRecords,
  getScheduledAppointments,
  gatherCoachingInput,
  getFindingSuppressions,
  collectAttentionModel,
  attentionCountForProfile,
  getHealthspanPillars,
} from "@/lib/queries";
import { recommendCoaching } from "@/lib/coaching";
import { collectCoachingFindings } from "@/lib/rule-findings";
import { pickNextAppointment } from "@/lib/household";
import { isGoalLive } from "@/lib/goals";
import { activeByKey, activeFindings, coachingDedupeKey } from "@/lib/findings";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { withAiLogContext } from "@/lib/ai-log";
import { runRecommendation } from "@/lib/recommendation-engine";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getDashboardLayout, getUnitPrefs } from "@/lib/settings";
import { dispWeight } from "@/lib/units";
import { shiftDateStr } from "@/lib/date";
import { ALL_ROWS } from "@/lib/trends";
import { formatLongDate, daysRemainingLabel } from "@/lib/format-date";
import { recentLabHighlights } from "@/lib/recent-labs";
import { getWeeklyRecap } from "@/lib/notifications/weekly-recap-data";
import { resolveWidgetList } from "@/lib/dashboard-widgets";
import { PageHeader } from "@/components/ui";
import DashboardGrid, {
  type GridWidget,
} from "@/components/dashboard/DashboardGrid";
import NeedsAttentionHero from "@/components/dashboard/NeedsAttentionHero";
import HouseholdStrip, {
  type HouseholdStripEntry,
} from "@/components/dashboard/HouseholdStrip";
import WidgetEmpty from "@/components/dashboard/WidgetEmpty";
import WeightTrendWidget from "@/components/dashboard/WeightTrendWidget";
import GoalsHabitsWidget from "@/components/dashboard/GoalsHabitsWidget";
import CoachingWidget from "@/components/dashboard/CoachingWidget";
import CoachingObservations from "@/components/dashboard/CoachingObservations";
import WeeklyRecapWidget from "@/components/dashboard/WeeklyRecapWidget";
import RecentLabsWidget, {
  type RecentLabRow,
} from "@/components/dashboard/RecentLabsWidget";
import NextAppointmentWidget, {
  type NextAppointment,
} from "@/components/dashboard/NextAppointmentWidget";
import HealthspanPillarsWidget from "@/components/dashboard/HealthspanPillarsWidget";
import { saveDashboardLayout } from "./actions";

export const dynamic = "force-dynamic";

// Trailing window for the dashboard weight-trend glance (#395): a deliberate date
// window, not a row cap, so the widget matches the full deduped Body-tab series it
// links to instead of silently truncating at N readings.
const WEIGHT_TREND_WINDOW_DAYS = 90;

export default async function Dashboard() {
  const { login, profile } = await requireSession();
  // Age-restricted profiles don't see the fitness surfaces (Training, AI
  // Insights), so their fitness dashboard widgets are dropped by the registry
  // merge (see lib/dashboard-widgets.ts / lib/age-gate.ts).
  const restricted = isTrainingRestricted(profile.id);
  const on = today(profile.id);
  const units = getUnitPrefs(login.id);

  // Lazy scheduled AI recommendation run (issue #424). The dashboard is the
  // natural landing surface, so it's where a due scheduled run kicks off —
  // fire-and-forget, never blocking render, and a hard no-op unless the profile's
  // cadence is a calendar one AND its period has elapsed AND the inputs changed.
  // Wrapped in the AI-log context so the run's events carry the acting ids.
  void withAiLogContext({ loginId: login.id, profileId: profile.id }, () =>
    runRecommendation(profile.id, { trigger: "scheduled", loginId: login.id })
  );

  // Tier 1 — the "Needs attention" hero. Pinned + non-hideable, so it's computed
  // unconditionally (outside the customizable grid). Renders the act-now SUBSET of
  // the ONE unified attention model (lib/attention.ts) the Upcoming page renders in
  // full — a strict subset, so the two surfaces always reconcile (issue #524). The
  // model shares its underlying reads with the Telegram digest and the Upcoming list.
  const attention = collectAttentionModel(profile.id, on);

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
          .filter((entry) => entry.count > 0)
      : [];

  // Resolve the eligible widget set (visible + hidden) for this profile first,
  // then fetch only the data those widgets need — a net win over the old
  // unconditional fetching. Every eligible widget is rendered server-side so
  // Customize mode can preview/re-enable a hidden one without a round-trip.
  const list = resolveWidgetList(getDashboardLayout(profile.id), restricted);
  const eligible = new Set(list.map((w) => w.def.id));
  const has = (id: string) => eligible.has(id);

  // weight-trend: the deduped one-source-per-day series (getBodyMetricDailySeries,
  // #14/#395) — NOT raw all-source rows, which double back the line on a two-device
  // day and disagree with the Body tab this widget links to. Windowed by DATE
  // (a deliberate trailing-90-day glance) rather than the old undisclosed 60-row cap.
  const weightTrendSince = shiftDateStr(on, -(WEIGHT_TREND_WINDOW_DAYS - 1));
  const bodyMetrics = has("weight-trend")
    ? getBodyMetricDailySeries(profile.id, "weight", ALL_ROWS)
        .filter((p) => p.date >= weightTrendSince)
        .map((p) => ({
          date: p.date,
          value: dispWeight(p.value, units.weightUnit),
        }))
    : [];

  // healthspan-pillars (issue #161): the visible longevity pillars, each consuming
  // its already-merged source computation. buildPillars omits an absent pillar, so
  // an empty array means no pillar has data yet (the data-aware CTA below).
  const pillars = has("healthspan-pillars")
    ? getHealthspanPillars(profile.id)
    : [];

  // recent-labs (medical): the current reading per lab/biomarker marker, flagged
  // markers surfaced first so an out-of-range result is the headline. Selection
  // policy is the shared recentLabHighlights (issue #313).
  let labRows: RecentLabRow[] = [];
  if (has("recent-labs")) {
    labRows = recentLabHighlights(
      getMedicalRecords(profile.id, { current: true })
    );
  }

  // next-appointment (medical): the single most attention-worthy scheduled visit,
  // via the SHARED pickNextAppointment (issue #303 — the dashboard hero and the
  // household card must answer "the profile's next appointment" identically). Its
  // policy is overdue-first: a still-scheduled past visit outranks a future one.
  let nextAppt: NextAppointment | null = null;
  let hasScheduledAppt = false;
  if (has("next-appointment")) {
    // getScheduledAppointments already orders by scheduled_at ASC, id ASC, so the
    // picker's same-day tie-break lands on the earliest slot — matching the household
    // card, which feeds the same source ordering.
    const scheduled = getScheduledAppointments(profile.id).map((a) => ({
      appt: a,
      dueDate: a.scheduled_at.slice(0, 10),
    }));
    hasScheduledAppt = scheduled.length > 0;
    const soonest = pickNextAppointment(scheduled)?.appt;
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

  // goals-and-habits: one combined overview of outcomes + weekly behaviors.
  const goals = has("goals-habits")
    ? getGoals(profile.id)
        .filter((g) => isGoalLive(g))
        .slice(0, 4)
    : [];
  const goalProgress = has("goals-habits")
    ? getGoalProgressMap(profile.id, goals)
    : new Map();

  const freqTargets = has("goals-habits")
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

  // coaching-observations (#449): the dashboard rollup of the four #45 tab-only
  // observational domains. ONE computation (collectCoachingFindings) feeds this and
  // the tabs, filtered through the SAME findings-bus store as everything else — so a
  // dismiss here (or on a tab) drops the finding out for free. No push, no hero slot.
  const coachingObservations = has("coaching-observations")
    ? activeFindings(
        collectCoachingFindings(profile.id, on, units.weightUnit),
        getFindingSuppressions(profile.id),
        on
      )
    : [];

  // weekly-recap — the last seven days, rule-based (no AI). Same gather as the
  // weekly notification, so the card and the digest always agree.
  const weeklyRecap = has("weekly-recap")
    ? getWeeklyRecap(profile.id, units.weightUnit)
    : null;

  // Data-aware empty set (issue #171): a data-aware widget whose domain has no data
  // yet renders an onboarding CTA instead of a blank card. Computed from the same
  // reads the widget consumes, so the CTA shows exactly when the widget would be
  // empty.
  const emptyIds = new Set<string>();
  if (has("recent-labs") && labRows.length === 0) emptyIds.add("recent-labs");
  if (has("weight-trend") && bodyMetrics.length === 0)
    emptyIds.add("weight-trend");
  if (has("healthspan-pillars") && pillars.length === 0)
    emptyIds.add("healthspan-pillars");

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
      case "healthspan-pillars":
        return (
          <WidgetEmpty
            title="Healthspan pillars"
            icon={IconFlask}
            message="No pillar data yet. Import labs, log sleep, or record a VO₂ Max to light up your longevity signals."
            ctaLabel="Import health data"
            ctaHref="/data"
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
      case "recent-labs":
        return <RecentLabsWidget rows={labRows} today={on} />;
      case "next-appointment":
        return <NextAppointmentWidget appointment={nextAppt} />;
      case "healthspan-pillars":
        return <HealthspanPillarsWidget pillars={pillars} />;
      case "weight-trend":
        return (
          <WeightTrendWidget data={bodyMetrics} weightUnit={units.weightUnit} />
        );
      case "goals-habits":
        return (
          <GoalsHabitsWidget
            goals={goals}
            goalProgress={goalProgress}
            freqTargets={freqTargets}
            today={on}
          />
        );
      case "coaching":
        return <CoachingWidget recs={coachingRecs} />;
      case "coaching-observations":
        return coachingObservations.length ? (
          <CoachingObservations findings={coachingObservations} />
        ) : null;
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
    // `visible` is only the saved user preference. Availability is transient and
    // must not leak into DashboardGrid's persisted hidden-id set.
    visible,
    available:
      (def.id !== "next-appointment" || hasScheduledAppt) &&
      (def.id !== "coaching-observations" || coachingObservations.length > 0) &&
      (def.id !== "weekly-recap" || weeklyRecap !== null),
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
        <NeedsAttentionHero items={attention} today={on} />
      </div>
      <HouseholdStrip entries={householdEntries} />
      <DashboardGrid
        key={profile.id}
        widgets={gridWidgets}
        saveAction={saveDashboardLayout}
      />
    </div>
  );
}
