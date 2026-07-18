import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { IconFlask, IconScale, IconPill } from "@tabler/icons-react";
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
  getPrnMedicationsForQuickLog,
  getActiveProtocolSummaries,
  getWorkoutPresence,
  getSessionRecap,
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
import {
  getDashboardLayout,
  isProfileOrientationDismissed,
  getOnboardingState,
  getUnitPrefs,
  getTimezone,
  getEmergencyCardEnabled,
  getProfileHomeAssistant,
  getProfileTelegram,
} from "@/lib/settings";
import { countPushSubscriptionsForLogin } from "@/lib/notifications/push";
import { hasConnectedDataSource } from "@/lib/integrations/connections";
import { dispWeight } from "@/lib/units";
import { shiftDateStr } from "@/lib/date";
import { ALL_ROWS } from "@/lib/trends";
import { formatLongDate, daysRemainingLabel } from "@/lib/format-date";
import { recentLabHighlights } from "@/lib/recent-labs";
import { getWeeklyRecap } from "@/lib/notifications/weekly-recap-data";
import { resolveWidgetList } from "@/lib/dashboard-widgets";
import { getIllnessHeroUi } from "@/lib/settings";
import { onboardingNeedsSetup } from "@/lib/onboarding";
import { getOnboardingDataPresence } from "@/lib/onboarding-data";
import { PageHeader } from "@/components/ui";
import DashboardGrid, {
  type GridWidget,
} from "@/components/dashboard/DashboardGrid";
import NeedsAttentionHero from "@/components/dashboard/NeedsAttentionHero";
import HouseholdStrip, {
  type HouseholdStripEntry,
} from "@/components/dashboard/HouseholdStrip";
import IllnessHero, {
  type HeroCockpit,
} from "@/components/dashboard/IllnessHero";
import IllnessCockpitBody from "./symptoms/IllnessCockpitBody";
import {
  currentEpisodeForProfile,
  openEpisodeForProfile,
} from "@/lib/illness-episode";
import {
  householdSickLine,
  episodeHeadline,
  orderIllnessCockpits,
  type AssembledEpisode,
} from "@/lib/illness-episode-format";
import { schoolReturnStatusFor } from "@/lib/school-return-data";
import { schoolReturnCompactClause } from "@/lib/school-return";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import WidgetEmpty from "@/components/dashboard/WidgetEmpty";
import SessionRecapCard from "@/components/dashboard/SessionRecapCard";
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
import QuickLogPrnWidget from "@/components/dashboard/QuickLogPrnWidget";
import ActiveProtocolWidget from "@/components/dashboard/ActiveProtocolWidget";
import FeelingSickCard from "@/components/dashboard/FeelingSickCard";
import { hasActiveIllnessSituation } from "@/lib/settings/profile-attrs";
import OnboardingResumeCard from "@/components/dashboard/OnboardingResumeCard";
import OnboardingChecklist from "@/components/dashboard/OnboardingChecklist";
import ProfileOrientationCard from "@/components/dashboard/ProfileOrientationCard";
import { saveDashboardLayout, saveIllnessHeroState } from "./actions";

export const dynamic = "force-dynamic";

// Trailing window for the dashboard weight-trend glance (#395): a deliberate date
// window, not a row cap, so the widget matches the full deduped Body-tab series it
// links to instead of silently truncating at N readings.
const WEIGHT_TREND_WINDOW_DAYS = 90;

export default async function Dashboard() {
  const { login, profile, access } = await requireSession();
  const storedOnboarding = getOnboardingState(profile.id);
  if (access === "write" && storedOnboarding?.status === "not_started") {
    redirect("/onboarding");
  }
  // Age-restricted profiles don't see the fitness surfaces (Training, AI
  // Insights), so their fitness dashboard widgets are dropped by the registry
  // merge (see lib/dashboard-widgets.ts / lib/age-gate.ts).
  const restricted = isTrainingRestricted(profile.id);
  const on = today(profile.id);
  const units = getUnitPrefs(login.id);

  // Finished-window session recap card (#924): while derived workout presence reads
  // `finished`, surface the just-ended session's recap (self-view only). NEVER gated
  // on live mode — a manual fresh-end-time log or a freshness-capped import also
  // enters `finished`. The card feeds off the ONE server-side sessionRecap gather;
  // it disappears when the 60-min window closes on the next render. Skipped for a
  // restricted profile (no training surface). Shown only when there's strength work
  // to recap (a pure-cardio finish has no working sets).
  const finishedPresence = restricted ? null : getWorkoutPresence(profile.id);
  const finishedRecap =
    finishedPresence?.state === "finished" &&
    finishedPresence.activityId != null
      ? getSessionRecap(profile.id, finishedPresence.activityId)
      : null;
  const showRecapCard =
    finishedRecap != null && finishedRecap.totalWorkingSets > 0;

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
  const onboardingState =
    access === "write" && onboardingNeedsSetup(storedOnboarding)
      ? storedOnboarding
      : null;
  const onboardingChecklist =
    storedOnboarding?.status === "complete" &&
    !storedOnboarding.checklistDismissed
      ? storedOnboarding
      : null;
  const onboardingPresence = onboardingState
    ? {
        ...getOnboardingDataPresence(profile.id),
        caregiving: accessible.length > 1,
      }
    : null;
  const onboardingChecklistCompletion = onboardingChecklist
    ? {
        ...getOnboardingDataPresence(profile.id),
        caregiving: accessible.length > 1,
        emergency: getEmergencyCardEnabled(profile.id),
        connectedDataSource: hasConnectedDataSource(profile.id),
        notifications:
          onboardingChecklist.notificationIntent === "none" ||
          getProfileTelegram(profile.id).telegramEnabled ||
          getProfileHomeAssistant(profile.id).enabled ||
          countPushSubscriptionsForLogin(login.id) > 0,
      }
    : null;
  const showOrientation =
    (storedOnboarding === null ||
      (access === "read" && onboardingNeedsSetup(storedOnboarding))) &&
    !isProfileOrientationDismissed(login.id, profile.id);
  const orientationPresence = showOrientation
    ? {
        ...getOnboardingDataPresence(profile.id),
        caregiving: accessible.length > 1,
      }
    : null;
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

  // Illness hero (issue #858): every accessible OPEN illness episode as a per-patient
  // cockpit, over the SAME #801 assembly the timeline/detail/share surfaces use (one
  // question, one computation). The acting profile's own episode is the FULL cockpit at
  // hero position (keyed on an OPEN episode row — hasActiveIllnessSituation — so it appears
  // the instant the #843 door-A "I'm feeling sick" tap activates Illness, before the first
  // symptom); every OTHER accessible profile's open episode (signal-gated
  // currentEpisodeForProfile, so a not-yet-symptomatic member stays off the list) is a
  // compact accordion line that expands in place. Grants-scoped upstream (accessible =
  // getAccessibleProfiles). Replaces the former sick-household widget (folded in, #858).
  const activeSick = hasActiveIllnessSituation(profile.id);
  const activeEpisode = activeSick ? openEpisodeForProfile(profile.id) : null;
  const otherSick = accessible
    .filter((p) => p.id !== profile.id)
    .map((p) => ({ p, ep: currentEpisodeForProfile(p.id) }))
    .filter(
      (x): x is { p: (typeof accessible)[number]; ep: AssembledEpisode } =>
        x.ep !== null
    );

  // Disambiguate every cockpit patient's name together (#531/#534 on-element identity).
  const heroProfiles = [
    ...(activeEpisode ? [profile] : []),
    ...otherSick.map((x) => x.p),
  ];
  const heroNames = disambiguateProfileNames(heroProfiles);
  const nameFor = (p: { id: number; name: string }) =>
    heroNames.get(p.id) ?? p.name;

  const orderedCockpits = orderIllnessCockpits([
    ...(activeEpisode
      ? [
          {
            profileId: profile.id,
            isActive: true,
            start: activeEpisode.start,
            avatar: profile,
            episode: activeEpisode,
          },
        ]
      : []),
    ...otherSick.map((x) => ({
      profileId: x.p.id,
      isActive: false,
      start: x.ep.start,
      avatar: x.p,
      episode: x.ep,
    })),
  ]);

  const heroCockpits: HeroCockpit[] = orderedCockpits.map((c) => ({
    profileId: c.profileId,
    profile: c.avatar,
    displayName: nameFor(c.avatar),
    isActive: c.isActive,
    headline: episodeHeadline(c.episode),
    compactLine: householdSickLine(
      nameFor(c.avatar),
      c.episode,
      units.temperatureUnit,
      (() => {
        const sr = schoolReturnStatusFor(c.profileId, c.episode);
        return sr ? schoolReturnCompactClause(sr) : null;
      })()
    ),
    body: (
      <IllnessCockpitBody
        profileId={c.profileId}
        loginId={login.id}
        episode={c.episode}
        crossProfile={!c.isActive}
      />
    ),
  }));
  const heroUi = getIllnessHeroUi(profile.id);

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

  // quick-log-prn — active PRN (as-needed) meds for one-tap administration logging
  // (#797), each with today's count + last intake time.
  const prnMeds = has("quick-log-prn")
    ? getPrnMedicationsForQuickLog(profile.id)
    : [];

  // active-protocols (issue #660): the ongoing N-of-1 experiments, each a formatter
  // over the SAME detail-page computations (comparison + adherence). Opt-in widget;
  // self-hides (available=false below) when nothing is ongoing.
  const activeProtocols = has("active-protocols")
    ? getActiveProtocolSummaries(profile.id, on, units.weightUnit)
    : [];

  // symptom-log (#799/#843/#858): the Symptoms widget slot is now the INACTIVE-state home
  // ONLY. When the acting profile's illness is active its FULL cockpit has jumped to the
  // illness hero above the grid (activeSick), so the widget slot renders NOTHING here — no
  // duplicate symptom card. Otherwise it is the calm "Feeling sick?" front door (door A)
  // whose single tap activates Illness and surfaces the cockpit in the hero on the next
  // render. Hideable from Customize like any other widget.
  const showFeelingSick = has("symptom-log") && !activeSick;

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
  if (has("quick-log-prn") && prnMeds.length === 0)
    emptyIds.add("quick-log-prn");

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
      case "quick-log-prn":
        return (
          <WidgetEmpty
            title="Log a PRN dose"
            icon={IconPill}
            message="No as-needed medications yet. Add a PRN medication to log doses like ibuprofen or an inhaler right from here."
            ctaLabel="Add a medication"
            ctaHref="/medications"
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
      case "quick-log-prn":
        return (
          <QuickLogPrnWidget meds={prnMeds} tz={getTimezone(profile.id)} />
        );
      case "active-protocols":
        return activeProtocols.length ? (
          <ActiveProtocolWidget protocols={activeProtocols} />
        ) : null;
      case "symptom-log":
        // Front door only (#858): the active cockpit lives in the illness hero, so this
        // renders nothing while the hero is up (available=false below), else the door.
        return activeSick ? null : <FeelingSickCard />;
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
      (def.id !== "weekly-recap" || weeklyRecap !== null) &&
      (def.id !== "active-protocols" || activeProtocols.length > 0) &&
      // symptom-log is the inactive-state front door only: while the acting profile's
      // cockpit is in the illness hero (activeSick) the slot renders nothing (#858).
      (def.id !== "symptom-log" || showFeelingSick),
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
      {/* Illness hero (#858): pinned above the customizable grid AND above Needs
          attention, so an open episode's cockpit is the FIRST content block (the 7am
          feverish-kid case; the mobile acceptance requires it lead). Composes with the
          Needs-attention hero below — both render; no other widget is reordered/dimmed. */}
      <IllnessHero
        cockpits={heroCockpits}
        initialCollapsedActive={heroUi.collapsedActive}
        initialOpenOtherId={heroUi.openOtherId}
        saveState={saveIllnessHeroState}
      />
      <div className="mb-6">
        <NeedsAttentionHero items={attention} today={on} />
      </div>
      {showRecapCard && finishedRecap && (
        <SessionRecapCard recap={finishedRecap} unit={units.weightUnit} />
      )}
      {onboardingState && onboardingPresence && (
        <OnboardingResumeCard
          state={onboardingState}
          presence={onboardingPresence}
        />
      )}
      {onboardingChecklist && onboardingChecklistCompletion && (
        <OnboardingChecklist
          focuses={onboardingChecklist.focuses}
          completion={onboardingChecklistCompletion}
        />
      )}
      {showOrientation && orientationPresence && (
        <ProfileOrientationCard
          profileName={profile.name}
          access={access}
          attentionCount={attention.length}
          presence={orientationPresence}
        />
      )}
      <HouseholdStrip entries={householdEntries} />
      <DashboardGrid
        key={profile.id}
        widgets={gridWidgets}
        saveAction={saveDashboardLayout}
      />
    </div>
  );
}
