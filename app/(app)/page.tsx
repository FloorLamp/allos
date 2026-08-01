import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  IconFlask,
  IconScale,
  IconMoon,
  IconSalad,
  IconWalk,
  IconHeartbeat,
} from "@tabler/icons-react";
import { now as clockNow } from "@/lib/clock";
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
  getLastNightSummary,
  getSleepRegularity,
  typicalWakeTime,
  getPrnMedicationsForQuickLog,
  getActiveProtocolSummaries,
  getWorkoutPresence,
  getSessionRecap,
  getMoodOnDate,
  getProteinToday,
  getMetricDailyTotals,
  getLatestBiomarkerTrendPoints,
  getLatestBodyMetricDailyPoints,
  getNavRelevance,
  getSituationalDueCount,
  getDerivedSituationLines,
  isAnxietyScaleRelevant,
  getSymptomsOnDate,
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getCustomSymptomNames,
  getSymptomLogOrder,
} from "@/lib/queries";
import {
  nonIllnessSituationOptions,
  situationActivationLine,
} from "@/lib/situations";
import { listCyclePeriods } from "@/lib/cycle-store";
import { cyclePhaseOnDate, cycleDayOnDate } from "@/lib/cycle";
import { summarizeStepsToday } from "@/lib/steps-today";
import { latestTrend } from "@/lib/latest-trend";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { getUserAge } from "@/lib/settings/profile-attrs";
import { recommendCoaching } from "@/lib/coaching";
import { collectCoachingFindings } from "@/lib/rule-findings";
import { pickNextAppointment } from "@/lib/household";
import { isGoalLive } from "@/lib/goals";
import { activeByKey, activeFindings, coachingDedupeKey } from "@/lib/findings";
import {
  requireSession,
  getAccessibleProfiles,
  ownProfileForLogin,
} from "@/lib/auth";
import { writeSubjectName } from "@/lib/own-profile";
import { withAiLogContext } from "@/lib/ai-log";
import { runRecommendation } from "@/lib/recommendation-engine";
import { isTrainingRestricted } from "@/lib/age-gate";
import {
  getDashboardLayout,
  getOnboardingState,
  getUnitPrefs,
  getDisplayFormatPrefs,
  getTimezone,
  getEmergencyCardEnabled,
  getProfileHomeAssistant,
  getLoginTelegram,
  getSituations,
  getActiveSituations,
  getAttentionHeroCollapsed,
  getRecentlyResolvedDismissed,
} from "@/lib/settings";
import { countPushSubscriptionsForLogin } from "@/lib/notifications/push";
import { hasConnectedDataSource } from "@/lib/integrations/connections";
import { dispWeight } from "@/lib/units";
import { shiftDateStr, hhmmToMinutes, zonedDateParts } from "@/lib/date";
import { ALL_ROWS } from "@/lib/trends";
import { formatLongDate, daysRemainingLabel } from "@/lib/format-date";
import { recentLabHighlights } from "@/lib/recent-labs";
import { getWeeklyRecap } from "@/lib/notifications/weekly-recap-data";
import {
  findingsForDashboardHome,
  resolveWidgetList,
  rollupCoachingFindings,
} from "@/lib/dashboard-widgets";
import { rankNowCards, NOW_CARD_IDS } from "@/lib/now-strip";
import { getNotifySchedule } from "@/lib/settings/notifications";
import { getIllnessHeroUi } from "@/lib/settings";
import { getMoodCheckinIgnored, getProfileMoodCheckin } from "@/lib/settings";
import { isMoodCheckinPaused } from "@/lib/mood";
import { onboardingNeedsSetup } from "@/lib/onboarding";
import { getOnboardingDataPresence } from "@/lib/onboarding-data";
import { PageHeader } from "@/components/ui";
import DashboardGrid, {
  type GridWidget,
} from "@/components/dashboard/DashboardGrid";
import NeedsAttentionHero from "@/components/dashboard/NeedsAttentionHero";
import NowStrip, { type NowStripCard } from "@/components/dashboard/NowStrip";
import HouseholdStrip, {
  type HouseholdStripEntry,
} from "@/components/dashboard/HouseholdStrip";
import IllnessHero, {
  type HeroCockpit,
} from "@/components/dashboard/IllnessHero";
import RecentlyResolvedReopen, {
  type RecentlyResolvedItem,
} from "@/components/dashboard/RecentlyResolvedReopen";
import { reopenEligibleEpisodeForProfile } from "@/lib/illness-episode-store";
import IllnessCockpitBody from "../../components/illness/IllnessCockpitBody";
import {
  currentEpisodeForProfile,
  openEpisodeForProfile,
} from "@/lib/illness-episode";
import {
  episodeCollapsedStatus,
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
import DataQualityWidget from "@/components/dashboard/DataQualityWidget";
import WeeklyRecapWidget from "@/components/dashboard/WeeklyRecapWidget";
import RecentLabsWidget, {
  type RecentLabRow,
} from "@/components/dashboard/RecentLabsWidget";
import NextAppointmentWidget, {
  type NextAppointment,
} from "@/components/dashboard/NextAppointmentWidget";
import HealthspanPillarsWidget from "@/components/dashboard/HealthspanPillarsWidget";
import SleepLastNightWidget from "@/components/dashboard/SleepLastNightWidget";
import { sleepRecordPresentation } from "@/lib/sleep-summary";
import { QuickLogPrnContent } from "@/components/dashboard/QuickLogPrnWidget";
import NutritionTodayWidget from "@/components/dashboard/NutritionTodayWidget";
import StepsTodayWidget from "@/components/dashboard/StepsTodayWidget";
import VitalsLatestWidget, {
  type VitalsLatestModel,
} from "@/components/dashboard/VitalsLatestWidget";
import CyclePhaseWidget from "@/components/dashboard/CyclePhaseWidget";
import ActiveProtocolWidget from "@/components/dashboard/ActiveProtocolWidget";
import HowAreYouCard from "@/components/dashboard/HowAreYouCard";
import SymptomLogBar from "../../components/illness/SymptomLogBar";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import { isTaskConfigured } from "@/lib/ai-resolve";
import { hasActiveIllnessSituation } from "@/lib/settings/profile-attrs";
import OnboardingResumeCard from "@/components/dashboard/OnboardingResumeCard";
import OnboardingChecklist from "@/components/dashboard/OnboardingChecklist";
import {
  dismissRecentlyResolved,
  saveAttentionHeroCollapsed,
  saveDashboardLayout,
  saveIllnessHeroState,
} from "./actions";
import { episodeHref, encounterHref, type AppRoute } from "@/lib/hrefs";
import { formatRecordDateTime } from "@/lib/record-format";
import { isHouseholdRecentlySick } from "@/lib/household-history";
import { visibleRecentlyResolved } from "@/lib/recently-resolved";

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
  const formatPrefs = getDisplayFormatPrefs(login.id);

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
  // The login's unit prefs ride along (#1019) so a measurement-carrying item (the
  // temperature red-flag, an endurance event distance) renders in the viewer's unit.
  const attention = collectAttentionModel(profile.id, on, units);

  // Tier 2 — the household strip. A caregiver reaching 2+ profiles gets a per-
  // profile attention count for their OTHER profiles (same gate as the Household
  // nav entry). Bounded work: a household is a handful of profiles, each count a
  // few profile-scoped reads. Grants are respected — getAccessibleProfiles returns
  // only reachable profiles, and the switch action re-checks.
  const accessible = await getAccessibleProfiles();
  // Own-profile link (#1013): the acting-profile write forms (the weight quick-add)
  // name the subject when the login is acting as someone OTHER than its own profile,
  // so a weigh-in never silently lands on the wrong person's record. Null (no naming)
  // when acting as self or no own-profile is set. Disambiguated (#534).
  const ownProfileId = ownProfileForLogin(login.id);
  const actingSubjectName = writeSubjectName(
    ownProfileId,
    profile.id,
    disambiguateProfileNames(accessible).get(profile.id) ?? profile.name
  );
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
          getLoginTelegram(login.id).telegramEnabled ||
          getProfileHomeAssistant(profile.id).enabled ||
          countPushSubscriptionsForLogin(login.id) > 0,
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
  // Per-profile widget gate (issue #1221): the dashboard twin of the nav's per-entry
  // gating. Nutrition-today drops for an infant profile (the SAME isFoodLoggingRelevant
  // bit as the Nutrition nav entry, #591); Cycle-phase drops unless cycle tracking is
  // relevant (the SAME getNavRelevance().cycle bit as the Cycle nav entry, #1042) — so a
  // card can never disagree with its nav twin about applicability.
  const widgetGate = {
    foodLogging: isFoodLoggingRelevant(getUserAge(profile.id)),
    cycle: getNavRelevance(profile.id).cycle,
  };
  const list = resolveWidgetList(
    getDashboardLayout(profile.id),
    restricted,
    undefined,
    widgetGate
  );
  const eligible = new Set(list.map((w) => w.def.id));
  const has = (id: string) => eligible.has(id);
  // Eligibility is not visibility: `list` deliberately carries the widgets the profile
  // has toggled OFF too, so Customize can preview one without a round-trip. Anything
  // that asks "is this card actually on the person's dashboard right now?" — e.g. the
  // #1533 finding-home split — must read the saved `visible` flag, not `has`.
  const shown = new Set(list.filter((w) => w.visible).map((w) => w.def.id));
  const showsWidget = (id: string) => shown.has(id);

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

  const heroCockpits: HeroCockpit[] = orderedCockpits.map((c) => {
    const schoolReturn = schoolReturnStatusFor(c.profileId, c.episode);
    return {
      profileId: c.profileId,
      profile: c.avatar,
      displayName: nameFor(c.avatar),
      isActive: c.isActive,
      status: episodeCollapsedStatus(c.episode, units.temperatureUnit, {
        timeZone: getTimezone(c.profileId),
        timeFormat: formatPrefs.timeFormat,
        // The frozen-clock seam (#1028 class): the reading's relative age must come
        // from lib/clock, not a bare new Date() fallback — the suite freezes only
        // the former.
        now: clockNow(),
      }),
      feverFree: schoolReturn
        ? {
            label: schoolReturnCompactClause(schoolReturn).replace(
              /^fever-free/,
              "Fever-free"
            ),
            met: schoolReturn.met,
          }
        : null,
      episodeHref: c.episode.id != null ? episodeHref(c.episode.id) : null,
      body: (
        <IllnessCockpitBody
          profileId={c.profileId}
          loginId={login.id}
          episode={c.episode}
          crossProfile={!c.isActive}
        />
      ),
    };
  });
  const heroUi = getIllnessHeroUi(profile.id);

  // Recently-resolved reopen affordance (issue #1140 Part A): for every accessible profile,
  // the most-recent episode still inside its 7-day reopen window (the SAME
  // episodeReopenEligibility rule the detail page uses). Cross-profile aware like the hero
  // (#858) — each row reopens that member's episode via its profileId. Calm/dismissible,
  // never the attention hero (#449). Names disambiguated across the accessible set (#531).
  //
  // Filtered SERVER-SIDE against the viewer's stored dismissals (#1548): the X used to
  // be client state only, so a hidden line came back on the next reload. The client
  // component still hides optimistically, but this list is now the truth — and it is
  // also what decides where the household-history promo goes (#1549), which is why the
  // filter has to happen here rather than in the browser.
  const reopenNames = disambiguateProfileNames(accessible);
  const recentlyResolvedAll: RecentlyResolvedItem[] = accessible
    .map((p) => ({ p, ep: reopenEligibleEpisodeForProfile(p.id) }))
    .filter(
      (
        x
      ): x is {
        p: (typeof accessible)[number];
        ep: NonNullable<ReturnType<typeof reopenEligibleEpisodeForProfile>>;
      } => x.ep !== null
    )
    .map(({ p, ep }) => ({
      profileId: p.id,
      episodeId: ep.id,
      situation: ep.situation,
      displayName: reopenNames.get(p.id) ?? p.name,
      crossProfile: p.id !== profile.id,
      profile: p,
      episodeHref: episodeHref(ep.id),
    }));
  const recentlyResolved = visibleRecentlyResolved(
    recentlyResolvedAll,
    getRecentlyResolvedDismissed(login.id)
  );

  // Contextual promotion of the merged household history (issue #1009 Ask 2): a CALM
  // link that surfaces near the illness hero when any accessible member is currently or
  // recently sick, and recedes once the house is well. Only for a multi-profile login
  // (a single-profile login has no household to merge). Reuses the SAME episode rows the
  // hero reads — never a second "who's sick" derivation — via isHouseholdRecentlySick.
  // It is a link, NOT a notification and NOT a finding (no dedupeKey, no bus): it appears
  // because it's useful and disappears on its own.
  //
  // The PREDICATE is unchanged by #1549; only its PLACEMENT is now contextual. The
  // reopen window (7 days) is a strict subset of this one (14), so a standalone block
  // stacked a third household-shaped band under the reopen lines in every just-
  // recovered state, and floated context-free in the 8–14-day tail once the illness
  // hero that justified "surfaces near the hero" was gone. So the link renders as a row
  // of whichever household band is already on screen — ONE render, never two:
  //   • reopen lines visible → the reopen band's footer;
  //   • otherwise (the tail, or every line dismissed) → the household strip's label row.
  const promoteHouseholdHistory =
    accessible.length > 1 &&
    isHouseholdRecentlySick(accessible.map((p) => p.id));
  const promoInReopenBand =
    promoteHouseholdHistory && recentlyResolved.length > 0;
  const promoInHouseholdStrip =
    promoteHouseholdHistory && recentlyResolved.length === 0;

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

  // sleep-last-night (issue #1066): the morning "how did I sleep" tile — the SAME
  // lastNightSummary model the /sleep hero reads (one question, one computation),
  // with the SRI alongside as the second figure. Null summary → the data-aware CTA.
  const sleepSummary = has("sleep-last-night")
    ? getLastNightSummary(profile.id)
    : null;
  const sleepPresentation = sleepSummary
    ? sleepRecordPresentation(sleepSummary.wakeDay, on, formatPrefs)
    : null;
  const sleepSri =
    has("sleep-last-night") && sleepSummary != null
      ? (getSleepRegularity(profile.id)?.sri ?? null)
      : null;

  // recent-labs (medical): the current reading per lab/biomarker marker, flagged
  // markers surfaced first so an out-of-range result is the headline. Selection
  // policy is the shared recentLabHighlights (issue #313).
  let labRows: RecentLabRow[] = [];
  if (has("recent-labs")) {
    labRows = recentLabHighlights(
      getMedicalRecords(profile.id, { current: true }),
      undefined,
      on
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
      // Render date AND clock time through the login's prefs (#1215) — a stored
      // "YYYY-MM-DD HH:MM" shows the wall-clock; a date-only value degrades to the
      // long date. The card links to the resulting encounter once one exists, else
      // the visits list (the same target the header uses).
      const visitsHref: AppRoute = "/records/history/visits";
      nextAppt = {
        title: soonest.title?.trim() || soonest.provider_name || "Appointment",
        whenLabel: formatRecordDateTime(
          soonest.scheduled_at,
          formatLongDate(d, formatPrefs),
          formatPrefs
        ),
        dueText: daysRemainingLabel(d, on) ?? d,
        detail: detailParts.length ? detailParts.join(" · ") : null,
        href: soonest.encounter_id
          ? encounterHref(soonest.encounter_id)
          : visitsHref,
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

  // coaching-observations (#449) + data-quality (#1045): BOTH read the ONE
  // collectCoachingFindings computation (data-quality joins it, #1045), filtered
  // through the SAME findings-bus store — so a dismiss on either widget (or a tab)
  // drops the finding out for free.
  //
  // They render DISJOINT slices of it (#1533). The data-quality widget is that
  // family's dedicated dashboard home (FINDING_DASHBOARD_HOME); the rollup is the
  // catch-all for families that have no dashboard home of their own — which is
  // exactly its #449 charter, "reach for findings that render only on their own
  // tabs". So the two cards can never show the same gap twice, and the rollup's
  // count/overflow are computed over what it actually renders. Hiding the Data
  // quality widget drops its family straight back into the rollup, so a hidden card
  // never silently costs a finding its dashboard reach.
  const activeCoaching =
    has("coaching-observations") || has("data-quality")
      ? activeFindings(
          collectCoachingFindings(
            profile.id,
            on,
            units.weightUnit,
            formatPrefs
          ),
          getFindingSuppressions(profile.id),
          on
        )
      : [];
  const coachingObservations = has("coaching-observations")
    ? rollupCoachingFindings(activeCoaching, showsWidget)
    : [];
  const dataQualityFindings = has("data-quality")
    ? findingsForDashboardHome(activeCoaching, "data-quality")
    : [];

  // weekly-recap — the last seven days, rule-based (no AI). Same gather as the
  // weekly notification, so the card and the digest always agree.
  const weeklyRecap = has("weekly-recap")
    ? getWeeklyRecap(profile.id, units.weightUnit)
    : null;

  // nutrition-today (#1221): today's protein against the goal band + the weekly average
  // — the SAME getProteinToday model the Food-tab gauge and the food-nudge read (#221).
  // Null when there's no target (no bodyweight) or no protein data → the data-aware CTA.
  const proteinToday = has("nutrition-today")
    ? getProteinToday(profile.id)
    : null;

  // steps-today (#1221): today's steps vs the trailing 7-day average, a formatter over
  // summarizeStepsToday fed by the deduped one-source-per-day steps series (#14/#221).
  // Empty series → the data-aware CTA (connect a source).
  const stepsRows = has("steps-today")
    ? getMetricDailyTotals(profile.id, "steps")
    : [];
  const stepsSummary =
    stepsRows.length > 0 ? summarizeStepsToday(stepsRows, on) : null;

  // vitals-latest (#1221): the latest BP + resting HR readings with a trend arrow, over
  // the SAME series queries behind Trends → Vitals (getBiomarkerSeries for BP,
  // getBodyMetricDailySeries for resting HR), each reduced via the shared latestTrend
  // helper (#221). Null components self-omit; an all-null model is the data-aware CTA.
  let vitalsModel: VitalsLatestModel | null = null;
  if (has("vitals-latest")) {
    // The card reads only the last two points (latestTrend), so pull just the trend
    // tail rather than the whole BP/resting-HR history (#1367): getLatestBiomarkerTrendPoints
    // and getLatestBodyMetricDailyPoints return the exact same two points the full
    // series' tail would, without materializing years of synced readings per render.
    const systolic = getLatestBiomarkerTrendPoints(
      profile.id,
      "Blood Pressure Systolic"
    ).map((r) => ({ date: r.date, value: Math.round(r.value_num as number) }));
    const diastolic = getLatestBiomarkerTrendPoints(
      profile.id,
      "Blood Pressure Diastolic"
    ).map((r) => ({ date: r.date, value: Math.round(r.value_num as number) }));
    const restingHrSeries = getLatestBodyMetricDailyPoints(
      profile.id,
      "resting_hr"
    ).map((w) => ({ date: w.date, value: Math.round(w.value) }));
    const sysLatest = latestTrend(systolic);
    const diaLatest = latestTrend(diastolic);
    const hrLatest = latestTrend(restingHrSeries);
    const bp =
      sysLatest && diaLatest
        ? {
            systolic: sysLatest.value,
            diastolic: diaLatest.value,
            date: sysLatest.date,
            direction: sysLatest.direction,
          }
        : null;
    const restingHr = hrLatest
      ? {
          value: hrLatest.value,
          date: hrLatest.date,
          direction: hrLatest.direction,
        }
      : null;
    vitalsModel = bp || restingHr ? { bp, restingHr } : null;
  }

  // cycle-phase (#1221): "Cycle day N · <phase>" over cycleDayOnDate + cyclePhaseOnDate
  // (lib/cycle.ts, #221) — informational only, no prediction. Relevance-gated in the
  // registry; self-hides when no phase is derivable (before any recorded period).
  const cyclePeriods = has("cycle-phase") ? listCyclePeriods(profile.id) : [];
  const cyclePhase =
    cyclePeriods.length > 0 ? cyclePhaseOnDate(cyclePeriods, on) : null;
  const cycleDay =
    cyclePeriods.length > 0 ? cycleDayOnDate(cyclePeriods, on) : null;
  const cycleModel =
    cyclePhase != null && cycleDay != null
      ? { day: cycleDay, phase: cyclePhase }
      : null;

  // symptom-log meds branch (#1221): the folded PRN quick-log. Shown ONLY on a WELL day
  // with active PRN meds — when illness is active the hero cockpit above already embeds
  // the SAME logger (so we omit the branch to avoid the duplicate the old availability
  // gate hand-managed), and a profile with no active PRN meds gets no branch at all.
  const checkinPrnMeds =
    has("symptom-log") && !activeSick
      ? getPrnMedicationsForQuickLog(profile.id)
      : [];

  // symptom-log well-day entry (#1300): a compact SymptomLogBar behind the check-in card's
  // Report reveal, so a well user (severe cramps, a headache) can log symptoms with NO
  // illness required. Shown ONLY on a WELL day — while illness is active the hero cockpit
  // above owns symptom logging (so we omit it to avoid the duplicate). Same store + the
  // suggest-only illness bridge as the Timeline bar (no temperature/day-toggle here).
  const showWellSymptoms = has("symptom-log") && !activeSick;
  const wellSymptomCount = showWellSymptoms
    ? getSymptomsOnDate(profile.id, on).length
    : 0;

  // active-protocols (issue #660): the ongoing N-of-1 experiments, each a formatter
  // over the SAME detail-page computations (comparison + adherence). Opt-in widget;
  // self-hides (available=false below) when nothing is ongoing.
  const activeProtocols = has("active-protocols")
    ? getActiveProtocolSummaries(profile.id, on, units.weightUnit)
    : [];

  // symptom-log (#799/#843/#858 → #992): the widget slot is now the unified "How are
  // you today?" daily check-in card — the one-tap mood log composed with the illness
  // front door. When the acting profile is well it leads with the mood tap plus the
  // quiet "Not feeling well?" branch (door A — one tap activates Illness and the
  // cockpit surfaces in the hero on the next render). When illness is ACTIVE the
  // cockpit lives in the hero above the grid, so the card defers to it with a quiet
  // note — and still offers the mood tap (mood during illness is signal, #992).
  // Hideable from Customize like any other widget.
  const todayMood = has("symptom-log") ? getMoodOnDate(profile.id, on) : null;

  // symptom-log "Anything going on?" situations entrypoint (#1221 part 6): the NON-clinical
  // situation chips (illness types excluded — that lifecycle is the illness door's) over the
  // SAME merged option set the Supplements bar renders (nonIllnessSituationOptions), each with
  // its active state, plus the shared #662 activation line from the SAME dueness count the bar
  // uses (getSituationalDueCount → countSituationalDue). Null when the card isn't eligible.
  const checkinSituations = has("symptom-log")
    ? (() => {
        const activeSet = new Set(getActiveSituations(profile.id));
        // The DERIVED-context state lines (#1292/#1298): the SAME basis-aware lines the
        // Supplements bar + digest render, shown here so the check-in disclosure
        // surfaces the auto-on context (#1221 item 6). "Not today" (poor-sleep only,
        // when derived) rides the shared override action.
        const derived = getDerivedSituationLines(profile.id, on);
        return {
          options: nonIllnessSituationOptions(getSituations(profile.id)).map(
            (o) => ({ name: o.name, active: activeSet.has(o.name) })
          ),
          activationLine: situationActivationLine(
            getSituationalDueCount(profile.id)
          ),
          derivedLines: [derived.poorSleep, derived.period].filter(
            (l): l is string => l != null
          ),
          poorSleepOverridable: derived.poorSleepOverridable,
        };
      })()
    : null;

  // The check-in Calm (anxiety) scale relevance gate (issue #1313): the SILENT
  // six-signal resolver (prior use, GAD-7/PHQ-9 on record, an anxiety condition/med, a
  // protocol outcome, or the Settings opt-in). Only computed when the card renders.
  const checkinAnxietyRelevant = has("symptom-log")
    ? isAnxietyScaleRelevant(profile.id)
    : false;

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
  if (has("nutrition-today") && proteinToday == null)
    emptyIds.add("nutrition-today");
  if (has("steps-today") && stepsSummary == null) emptyIds.add("steps-today");
  if (has("vitals-latest") && vitalsModel == null)
    emptyIds.add("vitals-latest");
  if (
    has("sleep-last-night") &&
    (sleepSummary == null || sleepPresentation?.freshness === "stale")
  )
    emptyIds.add("sleep-last-night");

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
      case "nutrition-today":
        return (
          <WidgetEmpty
            title="Nutrition today"
            icon={IconSalad}
            message="No food logged yet. Log today's food or set your body weight to track protein against your goal."
            ctaLabel="Log food"
            ctaHref="/nutrition"
          />
        );
      case "steps-today":
        return (
          <WidgetEmpty
            title="Steps today"
            icon={IconWalk}
            message="No step data yet. Connect Health Connect to sync your daily steps automatically."
            ctaLabel="Connect a source"
            ctaHref="/integrations/health-connect"
          />
        );
      case "vitals-latest":
        return (
          <WidgetEmpty
            title="Latest vitals"
            icon={IconHeartbeat}
            message="No blood pressure or resting heart rate yet. Log a reading to see it here at a glance."
            ctaLabel="Log a reading"
            ctaHref="/trends#body"
          />
        );
      case "sleep-last-night":
        return (
          <WidgetEmpty
            title="Sleep"
            icon={IconMoon}
            message="No sleep recorded last night. Sync Health Connect, Oura, or Withings to refresh your sleep data."
            ctaLabel="Sync a source"
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
      case "sleep-last-night":
        return sleepSummary && sleepPresentation ? (
          <SleepLastNightWidget
            summary={sleepSummary}
            sri={sleepSri}
            timeFormat={formatPrefs.timeFormat}
            presentation={sleepPresentation}
          />
        ) : null;
      case "weight-trend":
        return (
          <WeightTrendWidget
            data={bodyMetrics}
            weightUnit={units.weightUnit}
            formatPrefs={formatPrefs}
            today={on}
            subjectName={actingSubjectName}
          />
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
      case "data-quality":
        return dataQualityFindings.length ? (
          <DataQualityWidget findings={dataQualityFindings} />
        ) : null;
      case "weekly-recap":
        return weeklyRecap ? (
          <WeeklyRecapWidget recap={weeklyRecap} formatPrefs={formatPrefs} />
        ) : null;
      case "nutrition-today":
        return proteinToday ? (
          <NutritionTodayWidget today={proteinToday} />
        ) : null;
      case "steps-today":
        return stepsSummary ? (
          <StepsTodayWidget summary={stepsSummary} />
        ) : null;
      case "vitals-latest":
        return vitalsModel ? <VitalsLatestWidget model={vitalsModel} /> : null;
      case "cycle-phase":
        return cycleModel ? (
          <CyclePhaseWidget day={cycleModel.day} phase={cycleModel.phase} />
        ) : null;
      case "active-protocols":
        return activeProtocols.length ? (
          <ActiveProtocolWidget protocols={activeProtocols} />
        ) : null;
      case "symptom-log":
        // The unified daily check-in (#992): mood tap always; the illness branch is
        // the front door when well, a defer-to-hero note while the cockpit is up.
        return (
          <HowAreYouCard
            date={on}
            mood={
              todayMood
                ? {
                    valence: todayMood.valence,
                    energy: todayMood.energy,
                    anxiety: todayMood.anxiety,
                    factors: todayMood.factors,
                    notes: todayMood.notes,
                  }
                : null
            }
            activeEpisode={activeSick}
            // The evening reminder's auto-pause, surfaced (#1668) — derived from the
            // same ignored streak shouldSendMoodCheckin reads, never a stored flag.
            checkinsPaused={isMoodCheckinPaused({
              enabled: getProfileMoodCheckin(profile.id),
              ignoredCount: getMoodCheckinIgnored(profile.id),
            })}
            medsSlot={
              checkinPrnMeds.length > 0 ? (
                <QuickLogPrnContent
                  meds={checkinPrnMeds}
                  tz={getTimezone(profile.id)}
                  timeFormat={formatPrefs.timeFormat}
                  title="Log a dose"
                  headingVariant="section"
                  compact
                  rowVariant="embedded"
                  showPageLink={false}
                />
              ) : null
            }
            medsCount={checkinPrnMeds.length}
            situations={checkinSituations}
            anxietyRelevant={checkinAnxietyRelevant}
            symptomCount={wellSymptomCount}
            symptomSlot={
              showWellSymptoms ? (
                <SymptomLogBar
                  date={on}
                  initial={getSymptomSeveritiesOnDate(profile.id, on)}
                  initialNotes={getSymptomNotesOnDate(profile.id, on)}
                  symptoms={PICKER_SYMPTOMS}
                  customNames={getCustomSymptomNames(profile.id)}
                  rankedKeys={getSymptomLogOrder(profile.id)}
                  suggestActivateIllness={
                    !hasActiveIllnessSituation(profile.id)
                  }
                  showTitle={false}
                  temperatureUnit={units.temperatureUnit}
                  textIntakeEnabled={isTaskConfigured("symptom-map")}
                />
              ) : null
            }
          />
        );
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
      (def.id !== "data-quality" || dataQualityFindings.length > 0) &&
      (def.id !== "weekly-recap" || weeklyRecap !== null) &&
      (def.id !== "active-protocols" || activeProtocols.length > 0) &&
      // cycle-phase (#1221): informational card that self-hides when no phase is
      // derivable yet (before any recorded period) — never an onboarding CTA.
      (def.id !== "cycle-phase" || cycleModel !== null),
    // symptom-log is the unified "How are you today?" card (#992): the mood tap is
    // always offered, so the slot stays available in both illness states. Its folded
    // "Take any meds?" branch (#1221) is composed inside the card (shown only on a well
    // day with active PRN meds), which removes the old standalone-widget availability
    // special case entirely.
    node:
      def.dataAware && emptyIds.has(def.id)
        ? emptyNode(def.id)
        : renderWidget(def.id),
  }));

  // ── The "Now" strip (issue #1413, section A) ────────────────────────────────
  // A RANKER over signals other features already compute (#221) — nothing below
  // reads a new health fact. Every window is minute-of-day in the PROFILE's
  // timezone (#1186/#450), resolved once here rather than in the client.
  const nowMinutes = hhmmToMinutes(
    zonedDateParts(getTimezone(profile.id), clockNow()).hhmm
  );
  // The existing mealtime-shaped anchors: the profile's intake reminder slots.
  // NOT the food log — `food_log_events.logged_at` is TAP time, documented as
  // explicitly not eating time, so deriving a meal distribution from it would be
  // the new engine this issue's scope guard forbids.
  const nowSlots = getNotifySchedule(profile.id).supplementHours;
  const nowMealAnchors = [nowSlots.Morning, nowSlots.Midday, nowSlots.Evening]
    .filter((h): h is number => h != null)
    .map((h) => h * 60);

  // What the strip is ALLOWED to promote: a grid widget the user still has visible
  // AND that has something to render, or the standalone recap card under the same
  // gate the page already uses for it. The clock never overrides a hide preference.
  //
  // `emptyIds` is excluded deliberately: a data-aware widget with no data yet is
  // still "available" — it renders an ONBOARDING CTA rather than content — and
  // promoting that would put a "connect a source" prompt at the top of the page
  // every mealtime. That is precisely the filler card lib/now-strip.ts refuses.
  const gridPromotable = new Set(
    gridWidgets
      .filter((w) => w.visible && w.available && !emptyIds.has(w.id))
      .map((w) => w.id)
  );
  const nowEligible = NOW_CARD_IDS.filter((id) =>
    id === "session-recap" ? showRecapCard : gridPromotable.has(id)
  );
  // Eligibility already excludes the empty case above, so reaching this point
  // means the sleep widget has a fresh last-night summary to show.
  const nowFreshSleep = nowEligible.includes("sleep-last-night");
  const nowCardIds = rankNowCards({
    minutesOfDay: nowMinutes,
    // Only computed when sleep is actually in play — it is a 28-night regularity
    // pass, not worth running on an evening render that can't use it.
    wakeMinutes: nowFreshSleep ? typicalWakeTime(profile.id) : null,
    freshSleepSummary: nowFreshSleep,
    workoutFinishedMinAgo: showRecapCard
      ? (finishedPresence?.sinceMin ?? null)
      : null,
    mealAnchors: nowMealAnchors,
    eveningAnchor: nowSlots.Evening != null ? nowSlots.Evening * 60 : null,
    checkInDone: todayMood != null,
    eligible: nowEligible,
  });
  const nowPromoted = new Set<string>(nowCardIds);
  // Each strip card is a REFERENCE to the node the grid already built — the same
  // component, the same data, never a second rendering. The grid keeps the widget
  // in Customize (so its order/visibility preference survives) and only skips it in
  // normal mode, via `promoted` below.
  const nowStripCards: NowStripCard[] = nowCardIds
    .map((id) => ({
      id,
      node:
        id === "session-recap"
          ? finishedRecap && (
              <SessionRecapCard recap={finishedRecap} unit={units.weightUnit} />
            )
          : gridWidgets.find((w) => w.id === id)?.node,
    }))
    .filter((c): c is NowStripCard => c.node != null);

  return (
    <div>
      {/* Desktop only (issue #1413, section C): on a phone the nav already says
          where you are, and "Dashboard — today is <date>" costs a chunk of a much
          shorter screen before any content. The date survives below `md` on the Now
          strip's corner. Not a mirrored pair — there is no second mobile branch to
          drift from, just an element the phone doesn't get. */}
      <div className="hidden md:block">
        <PageHeader
          title="Dashboard"
          subtitle={`Today is ${formatLongDate(on, formatPrefs)} — here's your health at a glance.`}
        />
      </div>
      {/* Illness hero (#858): pinned before the customizable grid. It leads above
          Needs attention on smaller screens (the mobile 7am case); at XL the two
          equally weighted cards share the row so neither stretches across the wide
          dashboard canvas. With no open episode, Needs attention remains full-width. */}
      <div
        data-testid="dashboard-priority-row"
        className={`mb-6 grid min-w-0 items-start gap-6 ${heroCockpits.length > 0 ? "xl:grid-cols-2" : ""}`}
      >
        <IllnessHero
          cockpits={heroCockpits}
          initialCollapsedActive={heroUi.collapsedActive}
          initialOpenOtherId={heroUi.openOtherId}
          saveState={saveIllnessHeroState}
        />
        <div className="min-w-0">
          <NeedsAttentionHero
            items={attention}
            today={on}
            preferCollapsed={getAttentionHeroCollapsed(login.id)}
            saveCollapsed={saveAttentionHeroCollapsed}
          />
        </div>
      </div>
      {/* The moment's most relevant card(s), above the user's own grid (#1413 A).
          Renders nothing at all when no signal is firing. */}
      <NowStrip
        cards={nowStripCards}
        dateLabel={formatLongDate(on, formatPrefs)}
      />
      {recentlyResolved.length > 0 && (
        <RecentlyResolvedReopen
          items={recentlyResolved}
          showHouseholdPromo={promoInReopenBand}
          dismissAction={dismissRecentlyResolved}
        />
      )}
      {/* Skipped when the Now strip promoted it — one render, never two (#1413). */}
      {showRecapCard && finishedRecap && !nowPromoted.has("session-recap") && (
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
      <HouseholdStrip
        entries={householdEntries}
        showHouseholdPromo={promoInHouseholdStrip}
      />
      <DashboardGrid
        key={profile.id}
        widgets={gridWidgets}
        promoted={nowCardIds}
        saveAction={saveDashboardLayout}
      />
    </div>
  );
}
