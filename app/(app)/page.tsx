import { cloneElement, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { IconFlask, IconMoon } from "@tabler/icons-react";
import { now as clockNow } from "@/lib/clock";
import { today } from "@/lib/db";
import {
  getOutcomeGoals,
  getOutcomeGoalProgressMap,
  getFrequencyTargetProgress,
  frequencyTargetLogWindowOpen,
  getStrengthByExercise,
  getCardioByActivity,
  getBodyMetricDailySeries,
  getBodyMetricSeriesBySource,
  getDashboardClinicalObservations,
  getScheduledAppointments,
  gatherCoachingInput,
  getFindingSuppressions,
  collectAttentionDashboardData,
  getHealthspanPillars,
  getLastNightSummary,
  getSleepWaitingState,
  getNapHistory,
  typicalWakeTime,
  getPrnMedicationsForQuickLog,
  getActiveProtocolSummaries,
  getWorkoutPresence,
  getSessionRecap,
  getMoodOnDate,
  getProteinToday,
  getMetricDailyTotals,
  getVitalsLatestModel,
  getCycleTrackingRelevance,
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getCustomSymptomNames,
  getSymptomLogOrder,
} from "@/lib/queries";
import {
  getCycleForecast,
  getForecastSuspension,
  listCyclePeriods,
} from "@/lib/cycle-store";
import { cycleControlState } from "@/lib/cycle-plausibility";
import { summarizeStepsToday } from "@/lib/steps-today";
import {
  isFoodLoggingRelevant,
  isLongevityRelevant,
  isStrengthTrainingRelevant,
  isTrainingRelevant,
} from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings/profile-attrs";
import {
  recommendCoaching,
  recentCardioPRs,
  recentPRs,
  strengthAppropriateCoachingInput,
} from "@/lib/coaching";
import { collectCoachingFindings } from "@/lib/rule-findings";
import { pickNextAppointment } from "@/lib/household";
import { goalPct, isGoalLive } from "@/lib/outcome-goals";
import {
  frequencyScopeLabel,
  isStrengthProgrammingScope,
} from "@/lib/frequency-targets";
import { activeByKey, activeFindings, coachingDedupeKey } from "@/lib/findings";
import { routineOrder } from "@/lib/dismissal-fatigue";
import { requireSession } from "@/lib/auth";
import { requireScope, type ProfileScope } from "@/lib/scope";
import { writeSubjectName } from "@/lib/own-profile";
import { currentFoodSlot } from "@/lib/queries/nutrition";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";
import { foodGroupBySlug } from "@/lib/datasets/food-groups";
import { withAiLogContext } from "@/lib/ai-log";
import { runRecommendation } from "@/lib/recommendation-engine";
import {
  getOnboardingState,
  getUnitPrefs,
  getDisplayFormatPrefs,
  getTimezone,
  getEmergencyCardEnabled,
  getProfileHomeAssistant,
  getLoginTelegram,
  getRecentlyResolvedDismissed,
  getIllnessHeroUi,
} from "@/lib/settings";
import { countPushSubscriptionsForLogin } from "@/lib/notifications/push";
import { hasConnectedDataSource } from "@/lib/integrations/connections";
import { dispWeight, fmtDistance, fmtKmh, fmtWeight } from "@/lib/units";
import { shiftDateStr, hhmmToMinutes, zonedDateParts } from "@/lib/date";
import { ALL_ROWS } from "@/lib/trends";
import {
  formatClockMinutes,
  formatLongDate,
  daysRemainingLabel,
} from "@/lib/format-date";
import { RECENT_LAB_STALE_LABEL, recentLabHighlights } from "@/lib/recent-labs";
import {
  DORMANCY_DOMAINS,
  WEIGHT_TREND_WINDOW_DAYS,
  dormancyState,
  dormantRecordLine,
  type DormancyDomain,
} from "@/lib/domain-dormancy";
import { getLastSleepRecordDate } from "@/lib/queries/domain-dormancy";
import { freshnessAgeDays } from "@/lib/freshness";
import { glanceAgeToken } from "@/lib/glance-age";
import { VITAL_PRESENTATION_FLOORS } from "@/lib/vitals-latest";
import { getRecapCard } from "@/lib/notifications/recap-data";
import { recapLineId } from "@/lib/recap";
import {
  coachingObservationFindings,
  dashboardHabitDomain,
  isDataQualityDashboardFinding,
  summarizeDashboardHabits,
} from "@/lib/dashboard-presentation";
import {
  localTimeWindow,
  mealTimeWindows,
  orderedIllnessGroupKeys,
  rankDashboardCandidates,
  type DashboardCandidate,
  type DashboardTiming,
} from "@/lib/dashboard-relevance";
import {
  cappedFamilyGather,
  CLINICAL_RESULTS_CAP,
} from "@/lib/dashboard-standing";
import {
  attentionCandidates,
  careCandidates,
  dailyCandidates,
  engagementFromSource,
  preventiveReviewCandidate,
  progressCandidates,
  setupCandidates,
  sleepCandidates,
} from "@/lib/dashboard-candidates";
import { attentionBadgeItems } from "@/lib/attention";
import { getNotifySchedule } from "@/lib/settings/notifications";
import { getStreamLifecycleOffers } from "@/lib/queries/stream-lifecycle";
import { getMoodCheckinIgnored, getProfileMoodCheckin } from "@/lib/settings";
import { isMoodCheckinPaused } from "@/lib/mood";
import {
  hasOnboardingFirstValue,
  nextOnboardingStep,
  ONBOARDING_STEP_COUNT,
  onboardingNeedsSetup,
} from "@/lib/onboarding";
import { getOnboardingDataPresence } from "@/lib/onboarding-data";
import DashboardAttentionAtom from "@/components/dashboard/DashboardAttentionAtom";
import PreventiveReviewAtom from "@/components/dashboard/PreventiveReviewAtom";
import DashboardPlacementCanvas from "@/components/dashboard/DashboardPlacementCanvas";
import type { DashboardAheadPresentation } from "@/components/dashboard/DashboardPlacementCanvas";
import IllnessHero, {
  type HeroCockpit,
} from "@/components/dashboard/IllnessHero";
import type { DashboardStandingPresentation } from "@/components/dashboard/DashboardStandingCluster";
import DashboardAtomCard from "@/components/dashboard/DashboardAtomCard";
import RecentlyResolvedReopen, {
  type RecentlyResolvedItem,
} from "@/components/dashboard/RecentlyResolvedReopen";
import StreamLifecycleOffers from "@/components/integrations/StreamLifecycleOffers";
import {
  episodeStatesForProfiles,
  openEpisodeRowsForProfiles,
  reopenEligibleFromState,
  type ProfileEpisodeState,
} from "@/lib/illness-episode-store";
import { openEpisodesFromState } from "@/lib/illness-episode";
import {
  episodeCollapsedStatus,
  episodeLatestDose,
  assignOrderedEpisodeFacts,
  orderIllnessCockpits,
} from "@/lib/illness-episode-format";
import {
  gatherDashboardIllnessCockpits,
  type DashboardIllnessCockpitModel,
} from "@/lib/dashboard-illness-cockpit";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { householdFanoutWithActing } from "@/lib/household-fanout";
import WidgetEmpty from "@/components/dashboard/WidgetEmpty";
import LogReadingButton from "@/components/dashboard/LogReadingButton";
import SessionRecapCard from "@/components/dashboard/SessionRecapCard";
import WeightQuickAddWidget from "@/components/dashboard/WeightQuickAddWidget";
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
import {
  PillarToneBadge,
  TrendArrow,
} from "@/components/dashboard/HealthspanPillarPresentation";
import SleepWaitingWidget from "@/components/dashboard/SleepWaitingWidget";
import NapsTodayWidget from "@/components/dashboard/NapsTodayWidget";
import { formatHm, sleepRecordPresentation } from "@/lib/sleep-summary";
import { QuickLogPrnContent } from "@/components/dashboard/QuickLogPrnWidget";
import NutritionTodayWidget from "@/components/dashboard/NutritionTodayWidget";
import CyclePhaseWidget from "@/components/dashboard/CyclePhaseWidget";
import ActiveProtocolWidget from "@/components/dashboard/ActiveProtocolWidget";
import DashboardQuickEntryAction from "@/components/dashboard/DashboardQuickEntryAction";
import IllnessCockpitBody from "../../components/illness/IllnessCockpitBody";
import SymptomLogBar from "../../components/illness/SymptomLogBar";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import { isTaskConfigured } from "@/lib/ai-resolve";
import { hasActiveIllnessSituation } from "@/lib/settings/profile-attrs";
import OnboardingChecklist from "@/components/dashboard/OnboardingChecklist";
import HouseholdHistoryPromoLink from "@/components/dashboard/HouseholdHistoryPromoLink";
import { dismissRecentlyResolved, saveIllnessHeroState } from "./actions";
import { episodeHref, encounterHref, type AppRoute } from "@/lib/hrefs";
import { formatRecordDateTime } from "@/lib/record-format";
import { isHouseholdRecentlySickFromStates } from "@/lib/household-history";
import { visibleRecentlyResolved } from "@/lib/recently-resolved";
import {
  preloadGlobalSettings,
  preloadLoginSettings,
  preloadProfileSettings,
  withSettingReadCache,
} from "@/lib/settings/kv";
import { withReadSnapshot } from "@/lib/read-snapshot";
import { proteinBasisPhrase, proteinTargetSummary } from "@/lib/protein";
import { MedicalValue } from "@/components/ui";
import {
  clinicalResultBecameNotable,
  outcomeGoalProgressChanged,
  sleepArrivedInWakeWindow,
  weeklyTargetStateChanged,
} from "@/lib/dashboard-reading-promotions";
import {
  biomarkerFlagDismissalKey,
  prCardioDismissalKey,
  prStrengthDismissalKey,
} from "@/lib/dismissal-keys";
import { upcomingDueText } from "@/lib/upcoming";
import { dashboardAttentionCandidateId } from "@/lib/dashboard-attention-identity";
import { loadContextLabel } from "@/lib/lifts";
import { formatMinutes } from "@/lib/duration";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  return withSettingReadCache(async () => {
    const session = await requireSession();
    const scope = await requireScope();
    preloadGlobalSettings();
    preloadLoginSettings(session.login.id);
    preloadProfileSettings([session.profile.id]);
    const profileAge = getProfileAge(session.profile.id);
    if (isTrainingRelevant(profileAge)) {
      void withAiLogContext(
        { loginId: session.login.id, profileId: session.profile.id },
        () =>
          runRecommendation(session.profile.id, {
            trigger: "scheduled",
            loginId: session.login.id,
          })
      );
    }
    return withReadSnapshot(() => renderDashboard(session, scope, profileAge));
  });
}

async function renderDashboard(
  session: Awaited<ReturnType<typeof requireSession>>,
  scope: ProfileScope,
  profileAge: ReturnType<typeof getProfileAge>
) {
  const { login, profile, access } = session;
  const canWrite = access === "write";
  const storedOnboarding = getOnboardingState(profile.id);
  if (access === "write" && storedOnboarding?.status === "not_started") {
    redirect("/onboarding");
  }
  const trainingRelevant = isTrainingRelevant(profileAge);
  const strengthTrainingAvailable = isStrengthTrainingRelevant(profileAge);
  const on = today(profile.id);
  const timezone = getTimezone(profile.id);
  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);

  // Finished-window session recap card (#924): while derived workout presence reads
  // `finished`, surface the just-ended session's recap (self-view only). NEVER gated
  // on live mode — a manual fresh-end-time log or a freshness-capped import also
  // enters `finished`. The card feeds off the ONE server-side sessionRecap gather;
  // it disappears when the 60-min window closes on the next render. Skipped for a
  // Shown only when there's strength work to recap (a pure-cardio finish has no
  // working sets).
  const workoutPresence = getWorkoutPresence(profile.id);
  const finishedRecap =
    workoutPresence?.state === "finished" && workoutPresence.activityId != null
      ? getSessionRecap(profile.id, workoutPresence.activityId)
      : null;
  const showRecapCard =
    strengthTrainingAvailable &&
    finishedRecap != null &&
    finishedRecap.totalWorkingSets > 0;

  // Gather the unified attention model and its unchanged Upcoming input once. Atomic
  // candidates from that model are distributed by the four-zone resolver; the
  // act-now subset supplies only the app-badge count. Viewer units ride along so
  // measurement-carrying item copy stays consistent with Upcoming.
  const accessible = scope.profiles;
  preloadProfileSettings(
    accessible.map((accessibleProfile) => accessibleProfile.id)
  );
  // Own-profile link (#1013): the acting-profile write forms (the weight quick-add)
  // name the subject when the login is acting as someone OTHER than its own profile,
  // so a weigh-in never silently lands on the wrong person's record. Null (no naming)
  // when acting as self or no own-profile is set. Disambiguated (#534).
  const ownProfileId = scope.ownProfileId;
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
  const { attention, upcoming } = collectAttentionDashboardData(
    profile.id,
    on,
    units
  );

  // Applicability belongs to each candidate and is never inferred from missing data.
  // These bits reuse the same life-stage/navigation decisions as the owning routes.
  const foodLoggingApplicable = isFoodLoggingRelevant(profileAge);
  const cycleApplicable = getCycleTrackingRelevance(profile.id, profileAge);
  const adultContentApplicable = isLongevityRelevant(profileAge);

  // Every authorized OPEN illness episode becomes a whole cockpit, including a newly
  // opened episode with no facts yet. Discovery is one grants-scoped query across the
  // full profile scope; only profiles with open rows pay the downstream batched gather.
  // The acting profile leads, then household profiles by numeric id, with stable episode
  // order inside each profile. This full illness set intentionally sits outside the
  // ordinary dashboard cap; the bounded strip/reopen/history gathers below are unchanged.
  //
  // ONE episode gather for the whole page (#2115). Three surfaces below ask about
  // the same two rows per member — the accordion (the row covering that member's
  // today), the reopen band (the most-recently CLOSED row) and the household-history
  // promo (BOTH) — and each used to re-issue its own SELECTs, so the closed-row read
  // alone ran twice per profile per render. episodeStatesForProfiles reads them once
  // and every derivation below is a pure function of the result.
  //
  const illnessFanout = householdFanoutWithActing(accessible, profile.id);
  const illnessProfiles = accessible.filter(
    (accessibleProfile) => accessibleProfile.id !== profile.id
  );
  const openEpisodeRows = openEpisodeRowsForProfiles(scope.ids);
  const openRowsByProfile = new Map<number, typeof openEpisodeRows>();
  for (const row of openEpisodeRows) {
    const rows = openRowsByProfile.get(row.profile_id) ?? [];
    rows.push(row);
    openRowsByProfile.set(row.profile_id, rows);
  }
  const openStateByProfile = new Map<number, ProfileEpisodeState>();
  for (const [profileId, rows] of openRowsByProfile) {
    const localToday = today(profileId);
    const todayRows = rows.filter(
      (row) => row.start_date == null || row.start_date <= localToday
    );
    if (todayRows.length === 0) continue;
    openStateByProfile.set(profileId, {
      profileId,
      today: localToday,
      todayRow: todayRows[0],
      todayRows,
      mostRecentClosed: null,
    });
  }
  const episodeStates = episodeStatesForProfiles(
    illnessFanout.map((illnessProfile) => illnessProfile.id)
  );
  const episodeStateById = new Map(episodeStates.map((s) => [s.profileId, s]));
  const stateFor = (pid: number) => episodeStateById.get(pid)!;
  const activeEpisodes = openStateByProfile.has(profile.id)
    ? openEpisodesFromState(openStateByProfile.get(profile.id)!, {
        includeEmpty: true,
      })
    : [];
  const activeSick = activeEpisodes.length > 0;
  const otherSick = illnessProfiles.flatMap((p) =>
    openStateByProfile.has(p.id)
      ? openEpisodesFromState(openStateByProfile.get(p.id)!, {
          includeEmpty: true,
        }).map((episode, episodeOrder) => ({ p, episode, episodeOrder }))
      : []
  );

  // Disambiguate every cockpit patient's name together (#531/#534 on-element identity).
  const heroProfiles = [
    ...(activeEpisodes.length > 0 ? [profile] : []),
    ...new Map(otherSick.map((x) => [x.p.id, x.p])).values(),
  ];
  const heroNames = disambiguateProfileNames(heroProfiles);
  const nameFor = (p: { id: number; name: string }) =>
    heroNames.get(p.id) ?? p.name;

  const orderedCockpits = orderIllnessCockpits([
    ...activeEpisodes.map((episode, episodeOrder) => ({
      profileId: profile.id,
      isActive: true,
      episodeOrder,
      episodeKey: String(episode.id),
      avatar: profile,
      episode,
    })),
    ...otherSick.map((x) => ({
      profileId: x.p.id,
      isActive: false,
      episodeOrder: x.episodeOrder,
      episodeKey: String(x.episode.id),
      avatar: x.p,
      episode: x.episode,
    })),
  ]);
  const presentationCockpitByEpisode = new Map(
    assignOrderedEpisodeFacts(orderedCockpits).map((cockpit) => [
      cockpit.episode.id,
      cockpit,
    ])
  );

  const dashboardNow = clockNow();
  const cockpitModelByEpisode = new Map<number, DashboardIllnessCockpitModel>();
  const cockpitCountByProfile = new Map<number, number>();
  for (const cockpit of orderedCockpits)
    cockpitCountByProfile.set(
      cockpit.profileId,
      (cockpitCountByProfile.get(cockpit.profileId) ?? 0) + 1
    );
  for (const profileId of new Set(
    orderedCockpits.map((cockpit) => cockpit.profileId)
  )) {
    const episodes = orderedCockpits
      .filter((cockpit) => cockpit.profileId === profileId)
      .map((cockpit) => cockpit.episode);
    const presentationEpisodes = orderedCockpits
      .filter((cockpit) => cockpit.profileId === profileId)
      .map(
        (cockpit) =>
          presentationCockpitByEpisode.get(cockpit.episode.id)!.episode
      );
    const gathered = gatherDashboardIllnessCockpits(profileId, episodes, {
      canWrite: scope.access.get(profileId) === "write",
      temperatureUnit: units.temperatureUnit,
      weightUnit: units.weightUnit,
      now: dashboardNow,
      presentationEpisodes,
    });
    for (const [episodeId, model] of gathered)
      cockpitModelByEpisode.set(episodeId, model);
  }

  const heroCockpits: HeroCockpit[] = orderedCockpits.map((c) => {
    const presentation = presentationCockpitByEpisode.get(c.episode.id);
    if (!presentation)
      throw new Error(`Missing dashboard illness presentation ${c.episode.id}`);
    const displayEpisode = presentation.episode;
    const model = cockpitModelByEpisode.get(c.episode.id);
    if (!model)
      throw new Error(`Missing dashboard illness cockpit ${c.episode.id}`);
    const key = `${c.profileId}:${c.episodeKey}`;
    const temperatureId = displayEpisode.latestTemp?.id;
    const latestDose = episodeLatestDose(displayEpisode)?.id;
    const clinicalStatus = episodeCollapsedStatus(
      c.episode,
      units.temperatureUnit,
      {
        timeZone: getTimezone(c.profileId),
        timeFormat: formatPrefs.timeFormat,
        now: clockNow(),
      }
    );
    const displayStatus = episodeCollapsedStatus(
      displayEpisode,
      units.temperatureUnit,
      {
        timeZone: getTimezone(c.profileId),
        timeFormat: formatPrefs.timeFormat,
        now: clockNow(),
      }
    );
    return {
      episodeKey: key,
      episodeOrder: c.episodeOrder,
      profileId: c.profileId,
      profile: c.avatar,
      displayName: nameFor(c.avatar),
      situation: c.episode.situation,
      isActive: c.isActive,
      canWrite: scope.access.get(c.profileId) === "write",
      stateIdentity: careCandidates.illnessStateIdentity(key),
      temperatureIdentity:
        temperatureId == null
          ? null
          : careCandidates.illnessReadingIdentity(
              "temperature",
              key,
              temperatureId
            ),
      medicationIdentity:
        latestDose == null
          ? null
          : careCandidates.illnessReadingIdentity(
              "medication",
              key,
              latestDose
            ),
      status: {
        ...clinicalStatus,
        worsening: displayStatus.worsening,
        temperature: displayStatus.temperature,
        lastMeds: displayStatus.lastMeds,
      },
      feverFree: model.feverFree,
      episodeHref: episodeHref(c.episode.id),
      body: (
        <IllnessCockpitBody
          profileId={c.profileId}
          episode={displayEpisode}
          crossProfile={!c.isActive}
          canWrite={scope.access.get(c.profileId) === "write"}
          ownsSharedProfileControls={c.episodeOrder === 0}
          hasPluralOpenEpisodes={
            (cockpitCountByProfile.get(c.profileId) ?? 0) > 1
          }
          profileDisplayName={nameFor(c.avatar)}
          model={model}
          temperatureIdentity={
            displayEpisode.latestTemp?.id == null
              ? null
              : careCandidates.illnessReadingIdentity(
                  "temperature",
                  key,
                  displayEpisode.latestTemp.id
                )
          }
          medicationIdentity={
            latestDose == null
              ? null
              : careCandidates.illnessReadingIdentity(
                  "medication",
                  key,
                  latestDose
                )
          }
        />
      ),
    };
  });
  const heroUi = getIllnessHeroUi(profile.id);

  // Recently-resolved reopen affordance (issue #1140 Part A): for the viewer and every
  // bounded household member, the most-recent episode still inside its 7-day reopen
  // window (the SAME episodeReopenEligibility rule the detail page uses). Cross-profile
  // aware like the hero (#858) — each row reopens that member's episode via its
  // profileId. Calm/dismissible, never dashboard Now (#449). Names disambiguated
  // across the accessible set (#531).
  //
  // Derived from the ONE episode gather above (#2115) and bounded by the shared illness
  // fan-out (#2446), with the viewer always included.
  //
  // Filtered SERVER-SIDE against the viewer's stored dismissals (#1548): the X used to
  // be client state only, so a hidden line came back on the next reload. The client
  // component still hides optimistically, but this list is now the truth — and it is
  // also what decides where the household-history promo goes (#1549), which is why the
  // filter has to happen here rather than in the browser.
  const reopenNames = disambiguateProfileNames(accessible);
  const recentlyResolvedAll: RecentlyResolvedItem[] = illnessFanout
    .map((p) => ({ p, ep: reopenEligibleFromState(stateFor(p.id)) }))
    .filter(
      (
        x
      ): x is {
        p: (typeof accessible)[number];
        ep: NonNullable<ReturnType<typeof reopenEligibleFromState>>;
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
  // (a single-profile login has no household to merge). Reads the LITERAL SAME rows the
  // illness context and reopen facts read — one gather, three derivations (#2115); the comment
  // here used to claim that reuse while isHouseholdRecentlySick re-issued both SELECTs
  // per profile. Bounded by the same illness fan-out, viewer included (#2446).
  // It is a link, NOT a notification and NOT a finding (no dedupeKey, no bus): it appears
  // because it's useful and disappears on its own.
  //
  // The typed login-scoped candidate survives the active-profile scope boundary and
  // lands once in Show everything. It remains a calm link, not a finding or send.
  const promoteHouseholdHistory =
    accessible.length > 1 && isHouseholdRecentlySickFromStates(episodeStates);

  // weight-trend: the deduped one-source-per-day series (getBodyMetricDailySeries,
  // #14/#395) — NOT raw all-source rows, which double back the line on a two-device
  // day and disagree with the body census this widget links to. Windowed by DATE
  // (a deliberate trailing-90-day glance) rather than the old undisclosed 60-row cap.
  const weightTrendSince = shiftDateStr(on, -(WEIGHT_TREND_WINDOW_DAYS - 1));
  // The UNWINDOWED series is kept: its newest day is the weight domain's last record,
  // which is what separates "never weighed" from "stopped weighing" below (#2652). The
  // card and the dormancy verdict therefore read one computation, not two (#221).
  const weightSeries = true
    ? getBodyMetricDailySeries(profile.id, "weight", ALL_ROWS)
    : [];
  const latestWeightPoint = weightSeries.at(-1) ?? null;
  const weightSource = latestWeightPoint
    ? getBodyMetricSeriesBySource(profile.id, "weight", 1).find((series) =>
        series.data.some(
          (point) =>
            point.date === latestWeightPoint.date &&
            point.value === latestWeightPoint.value
        )
      )?.source
    : null;
  const weightEngagement = engagementFromSource(weightSource);
  const bodyMetrics = weightSeries
    .filter((p) => p.date >= weightTrendSince)
    .map((p) => ({
      date: p.date,
      value: dispWeight(p.value, units.weightUnit),
    }));

  // healthspan-pillars (issue #161): the visible longevity pillars, each consuming
  // its already-merged source computation. buildPillars omits an absent pillar, so
  // an empty array means no pillar has data yet (the data-aware CTA below).
  const pillars = adultContentApplicable
    ? getHealthspanPillars(profile.id)
    : [];

  // sleep-last-night (issue #1066): the morning "how did I sleep" tile — the SAME
  // lastNightSummary model the /sleep hero reads (one question, one computation),
  // with the SRI alongside as the second figure. Null summary → the data-aware CTA.
  const sleepSummary = true ? getLastNightSummary(profile.id) : null;
  const sleepPresentation = sleepSummary
    ? sleepRecordPresentation(sleepSummary.wakeDay, on, formatPrefs)
    : null;
  // The morning waiting window (#2097). When it is open, the tile names the state
  // INSTEAD of showing a headline duration for a night nobody asked about — the
  // recorded night drops to a quiet secondary line and stays one tap away on /sleep.
  // Null (the common case) leaves every existing branch exactly as it was.
  const sleepWaiting = true
    ? getSleepWaitingState(profile.id, sleepSummary?.wakeDay ?? null)
    : null;
  const typicalWakeMinutes = sleepWaiting ? typicalWakeTime(profile.id) : null;
  const sleepPreviousNightLabel =
    sleepSummary && sleepPresentation?.freshness === "recent"
      ? `${sleepPresentation.label} · ${formatHm(sleepSummary.durationMin)}`
      : null;
  // naps-today: the detailed nap model the Sleep page also renders. A normal
  // no-nap day self-hides this contextual widget; once a nap syncs, every window
  // and the combined duration appear without changing the main-sleep card.
  const todayNaps = getNapHistory(profile.id, 1).today;

  // Recent clinical results: rank every canonical member in the shared
  // recentLabHighlights order (that order is unchanged), then mint candidates for
  // the rows the dashboard can actually seat — the Standing registry's capped
  // membership, plus any marker whose promotion is live. The tail beyond the cap
  // is not a dashboard fact in any lane (#3186); /results owns the full census.
  //
  // The promotion union is what makes the cap safe: with the cap already full of
  // notable markers, a marker that has JUST become notable sits outside the top
  // rows, and a plain slice would silently drop its Now card.
  let labRows: RecentLabRow[] = [];
  const labPromotions = new Map<
    string,
    { changed: boolean; sharedFactKey?: string }
  >();
  {
    const observations = getDashboardClinicalObservations(profile.id);
    const activeAttentionKeys = new Set(attention.map((item) => item.key));
    for (const observation of observations) {
      const name = observation.canonical_name?.trim() || observation.name;
      const findingKey = biomarkerFlagDismissalKey(name);
      const changed =
        activeAttentionKeys.has(findingKey) &&
        clinicalResultBecameNotable(
          observation.flag,
          observation.previous_id == null
            ? undefined
            : observation.previous_flag
        );
      labPromotions.set(name, {
        changed,
        ...(changed
          ? {
              sharedFactKey: `upcoming.${findingKey}`,
            }
          : {}),
      });
    }
    labRows = cappedFamilyGather(
      recentLabHighlights(observations, Number.MAX_SAFE_INTEGER, on),
      CLINICAL_RESULTS_CAP,
      (row) => labPromotions.get(row.name)?.changed === true
    );
  }

  // next-appointment (medical): the single most attention-worthy scheduled visit,
  // via the SHARED pickNextAppointment (issue #303 — dashboard placement and the
  // household card must answer "the profile's next appointment" identically). Its
  // policy is overdue-first: a still-scheduled past visit outranks a future one.
  let nextAppt: NextAppointment | null = null;
  let hasScheduledAppt = false;
  {
    // getScheduledAppointments already orders by date ASC, time_of_day ASC, id ASC,
    // so the picker's same-day tie-break lands on the earliest slot — matching the
    // household card, which feeds the same source ordering.
    const scheduled = getScheduledAppointments(profile.id).map((a) => ({
      appt: a,
      dueDate: a.date,
    }));
    hasScheduledAppt = scheduled.length > 0;
    const soonest = pickNextAppointment(scheduled)?.appt;
    if (soonest) {
      const d = soonest.date;
      const detailParts = [soonest.provider_name, soonest.location].filter(
        Boolean
      );
      // Render date AND clock time through the login's prefs (#1215) — a timed
      // row shows the wall-clock; a day-only one degrades to the long date. The
      // card links to the resulting encounter once one exists, else the visits
      // list (the same target the header uses).
      const visitsHref: AppRoute = "/records/history/visits";
      nextAppt = {
        title: soonest.title?.trim() || soonest.provider_name || "Appointment",
        whenLabel: formatRecordDateTime(
          soonest.date,
          soonest.time_of_day,
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

  // Outcome goals and weekly targets remain individual facts. Their shared source
  // models own member order; the Standing registry owns the visible family caps.
  const goals = trainingRelevant
    ? getOutcomeGoals(profile.id).filter((g) => isGoalLive(g))
    : [];
  const goalProgress = true
    ? getOutcomeGoalProgressMap(profile.id, goals)
    : new Map();

  const freqTargets = true
    ? getFrequencyTargetProgress(profile.id).filter(
        ({ target }) =>
          (trainingRelevant ||
            dashboardHabitDomain(target.scope_kind) !== "training") &&
          (strengthTrainingAvailable || !isStrengthProgrammingScope(target))
      )
    : [];
  const orderedFreqTargets = [
    ...summarizeDashboardHabits(freqTargets).open,
    ...freqTargets.filter((progress) => progress.met),
  ];

  // coaching: ranked, rule-based recommendations from the profile's own history
  // (deterministic, no AI), filtered to age-appropriate guidance at every life stage.
  // Snoozed recommendations (findings bus, #39) drop out here, so a "Not today"
  // on the top rec surfaces the next-ranked one until the snooze expires.
  const coachingSuppressions = getFindingSuppressions(profile.id);
  const coachingInput = trainingRelevant
    ? strengthAppropriateCoachingInput(
        gatherCoachingInput(
          profile.id,
          units.weightUnit,
          units.distanceUnit,
          // The login's temperature scale (#1967): a °F reader sees the weather-parking
          // figure in °F here. The notification path keeps canonical °C.
          units.temperatureUnit
        ),
        strengthTrainingAvailable
      )
    : null;
  const coachingRecs = coachingInput
    ? activeByKey(
        recommendCoaching(coachingInput).filter(
          (recommendation) =>
            strengthTrainingAvailable || recommendation.kind !== "strength"
        ),
        (r) => coachingDedupeKey(r.id),
        coachingSuppressions,
        on
      )
    : [];
  // Today's all-day training-result transitions reuse the same cached history
  // gathers coaching already paid for. Strength asks for the load-context
  // projection (the underlying all-history scan is request-cached); cardio uses
  // the same unit-scoped cardio aggregate gatherCoachingInput reads. No
  // per-record query or second classifier.
  const todayStrengthRecords = strengthTrainingAvailable
    ? activeByKey(
        recentPRs(getStrengthByExercise(profile.id, true), on, 0),
        (record) =>
          prStrengthDismissalKey(
            record.exercise,
            record.equipmentId,
            record.kind
          ),
        coachingSuppressions,
        on
      )
    : [];
  const todayCardioRecords = coachingInput
    ? activeByKey(
        recentCardioPRs(
          getCardioByActivity(profile.id, units.distanceUnit),
          on,
          0
        ),
        (record) => prCardioDismissalKey(record.activity, record.kind),
        coachingSuppressions,
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
  // relevance set is computed over what it actually renders. Hiding the Data quality
  // widget drops its family back into the rollup, where the same declared relevance
  // floor decides whether it has earned reach.
  //
  // DISMISSAL FATIGUE (#2386). The dashboard is the ROUTINE surface for these — the
  // place a finding leads without being asked for — so it is where repeat dismissal is
  // read as an answer. `routineOrder` reranks the already-filtered set over the SAME
  // suppression map: a topic the user has declined across two separate raisings drops
  // behind everything unfatigued, and a topic declined across four leaves this surface
  // entirely. Nothing is silenced — every one of them still renders on its own tab,
  // which is where the user goes looking, and the shared bus is untouched.
  const activeCoaching = true
    ? routineOrder(
        activeFindings(
          collectCoachingFindings(
            profile.id,
            on,
            units.weightUnit,
            formatPrefs
          ),
          coachingSuppressions,
          on
        ).filter((finding) => {
          const strengthTrainingFinding =
            finding.domain === "training-strength" ||
            finding.domain === "training-obs" ||
            finding.domain === "muscle-volume" ||
            finding.domain === "fitness-check";
          return (
            !strengthTrainingFinding ||
            (trainingRelevant && strengthTrainingAvailable)
          );
        }),
        coachingSuppressions
      )
    : [];
  const coachingObservations = coachingObservationFindings(activeCoaching);
  const dataQualityFindings = activeCoaching.filter(
    isDataQualityDashboardFinding
  );

  // weekly-recap — the last period at the profile's chosen recap cadence (#2178),
  // rule-based (no AI). Same gather as the recap notification, so the card and the
  // message always agree. The widget id stays `weekly-recap`: it is a persisted
  // dashboard-layout key, and renaming it would silently un-place every saved layout.
  const weeklyRecap = trainingRelevant
    ? getRecapCard(profile.id, units.weightUnit)
    : null;

  // nutrition-today (#1221): today's protein against the goal band + the weekly average
  // — the SAME getProteinToday model the Food-tab gauge and the food-nudge read (#221).
  // Null when there's no target (no bodyweight) or no protein data → the data-aware CTA.
  const proteinToday = foodLoggingApplicable
    ? getProteinToday(profile.id)
    : null;

  // THE COMPOSED MORNING ONE-TAP (#2458) — the food half of the "your usual <window>"
  // offer plus the doses this profile DECLARED for that window and still owes today.
  //
  // Relevance is TRANSIENT and computed here, like the other `available` gates: it is a
  // pure function of today's state, so it collapses the moment everything it names is
  // logged and comes back if the servings are undone. Nothing about it is persisted and
  // it never reaches the hidden set.
  //
  // The window is `currentFoodSlot` — the FOOD-slot clock, deliberately not
  // `currentTimeBucket` (the divergence is documented at lib/food-slot.ts:11): this
  // offer is food-anchored, so it takes the food side. `getUsualRoutineOffer` evaluates
  // that half first and returns before touching intake at all when it does not stand,
  // so the dashboard pays the dose reads only on the mornings the control renders.
  //
  // Read-only access renders no control at all. The action gates on
  // `requireWriteAccess` regardless, so this is presentation rather than security —
  // but offering a caregiver-view a button that can only refuse is worse than offering
  // nothing.
  const routineWindow =
    foodLoggingApplicable && access === "write"
      ? currentFoodSlot(profile.id)
      : null;
  const routineOffer =
    routineWindow != null
      ? getUsualRoutineOffer(profile.id, routineWindow, on)
      : null;
  // The label names every write, in display names: a slug is not a promise anybody can
  // read. The subject line follows writeSubjectName so a caregiver acting on another
  // profile is never ambiguous about whose morning this logs (#1013).
  const routineControl = routineOffer
    ? {
        window: routineOffer.window,
        food: routineOffer.groups.map((slug) => ({
          slug,
          name: foodGroupBySlug(slug)?.name ?? slug,
        })),
        doses: routineOffer.doses.map((d) => ({
          id: d.doseId,
          name: d.name,
          stack: d.stack ?? null,
        })),
        subjectName: actingSubjectName,
      }
    : null;

  // steps-today (#1221): today's steps vs the prior 7 days, a formatter over
  // summarizeStepsToday fed by the deduped one-source-per-day steps series (#14/#221).
  // Empty series → the data-aware CTA (connect a source).
  const stepsRows = getMetricDailyTotals(profile.id, "steps");
  const stepsSummary =
    stepsRows.length > 0 ? summarizeStepsToday(stepsRows, on) : null;

  // vitals-latest (#1221): the latest BP + resting HR readings with a trend arrow, over
  // the SAME series queries behind Trends → Vitals, each reduced via the shared
  // latestTrend helper and framed by the per-quantity presentation floor (#2303) — the
  // whole model is `getVitalsLatestModel` (#221), which the DB tier pins end to end.
  // Null components self-omit; an all-null model is the data-aware CTA.
  const vitalsModel = getVitalsLatestModel(profile.id, on);

  // cycle-phase (#1221): "Cycle day N · <phase>". Relevance-gated in the registry. Since
  // #1679 the tile also carries the PROJECTED next-period window — the SAME
  // getCycleForecast the Cycle surface reads, so the tile and the page can never show
  // different windows.
  //
  // Since #1892 the tile no longer self-hides when no phase is derivable: that was the
  // state of someone who has not logged day 1 yet, so it hid exactly when logging
  // mattered most. It is now DATA-AWARE — the CTA variant of the same card — and it
  // carries the ONE cycle offer, resolved here ONCE (`cycleControlState`) and handed
  // down as data. The Cycle page control and the quick-log sheet render that same
  // state; none of the three re-derives it.
  //
  // Since #2801 the DAY AND PHASE arrive on that same control state rather than from a
  // second pair of calls here. The tile syndicated "Cycle day 141 · Follicular" to a
  // profile 20 weeks pregnant precisely because those calls were the ones nobody handed
  // the suspension to — the tile's forecast line honoured it and silently vanished, so
  // the tile went on making the stronger claim after the weaker one had withdrawn.
  const cyclePeriods = cycleApplicable ? listCyclePeriods(profile.id) : [];
  const cycleForecast =
    cyclePeriods.length > 0 ? getCycleForecast(profile.id, on) : null;
  const cycleControl = cycleApplicable
    ? cycleControlState(cyclePeriods, on, getForecastSuspension(profile.id))
    : null;
  const cycleModel =
    cycleControl?.day != null && cycleControl.phase != null
      ? { day: cycleControl.day, phase: cycleControl.phase }
      : null;

  // symptom-log meds branch (#1221): the folded PRN quick-log. Shown ONLY on a WELL day
  // with active PRN meds — when illness is active the hero cockpit above already embeds
  // the SAME logger (so we omit the branch to avoid the duplicate the old availability
  // gate hand-managed), and a profile with no active PRN meds gets no branch at all.
  const checkinPrnMeds = !activeSick
    ? getPrnMedicationsForQuickLog(profile.id)
    : [];

  // symptom-log well-day entry (#1300): a compact SymptomLogBar behind the check-in card's
  // Report reveal, so a well user (severe cramps, a headache) can log symptoms with NO
  // illness required. Shown ONLY on a WELL day — while illness is active the hero cockpit
  // above owns symptom logging (so we omit it to avoid the duplicate). Same store + the
  // suggest-only illness bridge as the Timeline bar (no temperature/day-toggle here).
  const showWellSymptoms = !activeSick;

  // active-protocols (issue #660): the ongoing N-of-1 experiments, each a formatter
  // over the SAME detail-page computations (comparison + adherence). Opt-in widget;
  // self-hides (available=false below) when nothing is ongoing.
  const activeProtocols = adultContentApplicable
    ? getActiveProtocolSummaries(profile.id, on, units.weightUnit, freqTargets)
    : [];

  // Mood entry is the quick-entry sheet; illness owns its separate care lifecycle.
  // Keep observations as individual facts so placement never hides siblings.
  const todayMood = getMoodOnDate(profile.id, on);

  // Candidate builders below format only models already gathered above. No builder
  // performs SQL, reads auth, or imports React.
  const nowMinutes = hhmmToMinutes(zonedDateParts(timezone, clockNow()).hhmm);
  // The existing mealtime-shaped anchors: the profile's intake reminder slots.
  // NOT the food log — `food_log_events.recorded_at` is TAP time, documented as
  // explicitly not eating time, so deriving a meal distribution from it would be
  // the new engine this issue's scope guard forbids.
  const nowSlots = getNotifySchedule(profile.id).supplementMinutes;
  // This used to be gathered inside StreamLifecycleOffers. Resolve it here once
  // so the placement manifest can distinguish a live offer from normal silence.
  const streamLifecycleOffers =
    access === "write" ? getStreamLifecycleOffers(profile.id) : [];
  const nowMealAnchors = [
    nowSlots.Morning,
    nowSlots.Midday,
    nowSlots.Evening,
  ].filter((m): m is number => m != null);

  const profileSubject = { scope: "profile" as const, profileId: profile.id };
  const candidates: DashboardCandidate[] = [];
  const candidateNodes = new Map<string, ReactNode>();
  const standingPresentations = new Map<
    string,
    DashboardStandingPresentation
  >();
  const aheadPresentations = new Map<string, DashboardAheadPresentation>();
  const add = (
    candidate: DashboardCandidate,
    node: ReactNode,
    standingPresentation?: DashboardStandingPresentation
  ) => {
    candidates.push(candidate);
    candidateNodes.set(candidate.candidateId, node);
    if (standingPresentation)
      standingPresentations.set(candidate.candidateId, standingPresentation);
  };
  const addStandingOnly = (
    candidate: DashboardCandidate,
    presentation: DashboardStandingPresentation
  ) => {
    candidates.push(candidate);
    standingPresentations.set(candidate.candidateId, presentation);
  };
  let sourceOrder = 0;

  const attentionBadgeCount = attentionBadgeItems(attention, on).length;
  const attentionItems = [...attention];
  for (const candidate of attentionCandidates(
    profileSubject,
    attentionItems,
    on
  )) {
    const item = attentionItems.find(
      (entry) =>
        dashboardAttentionCandidateId(entry.key) === candidate.candidateId
    )!;
    aheadPresentations.set(candidate.candidateId, {
      label: item.title,
      detail: upcomingDueText(item, on, formatPrefs),
      href: item.href,
    });
    add(
      candidate,
      <DashboardAttentionAtom
        item={item}
        today={on}
        formatPrefs={formatPrefs}
        canWrite={canWrite}
      />
    );
  }
  sourceOrder += attentionItems.length;

  // Preventive review candidates (#3025): one fact per open record/rule pair
  // riding on a due preventive item, keyed `preventive-review:<recordId>:
  // <ruleKey>`. The builder bars them from the Now lane structurally (all rank
  // reasons false, obligation "may"), so they can only render here in the
  // exhaustive Show everything remainder — the same confirm-the-date / dismiss controls
  // the Upcoming row shows beside the due item, and never a send.
  for (const item of attentionItems) {
    for (const offer of item.preventiveReview ?? []) {
      add(
        preventiveReviewCandidate(profileSubject, offer, sourceOrder++),
        <PreventiveReviewAtom
          title={item.title}
          recordId={offer.recordId}
          ruleKey={offer.ruleKey}
          recordName={offer.recordName}
          recordDate={offer.recordDate}
          today={on}
          profileId={profile.id}
          canWrite={canWrite}
        />
      );
    }
  }

  if (workoutPresence?.state === "active") {
    add(
      setupCandidates.liveWorkout(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        workoutPresence.activityId
      ),
      <DashboardAtomCard
        title="Workout in progress"
        href="/training"
        actionLabel="Continue"
      />
    );
  }

  for (const cockpit of heroCockpits) {
    const key = cockpit.episodeKey;
    const href = cockpit.episodeHref ?? "/timeline";
    const groupKey = `illness.episode:${key}`;
    const episodeGroup = {
      kind: "illness-episode" as const,
      groupKey,
      episodeKey: cockpit.episodeKey,
      profileId: cockpit.profileId,
      episodeOrder: cockpit.episodeOrder,
    };
    const stateDetail = [
      cockpit.status.worsening ? "Symptoms worsening" : null,
      cockpit.feverFree?.label ?? null,
    ]
      .filter(Boolean)
      .join(" · ");
    add(
      careCandidates.illnessState(
        {
          subject: { scope: "profile", profileId: cockpit.profileId },
          sourceOrder: sourceOrder++,
        },
        key,
        { ...episodeGroup, memberRole: "state", memberOrder: 0 }
      ),
      <DashboardAtomCard
        title={`${cockpit.displayName} is sick`}
        value={cockpit.status.dayLabel}
        detail={stateDetail}
        href={href}
      />
    );
    if (cockpit.status.temperature) {
      add(
        careCandidates.illnessReading(
          {
            subject: { scope: "profile", profileId: cockpit.profileId },
            sourceOrder: sourceOrder++,
          },
          "temperature",
          key,
          cockpit.status.temperature.id,
          { ...episodeGroup, memberRole: "reading", memberOrder: 0 }
        ),
        <DashboardAtomCard
          title={`${cockpit.displayName}'s latest temperature`}
          value={cockpit.status.temperature.value}
          detail={cockpit.status.temperature.when}
          href={href}
        />
      );
    }
    if (cockpit.status.lastMeds) {
      const medication = cockpit.status.lastMeds;
      add(
        careCandidates.illnessReading(
          {
            subject: { scope: "profile", profileId: cockpit.profileId },
            sourceOrder: sourceOrder++,
          },
          "medication",
          key,
          medication.id,
          { ...episodeGroup, memberRole: "reading", memberOrder: 1 }
        ),
        <DashboardAtomCard
          title={`${cockpit.displayName}'s latest illness medicine`}
          value={[medication.name, medication.dose].filter(Boolean).join(" · ")}
          detail={medication.when}
          href={href}
        />
      );
    }
  }

  for (const item of recentlyResolved) {
    const key = `${item.profileId}:${item.episodeId}`;
    add(
      careCandidates.illnessReopen(
        {
          subject: { scope: "profile", profileId: item.profileId },
          applicable: canWrite,
          sourceOrder: sourceOrder++,
        },
        key
      ),
      <RecentlyResolvedReopen
        items={[item]}
        dismissAction={dismissRecentlyResolved}
      />
    );
  }
  if (promoteHouseholdHistory) {
    add(
      careCandidates.householdHistory({
        subject: { scope: "login" },
        sourceOrder: sourceOrder++,
      }),
      <div className="card">
        <HouseholdHistoryPromoLink />
      </div>
    );
  }

  for (const offer of streamLifecycleOffers) {
    add(
      setupCandidates.streamOffer(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        offer.key
      ),
      <StreamLifecycleOffers
        profileId={profile.id}
        canWrite={access === "write"}
        offers={[offer]}
      />
    );
  }

  const finishedActivityId = workoutPresence?.activityId;
  if (showRecapCard && finishedRecap && finishedActivityId != null) {
    const recapFacts = [
      ["sets", `${finishedRecap.totalWorkingSets} working sets`],
      ["volume", `${Math.round(finishedRecap.totalVolumeKg)} kg volume`],
      ...finishedRecap.exercises.map((exercise, index) => [
        `exercise-${index}`,
        exercise.exercise,
      ]),
    ] as const;
    recapFacts.forEach(([key, value], index) =>
      add(
        setupCandidates.sessionRecap(
          { subject: profileSubject, sourceOrder: sourceOrder + index },
          finishedActivityId,
          key,
          workoutPresence?.sinceMin ?? -1
        ),
        <DashboardAtomCard
          title="Session complete"
          value={value}
          href="/training"
        />
      )
    );
    sourceOrder += recapFacts.length;
  }

  todayStrengthRecords.forEach((record) => {
    const key = prStrengthDismissalKey(
      record.exercise,
      record.equipmentId,
      record.kind
    );
    add(
      progressCandidates.trainingResult(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        key,
        on,
        0
      ),
      <DashboardAtomCard
        title={loadContextLabel(record.exercise, record.equipment)}
        value={
          record.kind === "1rm"
            ? record.bodyweight
              ? `BW × ${record.reps}`
              : `${fmtWeight(record.weightKg, units.weightUnit)} × ${record.reps}`
            : `${fmtWeight(record.weightKg, units.weightUnit)} top`
        }
        detail="New personal record"
        href="/training?tab=analyze"
      />
    );
  });
  todayCardioRecords.forEach((record) => {
    const key = prCardioDismissalKey(record.activity, record.kind);
    const value =
      record.kind === "distance"
        ? fmtDistance(record.distanceKm, units.distanceUnit)
        : record.kind === "speed"
          ? fmtKmh(record.speedKmh, units.distanceUnit)
          : formatMinutes(record.durationMin);
    add(
      progressCandidates.trainingResult(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        key,
        on,
        0
      ),
      <DashboardAtomCard
        title={record.activity}
        value={value}
        detail="New personal record"
        href="/training?tab=analyze"
      />
    );
  });

  if (onboardingState && onboardingPresence) {
    const firstRemainingStep = nextOnboardingStep(
      onboardingState,
      hasOnboardingFirstValue(onboardingState.focuses, onboardingPresence)
    );
    const stepLabels = [
      "Choose who this profile is for",
      "Choose what matters most",
      "Add profile basics",
      "Add a first health value",
      "Choose notification preferences",
      "Finish profile setup",
    ] as const;
    for (
      let step = firstRemainingStep;
      step <= ONBOARDING_STEP_COUNT;
      step += 1
    ) {
      add(
        setupCandidates.onboardingStep(
          { subject: profileSubject, sourceOrder: sourceOrder++ },
          step
        ),
        <DashboardAtomCard
          title={stepLabels[step - 1]}
          detail={`Setup step ${step} of ${ONBOARDING_STEP_COUNT}`}
          href={`/onboarding?step=${step}` as AppRoute}
          actionLabel="Continue"
        />
      );
    }
    add(
      setupCandidates.onboardingProgress(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "wizard"
      ),
      <DashboardAtomCard
        title="Profile setup progress"
        value={`${firstRemainingStep - 1} of ${ONBOARDING_STEP_COUNT} steps complete`}
        href="/onboarding"
      />
    );
  }
  if (onboardingChecklist && onboardingChecklistCompletion) {
    add(
      setupCandidates.onboardingProgress(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "checklist"
      ),
      <OnboardingChecklist
        focuses={onboardingChecklist.focuses}
        completion={onboardingChecklistCompletion}
      />
    );
  }

  const moodCheckinCandidate = dailyCandidates.moodCheckin(
    {
      subject: profileSubject,
      applicable: canWrite,
      sourceOrder: sourceOrder++,
    },
    on,
    nowSlots.Evening == null
      ? { kind: "always" }
      : localTimeWindow(nowSlots.Evening, 1439),
    todayMood == null
  );
  add(
    moodCheckinCandidate,
    <DashboardQuickEntryAction
      title={todayMood ? "Update today's mood" : "Log today's mood"}
      detail={
        isMoodCheckinPaused({
          enabled: getProfileMoodCheckin(profile.id),
          ignoredCount: getMoodCheckinIgnored(profile.id),
        })
          ? "Daily reminders are paused."
          : undefined
      }
      form="mood"
    />
  );
  aheadPresentations.set(moodCheckinCandidate.candidateId, {
    label: todayMood ? "Update today's mood" : "Log today's mood",
    ...(nowSlots.Evening == null
      ? {}
      : {
          detail: `Opens ${formatClockMinutes(
            formatPrefs.timeFormat,
            nowSlots.Evening
          )}`,
        }),
  });

  if (todayMood) {
    const moodReadings = [
      ["valence", "Mood", `${todayMood.valence} of 5`],
      [
        "energy",
        "Energy",
        todayMood.energy == null ? null : `${todayMood.energy} of 5`,
      ],
      [
        "calm",
        "Calm",
        todayMood.anxiety == null ? null : `${6 - todayMood.anxiety} of 5`,
      ],
    ] as const;
    moodReadings.forEach(([key, title, value], index) => {
      if (value == null) return;
      add(
        dailyCandidates.moodReading(
          { subject: profileSubject, sourceOrder: sourceOrder + index },
          key,
          on
        ),
        <DashboardAtomCard title={title} value={value} href="/trends#body" />
      );
    });
    sourceOrder += moodReadings.length;
  }

  checkinPrnMeds.forEach((med, index) =>
    add(
      dailyCandidates.prn(
        {
          subject: profileSubject,
          applicable: canWrite && !activeSick,
          sourceOrder: sourceOrder + index,
        },
        med.id
      ),
      <div className="card">
        <QuickLogPrnContent
          meds={[med]}
          tz={timezone}
          timeFormat={formatPrefs.timeFormat}
          title="Log a dose"
          compact
          showPageLink={false}
        />
      </div>
    )
  );
  sourceOrder += checkinPrnMeds.length;

  if (showWellSymptoms) {
    add(
      dailyCandidates.symptomLog(
        {
          subject: profileSubject,
          applicable: canWrite,
          sourceOrder: sourceOrder++,
        },
        on
      ),
      <div className="card">
        <SymptomLogBar
          date={on}
          initial={getSymptomSeveritiesOnDate(profile.id, on)}
          initialNotes={getSymptomNotesOnDate(profile.id, on)}
          symptoms={PICKER_SYMPTOMS}
          customNames={getCustomSymptomNames(profile.id)}
          rankedKeys={getSymptomLogOrder(profile.id)}
          suggestActivateIllness={!hasActiveIllnessSituation(profile.id)}
          temperatureUnit={units.temperatureUnit}
          textIntakeEnabled={isTaskConfigured("symptom-map")}
        />
      </div>
    );
  }

  coachingRecs.forEach((rec, index) =>
    add(
      progressCandidates.statement(
        {
          subject: profileSubject,
          applicable: trainingRelevant,
          sourceOrder: sourceOrder + index,
        },
        "coaching.recommendation",
        rec.id,
        `coaching.${coachingDedupeKey(rec.id)}`
      ),
      <CoachingWidget recs={[rec]} />
    )
  );
  sourceOrder += coachingRecs.length;

  goals.forEach((goal, index) => {
    const pct = goalPct(goal, goalProgress.get(goal.id));
    add(
      progressCandidates.goal(
        { subject: profileSubject, sourceOrder: sourceOrder + index },
        goal.id,
        outcomeGoalProgressChanged(goal, goalProgress.get(goal.id), on)
      ),
      <GoalsHabitsWidget
        goals={[goal]}
        goalProgress={goalProgress}
        freqTargets={[]}
        today={on}
        trainingRelevant={trainingRelevant}
        showLogActions={false}
      />,
      {
        label: goal.title,
        value: pct == null ? "In progress" : `${pct}%`,
        href: "/training?tab=goals",
        presence: "current",
      }
    );
  });
  sourceOrder += goals.length;
  orderedFreqTargets.forEach((progress, index) => {
    const id = progress.target.id;
    add(
      progressCandidates.targetProgress(
        { subject: profileSubject, sourceOrder: sourceOrder + index * 2 },
        id,
        !progress.met,
        weeklyTargetStateChanged(progress, progress.previous ?? null)
      ),
      <GoalsHabitsWidget
        goals={[]}
        goalProgress={new Map()}
        freqTargets={[progress]}
        today={on}
        trainingRelevant={trainingRelevant}
        showLogActions={false}
      />,
      {
        label: frequencyScopeLabel(
          progress.target.scope_kind,
          progress.target.scope_value
        ),
        value: `${progress.count} of ${progress.per_week}`,
        detail: "this week",
        href:
          dashboardHabitDomain(progress.target.scope_kind) === "food"
            ? "/nutrition"
            : dashboardHabitDomain(progress.target.scope_kind) === "practice"
              ? "/wellness"
              : "/training?tab=goals",
        presence: "current",
      }
    );
    add(
      progressCandidates.targetLog(
        {
          subject: profileSubject,
          applicable: canWrite && !progress.met,
          sourceOrder: sourceOrder + index * 2 + 1,
        },
        id,
        on,
        progress.pace === "behind",
        // A moment, not the whole week (#3224). "Unmet" spans seven days, so
        // spelling the window `!met` kept every open target parked in Now and put
        // "Nothing needs you." out of reach. The rhythm answers when this target
        // normally gets done; with no rhythm there is no moment to open.
        frequencyTargetLogWindowOpen(
          profile.id,
          progress.target,
          on,
          nowMinutes
        )
      ),
      <DashboardAtomCard
        title={`Log ${progress.target.scope_value}`}
        detail={`${progress.count} of ${progress.per_week} this week`}
        href={
          dashboardHabitDomain(progress.target.scope_kind) === "food"
            ? "/nutrition"
            : "/training"
        }
        actionLabel="Log"
      />
    );
  });
  sourceOrder += orderedFreqTargets.length * 2;

  activeProtocols.forEach((protocol, index) => {
    add(
      progressCandidates.protocol(
        {
          subject: profileSubject,
          applicable: adultContentApplicable,
          sourceOrder: sourceOrder + index * 4,
        },
        "state",
        protocol.id
      ),
      <DashboardAtomCard
        title={protocol.name}
        value={`${protocol.daysElapsed} days`}
        href={protocol.href}
      />
    );
    if (protocol.adherence)
      add(
        progressCandidates.protocol(
          {
            subject: profileSubject,
            sourceOrder: sourceOrder + index * 4 + 1,
          },
          "adherence",
          protocol.id
        ),
        <DashboardAtomCard
          title={`${protocol.name} adherence`}
          value={protocol.adherence.label}
          href={protocol.href}
        />
      );
    if (protocol.primaryOutcome)
      add(
        progressCandidates.protocol(
          {
            subject: profileSubject,
            sourceOrder: sourceOrder + index * 4 + 2,
          },
          "outcome",
          protocol.id
        ),
        <DashboardAtomCard
          title={protocol.primaryOutcome.label}
          value={protocol.primaryOutcome.framing}
          href={protocol.href}
        />
      );
    if (protocol.practice && protocol.practiceUsuallyToday && canWrite)
      add(
        progressCandidates.protocol(
          {
            subject: profileSubject,
            sourceOrder: sourceOrder + index * 4 + 3,
          },
          "practice",
          protocol.id,
          on,
          protocol.practiceUsuallyToday
        ),
        <DashboardAtomCard
          title={`Log ${protocol.practice.value}`}
          href={protocol.href}
          actionLabel="Open"
        />
      );
  });
  sourceOrder += activeProtocols.length * 4;

  for (const finding of dataQualityFindings) {
    add(
      progressCandidates.statement(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "data-quality.finding",
        finding.dedupeKey,
        `finding.${finding.dedupeKey}`
      ),
      <DataQualityWidget findings={[finding]} />
    );
  }

  if (proteinToday)
    add(
      dailyCandidates.protein(
        {
          subject: profileSubject,
          applicable: foodLoggingApplicable,
          sourceOrder: sourceOrder++,
        },
        on,
        proteinToday.todayIntake?.basis === "tracked" ? "external" : "manual",
        mealTimeWindows(nowMealAnchors)
      ),
      <NutritionTodayWidget today={proteinToday} routine={null} />,
      {
        value: `${proteinToday.todayIntake?.basis === "tracked" ? "" : "≥ "}${Math.round(proteinToday.todayGrams)} g`,
        detail: [
          `Goal ${proteinTargetSummary(proteinToday.target)}`,
          proteinToday.trailing.grams != null && !proteinToday.trailing.dayOne
            ? `7-day average ${Math.round(proteinToday.trailing.grams)} g/day`
            : null,
          `From ${proteinToday.todayIntake ? proteinBasisPhrase(proteinToday.todayIntake.basis) : "logged foods"}${proteinToday.todayIntake?.basis === "tracked" ? "" : " — a floor, actual likely higher"}`,
        ]
          .filter(Boolean)
          .join(" · "),
        href: "/nutrition",
        presence: "current",
      }
    );
  else if (foodLoggingApplicable)
    addStandingOnly(
      dailyCandidates.nutritionBootstrap({
        subject: profileSubject,
        applicable: canWrite,
        sourceOrder: sourceOrder++,
      }),
      {
        detail: "No food logged yet.",
        href: "/nutrition",
        actionLabel: "Log food",
        presence: "never",
      }
    );
  if (routineControl)
    add(
      dailyCandidates.usualRoutine(
        {
          subject: profileSubject,
          applicable: foodLoggingApplicable,
          sourceOrder: sourceOrder++,
        },
        routineControl.window,
        on,
        mealTimeWindows(nowMealAnchors)
      ),
      <NutritionTodayWidget today={null} routine={routineControl} />
    );

  if (stepsSummary)
    addStandingOnly(
      dailyCandidates.steps(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        on
      ),
      {
        value:
          stepsSummary.today == null
            ? "No steps logged yet today"
            : stepsSummary.today.toLocaleString("en-US"),
        detail:
          [
            stepsSummary.average7 == null
              ? null
              : `Prior 7 days · ${stepsSummary.average7.toLocaleString("en-US")} steps a day`,
            stepsSummary.deltaPct == null
              ? null
              : `${stepsSummary.deltaPct > 0 ? "+" : ""}${stepsSummary.deltaPct}% vs prior 7 days`,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        href: "/trends#body",
        presence: "current",
      }
    );
  else
    addStandingOnly(
      dailyCandidates.stepsBootstrap({
        subject: profileSubject,
        applicable: canWrite,
        sourceOrder: sourceOrder++,
      }),
      {
        detail: "No step data yet.",
        href: "/integrations/health-connect",
        actionLabel: "Connect a source",
        presence: "never",
      }
    );

  if (vitalsModel?.bp)
    addStandingOnly(
      dailyCandidates.vital(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "blood-pressure",
        vitalsModel.bp.date
      ),
      {
        value: (() => {
          const age = glanceAgeToken({
            date: vitalsModel.bp.date,
            today: on,
            freshness: vitalsModel.bp.freshness,
            form: "long",
            floorLabel: VITAL_PRESENTATION_FLOORS["blood-pressure"].label,
          });
          const direction = vitalsModel.bp.direction;
          return (
            <span
              className="inline-flex flex-wrap items-baseline gap-x-2"
              data-testid="vitals-latest-bp"
            >
              <span>{`${vitalsModel.bp.systolic}/${vitalsModel.bp.diastolic} mmHg`}</span>
              <span
                data-testid="vitals-latest-bp-age"
                data-stale={age.stale ? "true" : undefined}
                title={age.title ?? undefined}
                className={age.className}
              >
                {age.text}
              </span>
              {direction && (
                <span className="sr-only">{`${direction === "flat" ? "flat" : direction} versus previous blood pressure`}</span>
              )}
            </span>
          );
        })(),
        href: "/trends#body",
        presence: "current",
      }
    );
  if (vitalsModel?.restingHr)
    addStandingOnly(
      dailyCandidates.vital(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "resting-heart-rate",
        vitalsModel.restingHr.date
      ),
      {
        value: (() => {
          const age = glanceAgeToken({
            date: vitalsModel.restingHr.date,
            today: on,
            freshness: vitalsModel.restingHr.freshness,
            form: "long",
            floorLabel: VITAL_PRESENTATION_FLOORS["resting-hr"].label,
          });
          const direction = vitalsModel.restingHr.direction;
          return (
            <span
              className="inline-flex flex-wrap items-baseline gap-x-2"
              data-testid="vitals-latest-resting-hr"
            >
              <span>{`${vitalsModel.restingHr.value} bpm resting`}</span>
              <span
                data-testid="vitals-latest-resting-hr-age"
                data-stale={age.stale ? "true" : undefined}
                title={age.title ?? undefined}
                className={age.className}
              >
                {age.text}
              </span>
              {direction && (
                <span className="sr-only">{`${direction === "flat" ? "flat" : direction} versus previous resting heart rate`}</span>
              )}
            </span>
          );
        })(),
        href: "/trends#body",
        presence: "current",
      }
    );
  add(
    dailyCandidates.vitalLog(
      {
        subject: profileSubject,
        applicable: canWrite,
        sourceOrder: sourceOrder++,
      },
      on,
      Boolean(vitalsModel)
    ),
    <div className="card">
      <LogReadingButton label="Log a vital" />
    </div>
  );

  if (cycleModel)
    addStandingOnly(
      dailyCandidates.cyclePhase(
        {
          subject: profileSubject,
          applicable: cycleApplicable,
          sourceOrder: sourceOrder++,
        },
        on
      ),
      {
        value: `Day ${cycleModel.day}`,
        detail: cycleModel.phase,
        href: "/medical/cycles",
        presence: "current",
      }
    );
  if (cycleControl)
    add(
      dailyCandidates.cycleControl(
        {
          subject: profileSubject,
          applicable: cycleApplicable && canWrite,
          sourceOrder: sourceOrder++,
        },
        on
      ),
      <CyclePhaseWidget
        forecast={cycleForecast}
        control={cycleControl}
        showReading={false}
      />
    );

  if (nextAppt)
    add(
      careCandidates.appointment(
        {
          subject: profileSubject,
          applicable: hasScheduledAppt,
          sourceOrder: sourceOrder++,
        },
        nextAppt.href
      ),
      <NextAppointmentWidget appointment={nextAppt} />
    );

  labRows.forEach((row, index) => {
    const age = glanceAgeToken({
      date: row.date,
      today: on,
      freshness: row.freshness,
      form: "compact",
      floorLabel: RECENT_LAB_STALE_LABEL,
    });
    add(
      careCandidates.lab(
        { subject: profileSubject, sourceOrder: sourceOrder + index },
        row.name,
        labPromotions.get(row.name)
      ),
      <RecentLabsWidget rows={[row]} today={on} />,
      {
        label: row.name,
        value: (
          <MedicalValue
            value={row.value}
            unit={row.unit}
            flag={row.flag}
            showFlagLabel
          />
        ),
        detail: (
          <span
            data-testid="recent-lab-date"
            data-stale={age.stale ? "true" : undefined}
            title={age.title ?? undefined}
            className={age.className}
          >
            {age.text}
          </span>
        ),
        href: row.href,
        presence: "current",
      }
    );
  });
  sourceOrder += labRows.length;
  if (labRows.length === 0)
    add(
      careCandidates.labBootstrap({
        subject: profileSubject,
        applicable: canWrite,
        sourceOrder: sourceOrder++,
      }),
      <WidgetEmpty
        title="Clinical results"
        icon={IconFlask}
        message="No clinical results yet."
        ctaLabel="Import results"
        ctaHref="/data"
      />,
      {
        detail: "No clinical results yet.",
        href: "/data",
        actionLabel: "Import results",
        presence: "never",
      }
    );

  const lastWeightRecord = weightSeries.at(-1)?.date ?? null;
  const weightDormant =
    dormancyState({
      lastRecordDate: lastWeightRecord,
      today: on,
      domain: "weight",
    }) === "dormant";
  if (lastWeightRecord == null)
    addStandingOnly(
      progressCandidates.weightBootstrap({
        subject: profileSubject,
        applicable: canWrite,
        sourceOrder: sourceOrder++,
      }),
      {
        detail: "No weigh-ins yet.",
        href: "/trends",
        actionLabel: "Log weight",
        presence: "never",
      }
    );
  else if (weightDormant) {
    const ageDays =
      freshnessAgeDays(lastWeightRecord, on) ??
      DORMANCY_DOMAINS.weight.collapseAfterDays;
    addStandingOnly(
      progressCandidates.weightDormant(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        lastWeightRecord
      ),
      {
        detail: dormantRecordLine("weight", ageDays),
        href: "/trends",
        actionLabel: "Body metrics",
        presence: "dormant",
      }
    );
  } else {
    const latestWeight = bodyMetrics.at(-1);
    if (latestWeight)
      addStandingOnly(
        progressCandidates.weightLatest(
          { subject: profileSubject, sourceOrder: sourceOrder++ },
          latestWeight.date,
          weightEngagement
        ),
        {
          label: "Latest",
          value: `${latestWeight.value} ${units.weightUnit}`,
          detail: formatLongDate(latestWeight.date, formatPrefs),
          href: "/trends#body",
          presence: "current",
        }
      );
    addStandingOnly(
      progressCandidates.weightTrend(
        {
          subject: profileSubject,
          applicable: bodyMetrics.length > 1,
          sourceOrder: sourceOrder++,
        },
        weightTrendSince,
        on,
        weightEngagement
      ),
      {
        label: "Trend",
        value: "View trend",
        href: "/trends#body",
        presence: "current",
      }
    );
    add(
      progressCandidates.weightQuickAdd(
        {
          subject: profileSubject,
          applicable: canWrite,
          sourceOrder: sourceOrder++,
        },
        on
      ),
      <WeightQuickAddWidget
        latest={latestWeight ?? null}
        weightUnit={units.weightUnit}
        today={on}
        subjectName={actingSubjectName}
      />
    );
  }

  const lastSleepRecord =
    sleepSummary?.wakeDay ?? getLastSleepRecordDate(profile.id);
  const sleepDormant =
    dormancyState({
      lastRecordDate: lastSleepRecord,
      today: on,
      domain: "sleep",
    }) === "dormant";
  if (sleepWaiting)
    add(
      sleepCandidates.waiting(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        on,
        localTimeWindow(
          typicalWakeMinutes ?? 420,
          (typicalWakeMinutes ?? 420) + 180
        )
      ),
      <SleepWaitingWidget
        state={sleepWaiting}
        formatPrefs={formatPrefs}
        previousNightLabel={sleepPreviousNightLabel}
      />
    );
  else if (lastSleepRecord == null)
    addStandingOnly(
      sleepCandidates.bootstrap({
        subject: profileSubject,
        sourceOrder: sourceOrder++,
      }),
      {
        detail: "No sleep recorded yet.",
        href: "/data",
        actionLabel: "Sync a source",
        presence: "never",
      }
    );
  else if (sleepDormant) {
    const ageDays =
      freshnessAgeDays(lastSleepRecord, on) ??
      DORMANCY_DOMAINS.sleep.collapseAfterDays;
    addStandingOnly(
      sleepCandidates.dormant(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        lastSleepRecord
      ),
      {
        detail: dormantRecordLine("sleep", ageDays),
        href: "/data",
        actionLabel: "Sync a source",
        presence: "dormant",
      }
    );
  } else if (sleepPresentation?.freshness === "stale") {
    add(
      sleepCandidates.refresh(
        {
          subject: profileSubject,
          applicable: canWrite,
          sourceOrder: sourceOrder++,
        },
        on
      ),
      <WidgetEmpty
        title="Sleep"
        icon={IconMoon}
        message="No sleep recorded last night."
        ctaLabel="Sync a source"
        ctaHref="/data"
      />
    );
  } else if (sleepSummary) {
    const wakeDayAge = freshnessAgeDays(sleepSummary.wakeDay, on);
    const wakeMinutes = sleepSummary.wakeMinutes ?? 420;
    const sleepTiming = {
      kind: "local-days" as const,
      ageDays: wakeDayAge ?? -1,
      maxDays: 3,
    };
    const values = [
      ["duration", "Sleep duration", formatHm(sleepSummary.durationMin)],
      [
        "bed-time",
        "Bed time",
        sleepSummary.bedMinutes == null
          ? "—"
          : formatClockMinutes(formatPrefs.timeFormat, sleepSummary.bedMinutes),
      ],
      [
        "wake-time",
        "Wake time",
        sleepSummary.wakeMinutes == null
          ? "—"
          : formatClockMinutes(
              formatPrefs.timeFormat,
              sleepSummary.wakeMinutes
            ),
      ],
    ] as const;
    values.forEach(([key, title, value], index) =>
      add(
        sleepCandidates.reading(
          { subject: profileSubject, sourceOrder: sourceOrder + index },
          key,
          sleepSummary.wakeDay,
          engagementFromSource(sleepSummary.source),
          sleepTiming,
          key === "duration" &&
            sleepArrivedInWakeWindow(
              sleepPresentation?.freshness ?? "stale",
              wakeDayAge,
              wakeMinutes,
              nowMinutes
            )
        ),
        <DashboardAtomCard title={title} value={value} href="/sleep" />,
        {
          label: title,
          value,
          href: "/sleep",
          presence: "current",
        }
      )
    );
    sourceOrder += values.length;
  }

  todayNaps.forEach((nap, index) =>
    add(
      sleepCandidates.nap(
        { subject: profileSubject, sourceOrder: sourceOrder + index },
        nap.date,
        nap.startMinutes,
        engagementFromSource(nap.source),
        nowMinutes - nap.endMinutes
      ),
      <NapsTodayWidget naps={[nap]} timeFormat={formatPrefs.timeFormat} />
    )
  );
  if (todayNaps.length > 0)
    addStandingOnly(
      sleepCandidates.napTotal(
        {
          subject: profileSubject,
          sourceOrder: sourceOrder + todayNaps.length,
        },
        on
      ),
      {
        value: formatHm(
          todayNaps.reduce((sum, nap) => sum + nap.durationMin, 0)
        ),
        detail: `${todayNaps.length} ${todayNaps.length === 1 ? "nap" : "naps"}`,
        href: "/sleep#naps",
        presence: "current",
      }
    );
  sourceOrder += todayNaps.length + 1;

  pillars.forEach((pillar, index) =>
    addStandingOnly(
      progressCandidates.healthspan(
        {
          subject: profileSubject,
          applicable: adultContentApplicable,
          sourceOrder: sourceOrder + index,
        },
        pillar.key
      ),
      {
        label: pillar.label,
        value: (
          <span className="inline-flex flex-wrap items-baseline gap-1.5">
            <span>{pillar.value}</span>
            <PillarToneBadge tone={pillar.tone} />
          </span>
        ),
        detail: (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>{pillar.detail}</span>
            <TrendArrow pillar={pillar} />
          </span>
        ),
        href: pillar.href,
        presence: "current",
      }
    )
  );
  sourceOrder += pillars.length;

  coachingObservations.forEach((finding, index) =>
    add(
      progressCandidates.statement(
        { subject: profileSubject, sourceOrder: sourceOrder + index },
        "coaching.observation",
        finding.dedupeKey,
        `finding.${finding.dedupeKey}`
      ),
      <CoachingObservations findings={[finding]} />
    )
  );
  sourceOrder += coachingObservations.length;

  weeklyRecap?.lines.forEach((line, index) =>
    add(
      progressCandidates.recap(
        {
          subject: profileSubject,
          applicable: trainingRelevant,
          sourceOrder: sourceOrder + index,
        },
        // The shared per-line identity (#3033): `nutrient-missed` can appear once
        // per nutrient, and a bare line.key would mint duplicate candidate ids.
        recapLineId(line),
        weeklyRecap.start,
        weeklyRecap.end
      ),
      <WeeklyRecapWidget
        recap={{ ...weeklyRecap, lines: [line], isEmpty: false }}
        formatPrefs={formatPrefs}
      />
    )
  );

  const dashboardPlacements = rankDashboardCandidates(candidates, {
    activeProfileId: profile.id,
    minutesOfDay: nowMinutes,
    today: on,
    upcoming,
  });
  const illnessGroupKeys = orderedIllnessGroupKeys(dashboardPlacements);
  const heroByGroupKey = new Map(
    heroCockpits.map((cockpit) => [cockpit.stateIdentity!.groupKey, cockpit])
  );
  const placedEpisodeCandidateIds = new Set(
    dashboardPlacements
      .filter(
        (placement) =>
          placement.lane === "now" && placement.nowLayer === "illness"
      )
      .map((placement) => placement.candidate.candidateId)
  );
  const placedHeroCockpits = illnessGroupKeys.map((groupKey) => {
    const cockpit = heroByGroupKey.get(groupKey);
    if (!cockpit)
      throw new Error(`Missing dashboard illness group ${groupKey}`);
    const stateIdentity = placedEpisodeCandidateIds.has(
      cockpit.stateIdentity!.candidateId
    )
      ? cockpit.stateIdentity
      : null;
    const temperatureIdentity =
      cockpit.temperatureIdentity &&
      placedEpisodeCandidateIds.has(cockpit.temperatureIdentity.candidateId)
        ? cockpit.temperatureIdentity
        : null;
    const medicationIdentity =
      cockpit.medicationIdentity &&
      placedEpisodeCandidateIds.has(cockpit.medicationIdentity.candidateId)
        ? cockpit.medicationIdentity
        : null;
    const body = cockpit.body as ReactElement<
      Parameters<typeof IllnessCockpitBody>[0]
    >;
    const episode = {
      ...body.props.episode,
      ...(cockpit.temperatureIdentity && !temperatureIdentity
        ? { temperatures: [], maxTempF: null, latestTemp: null }
        : {}),
      ...(cockpit.medicationIdentity && !medicationIdentity
        ? { medications: [], totalAdministrations: 0 }
        : {}),
    };
    return {
      ...cockpit,
      stateIdentity,
      temperatureIdentity,
      medicationIdentity,
      status: {
        ...cockpit.status,
        temperature: temperatureIdentity ? cockpit.status.temperature : null,
        lastMeds: medicationIdentity ? cockpit.status.lastMeds : null,
      },
      body: cloneElement(body, {
        episode,
        temperatureIdentity,
        medicationIdentity,
      }),
    };
  });

  return (
    <DashboardPlacementCanvas
      dateLabel={formatLongDate(on, formatPrefs)}
      placements={dashboardPlacements}
      candidateNodes={candidateNodes}
      standingPresentations={standingPresentations}
      aheadPresentations={aheadPresentations}
      attentionBadgeCount={attentionBadgeCount}
      illnessGroupNode={
        placedHeroCockpits.length > 0 ? (
          <IllnessHero
            cockpits={placedHeroCockpits}
            initialCollapsedActive={heroUi.collapsedActive}
            initialOpenOtherKey={heroUi.openOtherKey}
            saveState={saveIllnessHeroState}
          />
        ) : undefined
      }
    />
  );
}
