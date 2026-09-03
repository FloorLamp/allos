import { cloneElement, type ReactElement } from "react";
import { redirect } from "next/navigation";
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
  typicalBedTime,
  getActiveProtocolSummaries,
  getWorkoutPresence,
  getSessionRecap,
  getMoodOnDate,
  getProteinToday,
  getMetricDailyTotals,
  getVitalsLatestModel,
  getCycleTrackingRelevance,
} from "@/lib/queries";
import { getForecastSuspension, listCyclePeriods } from "@/lib/cycle-store";
import { cycleControlState } from "@/lib/cycle-plausibility";
import { summarizeStepsToday, STEPS_TRAILING_DAYS } from "@/lib/steps-today";
import IntradayChart from "@/components/IntradayChart";
import { getIntradayDay } from "@/lib/queries/intraday";
import { getLatestHrDay } from "@/lib/queries/metrics";
import { gatherHistoryLog } from "@/lib/history";
import { intradayFreshness } from "@/lib/intraday";
import {
  isFoodLoggingRelevant,
  isLongevityRelevant,
  isStrengthTrainingRelevant,
  isTrainingRelevant,
} from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings/profile-attrs";
import {
  canAcknowledgeRest,
  recommendCoaching,
  recentCardioPRs,
  recentPRs,
  strengthAppropriateCoachingInput,
  type Recommendation,
} from "@/lib/coaching";
import { collectCoachingFindings } from "@/lib/rule-findings";
import { pickNextAppointment } from "@/lib/household";
import { goalPct, isGoalLive } from "@/lib/outcome-goals";
import {
  frequencyPaceLabel,
  frequencyScopeLabel,
  isStrengthProgrammingScope,
} from "@/lib/frequency-targets";
import { cadenceScopeNoun } from "@/lib/cadence";
import { PACE_BADGE_CLASS } from "@/lib/pace-presentation";
import {
  activeByKey,
  activeFindings,
  coachingDedupeKey,
  type Finding,
} from "@/lib/findings";
import { routineOrder } from "@/lib/dismissal-fatigue";
import { requireSession } from "@/lib/auth";
import { requireScope, type ProfileScope } from "@/lib/scope";
import { writeSubjectName } from "@/lib/own-profile";
import { currentFoodSlotWindow } from "@/lib/queries/nutrition";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";
import { foodGroupName } from "@/lib/food-groups";
import { usualRoutineFoodMembers } from "@/lib/usual-routine";
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
  getIllnessNowUi,
} from "@/lib/settings";
import { countPushSubscriptionsForLogin } from "@/lib/notifications/push";
import { hasConnectedDataSource } from "@/lib/integrations/connections";
import { dispWeight, fmtDistance, fmtKmh, fmtWeight } from "@/lib/units";
import {
  shiftDateStr,
  hhmmToMinutes,
  hourInTz,
  zonedDateParts,
} from "@/lib/date";
import { ALL_ROWS } from "@/lib/trends";
import {
  formatClockMinutes,
  formatLongDate,
  formatRelativeTime,
  daysRemainingLabel,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import {
  clinicalResultClaimsFreshness,
  clinicalResultHostsAcknowledge,
  RECENT_LAB_STALE_LABEL,
  recentLabHighlights,
} from "@/lib/recent-labs";
import {
  DORMANCY_DOMAINS,
  WEIGHT_TREND_WINDOW_DAYS,
  dormancyState,
  dormantRecordLine,
  dormantRecordSince,
} from "@/lib/domain-dormancy";
import { getLastSleepRecordDate } from "@/lib/queries/domain-dormancy";
import { freshnessAgeDays } from "@/lib/freshness";
import { glanceAgeToken } from "@/lib/glance-age";
import { VITAL_PRESENTATION_FLOORS } from "@/lib/vitals-latest";
import {
  TREND_METRIC_PRESENTATION_FLOORS,
  trendMetricPresentationFreshness,
} from "@/lib/trend-metric-freshness";
import { getRecapCard } from "@/lib/notifications/recap-data";
import { upcomingRowQualifiers } from "@/lib/notifications/upcoming-digest";
import { recapLineAnnotation, recapLineId, recapRangeLabel } from "@/lib/recap";
import { recapScaleEntry } from "@/lib/recap-scale";
import {
  coachingObservationFindings,
  dashboardHabitDomain,
  dashboardHabitHref,
  isDataQualityDashboardFinding,
  orderDashboardHabits,
} from "@/lib/dashboard-presentation";
import {
  localTimeWindow,
  mealTimeWindows,
  orderedIllnessGroupKeys,
  rankDashboardCandidates,
  type DashboardCandidate,
} from "@/lib/dashboard-relevance";
import {
  cappedFamilyGather,
  CLINICAL_RESULTS_CAP,
} from "@/lib/dashboard-standing";
import {
  attentionCandidates,
  attentionAheadDetail,
  attentionDoseChipLabel,
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
import PageContainer from "@/components/PageContainer";
import DashboardPlacementCanvas from "@/components/dashboard/DashboardPlacementCanvas";
import IllnessNowGroup, {
  type IllnessContextCockpit,
} from "@/components/dashboard/IllnessNowGroup";
import type { DashboardStandingPresentation } from "@/components/dashboard/DashboardStandingCluster";
import RecentlyResolvedReopenControls, {
  type RecentlyResolvedItem,
} from "@/components/dashboard/RecentlyResolvedReopenControls";
import StreamLifecycleOfferControls from "@/components/integrations/StreamLifecycleOfferControls";
import Button from "@/components/Button";
import DoseConfirmButton from "@/components/DoseConfirmButton";
import SnoozeDismissMenu from "@/components/SnoozeDismissMenu";
import FollowUpResolveControls from "@/components/FollowUpResolveControls";
import FindingDismissButton from "@/components/FindingDismissButton";
import PreventiveReviewControls from "@/components/PreventiveReviewControls";
import { preventiveReviewQuestion } from "@/lib/preventive-review";
import {
  confirmPreventiveRecord,
  dismissPreventiveRecord,
  resolveFollowUp,
} from "./upcoming/actions";
import {
  acceptStreamReminder,
  declineStreamReminder,
  dismissStreamReminderOffer,
  keepStreamReminder,
} from "./stream-lifecycle-actions";
import { dismissOnboardingChecklist } from "./onboarding/actions";
import { orderedOnboardingChecklistTasks } from "@/lib/onboarding-checklist";
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
import type { RecentLabRow } from "@/lib/recent-labs";
import {
  PillarToneBadge,
  TrendArrow,
} from "@/components/dashboard/HealthspanPillarPresentation";
import { sleepWaitingDetail } from "@/lib/sleep-waiting";
import { SLEEP_SKEW_HEDGE } from "@/lib/sleep-clock-skew";
import { isSuspectSleepWakeDay } from "@/lib/queries/sleep-clock-skew";
import {
  formatHm,
  formatSleepWindow,
  formatUsualSleepBand,
  sleepRecordPresentation,
} from "@/lib/sleep-summary";
import UsualRoutineControl from "@/components/dashboard/UsualRoutineControl";
import DashboardQuickEntryAction from "@/components/dashboard/DashboardQuickEntryAction";
import {
  StandingAge,
  staleMeasurementDoor,
} from "@/components/dashboard/StandingAge";
import IllnessCockpitBody from "../../components/illness/IllnessCockpitBody";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import {
  acknowledgeRest,
  dismissAttention,
  dismissCoachingObservation,
  dismissDataQualityGap,
  dismissRecentlyResolved,
  markAttentionDose,
  saveIllnessNowState,
  snoozeAttention,
  snoozeCoaching,
  undoAttentionDose,
} from "./actions";
import {
  episodeHref,
  encounterHref,
  historyDayIntradayHref,
  type AppRoute,
} from "@/lib/hrefs";
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
import { proteinTodayExplanation, proteinTodayLineParts } from "@/lib/protein";
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
import {
  isItemSuppressibleFlag,
  upcomingDueText,
  type UpcomingItem,
} from "@/lib/upcoming";
import { isSuppressed } from "@/lib/upcoming-suppress";
import { itemDetailText } from "@/lib/upcoming-aggregate";
import { dashboardAttentionCandidateId } from "@/lib/dashboard-attention-identity";
import { loadContextLabel } from "@/lib/lifts";
import { formatMinutes } from "@/lib/duration";

export const dynamic = "force-dynamic";

// The bound on the day gather behind the Today band's chart (#4767 item 2). It is a
// ROW cap on one profile-local day, and the chart draws only the subset that carries
// a clock — so this is not a limit on what the chart can show so much as a refusal to
// read an unbounded day. A day past it has more entries than any 358px axis could
// mark legibly, and the day view itself is one tap away with its own paging.
const DASHBOARD_INTRADAY_DAY_ROWS = 200;

// The soonest scheduled visit, flattened by the page (#171/#1215). `whenLabel`
// carries date AND clock time through the login's display prefs — a 9am and a 4pm
// visit must be distinguishable, so the time is half the answer.
interface NextAppointment {
  title: string;
  whenLabel: string;
  dueText: string;
  detail: string | null;
  href: AppRoute;
}

// AN ATTENTION ROW SAYS WHAT, THEN WHEN (#4076). Outside Ahead the item's own detail
// is the content a person came to read — the biomarker retest sentence, "Vitamin D3 ·
// 2000 IU" — and the due text seconds it. The detail keeps its own testid because the
// machine-date census ledger (e2e/machine-date-census.spec.ts) tracks
// `attention-item-detail` on `/` as a known offender, and a shrink-only ledger reads a
// silent deletion as a failure — correctly.
function attentionRowDetail(
  item: UpcomingItem,
  today: string,
  formatPrefs: DisplayFormatPrefs
) {
  const due = upcomingDueText(item, today, formatPrefs);
  // THE DETAIL IS RENDERED, NOT READ (#3526). The biomarker retest row's sentence is
  // composed by a login-less generator and carries the raw ISO day; this is a surface
  // WITH a login, so it re-composes the row's carried facts through the same
  // `formatPrefs` the due text already uses. Every other item's detail is unchanged.
  const detail = itemDetailText(item, today, formatPrefs);
  if (!detail) return due;
  return (
    <>
      <span data-testid="attention-item-detail">{detail}</span>
      {due ? ` · ${due}` : null}
    </>
  );
}

// Every sentence the coaching card printed, in the row's facts column. `also` is the
// #1148 rule: concurrent under-recovery signals are shown BEFORE a snooze can suppress
// them, so a dismissal is informed and cannot silently bury a signal never seen.
function coachingRowDetail(rec: Recommendation) {
  const rest = [
    rec.target ? `Suggested set: ${rec.target}` : null,
    ...(rec.notes ?? []),
  ].filter(Boolean);
  return (
    <>
      {rec.detail}
      {rec.also?.length ? (
        <>
          {" · "}
          <span data-testid="coaching-also">
            <span className="font-medium">Also:</span> {rec.also.join("; ")}.
          </span>
        </>
      ) : null}
      {rest.length > 0 ? ` · ${rest.join(" · ")}` : null}
    </>
  );
}

// A FINDING AS A ROW, WITHOUT LOSING WHAT IT SAYS (#4076). The card carried title,
// detail, EVIDENCE and a CTA beside its dismiss; the row keeps all four — sentence and
// evidence in the facts column, the CTA as the row's door — and hosts the same
// dedupeKey-posting dismiss in the trailing slot. Reusing Ahead's presentation here
// would have deleted the sentence, which is the trap this issue recorded twice.
function findingRow(
  finding: Finding,
  dismissAction: (formData: FormData) => void | Promise<void>,
  momentTitle: string
): DashboardStandingPresentation {
  return {
    label: finding.title,
    detail: [finding.detail, finding.evidence].filter(Boolean).join(" · "),
    href: finding.actionHref,
    actionLabel: finding.actionHref
      ? (finding.actionLabel ?? "View")
      : undefined,
    moment: { title: momentTitle },
    control: (
      <FindingDismissButton
        finding={finding}
        dismissAction={dismissAction}
        dismissTestid="finding-dismiss"
      />
    ),
  };
}

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
  const otherSick = illnessProfiles.flatMap((p) =>
    openStateByProfile.has(p.id)
      ? openEpisodesFromState(openStateByProfile.get(p.id)!, {
          includeEmpty: true,
        }).map((episode, episodeOrder) => ({ p, episode, episodeOrder }))
      : []
  );

  // Disambiguate every cockpit patient's name together (#531/#534 on-element identity).
  const cockpitProfiles = [
    ...(activeEpisodes.length > 0 ? [profile] : []),
    ...new Map(otherSick.map((x) => [x.p.id, x.p])).values(),
  ];
  const cockpitNames = disambiguateProfileNames(cockpitProfiles);
  const nameFor = (p: { id: number; name: string }) =>
    cockpitNames.get(p.id) ?? p.name;

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

  const illnessCockpits: IllnessContextCockpit[] = orderedCockpits.map((c) => {
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
    // ONE COLLAPSED READING, drawn twice (#4752 item 1): the accordion line above the
    // body and the body's own recovery header read the SAME object, so an expanded
    // cockpit and the line it expanded from cannot state two different last doses.
    const collapsedStatus = {
      ...clinicalStatus,
      worsening: displayStatus.worsening,
      temperature: displayStatus.temperature,
      lastMeds: displayStatus.lastMeds,
    };
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
      status: collapsedStatus,
      feverFree: model.feverFree,
      episodeHref: episodeHref(c.episode.id),
      body: (
        <IllnessCockpitBody
          profileId={c.profileId}
          episode={displayEpisode}
          status={collapsedStatus}
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
  const illnessUi = getIllnessNowUi(profile.id);

  // WHO EACH NOW CLUSTER IS ABOUT (#4752 item 6). The ranker keys a group by profile
  // id and only groups at all when a cross-profile row is present, so this map is
  // consulted exactly when there is more than one subject on screen. The viewer's own
  // cluster says "You", not their name — that is what a person reading their own
  // dashboard recognizes above their own rows.
  const nowSubjectNames = disambiguateProfileNames(accessible);
  const nowSubjects = new Map(
    accessible.map((p) => [
      String(p.id),
      {
        key: String(p.id),
        profile: p,
        name:
          p.id === profile.id ? "You" : (nowSubjectNames.get(p.id) ?? p.name),
      },
    ])
  );

  // Recently-resolved reopen affordance (issue #1140 Part A): for the viewer and every
  // bounded household member, the most-recent episode still inside its 7-day reopen
  // window (the SAME episodeReopenEligibility rule the detail page uses). Cross-profile
  // aware like the illness Now group (#858) — each row reopens that member's episode via its
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
  // link that surfaces near the illness Now group when any accessible member is currently or
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
  // day and disagree with the body census this dashboard presentation links to. Windowed by DATE
  // (a deliberate trailing-90-day glance) rather than the old undisclosed 60-row cap.
  const weightTrendSince = shiftDateStr(on, -(WEIGHT_TREND_WINDOW_DAYS - 1));
  // The UNWINDOWED series is kept: its newest day is the weight domain's last record,
  // which is what separates "never weighed" from "stopped weighing" below (#2652). The
  // card and the dormancy verdict therefore read one computation, not two (#221).
  const weightSeries = getBodyMetricDailySeries(profile.id, "weight", ALL_ROWS);
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

  // Sleep candidates and the Sleep page share the same last-night summary.
  const sleepSummary = getLastNightSummary(profile.id);
  const sleepPresentation = sleepSummary
    ? sleepRecordPresentation(sleepSummary.wakeDay, on, formatPrefs)
    : null;
  // The morning waiting window (#2097). When it is open, the atom names the state
  // INSTEAD of showing a headline duration for a night nobody asked about — the
  // recorded night drops to a quiet secondary line and stays one tap away on /sleep.
  // Null (the common case) leaves every existing branch exactly as it was.
  const sleepWaiting = getSleepWaitingState(
    profile.id,
    sleepSummary?.wakeDay ?? null
  );
  const typicalWakeMinutes = sleepWaiting ? typicalWakeTime(profile.id) : null;
  // The USUAL BAND behind last night's actuals (#3253's rider): the profile's own
  // typical bed and wake times, read VERBATIM from the pair the notification schedule
  // already keys on. Zero new derivation — the classifier answers null below its
  // minimum-nights gate and the row then says nothing at all, which is the whole
  // contract. Only asked when there is a recorded night for it to sit behind.
  const usualSleepBand = (() => {
    if (!sleepSummary) return undefined;
    const bed = typicalBedTime(profile.id);
    const wake = typicalWakeTime(profile.id);
    const band = formatUsualSleepBand(formatPrefs.timeFormat, bed, wake);
    return band == null ? undefined : `Usual ${band}`;
  })();
  // Does last night's SYNCED session disagree with the heart rate recorded across it
  // (#4299)? Two consequences below, both about not stating a fabricated time as fact:
  // the bed/wake rows carry the hedge instead of the usual band, and the family holds no
  // attention claim — an alarm built on contradicted data is noise wearing a safety
  // costume. Asked only where there is a recorded night to ask about.
  const sleepClockSkewSuspect =
    sleepSummary != null &&
    isSuspectSleepWakeDay(profile.id, sleepSummary.wakeDay);
  const sleepPreviousNightLabel =
    sleepSummary && sleepPresentation?.freshness === "recent"
      ? `${sleepPresentation.label} · ${formatHm(sleepSummary.durationMin)}`
      : null;
  // Today's nap candidates reuse the detailed model the Sleep page renders.
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
    {
      changed: boolean;
      fresh: boolean;
      // The signal key this row's OWN acknowledge control posts, or absent when it
      // needs none (#4232). See the mount below for why it is decided here.
      acknowledgeKey?: string;
      sharedFactKey?: string;
    }
  >();
  {
    const observations = getDashboardClinicalObservations(profile.id);
    const activeAttentionKeys = new Set(attention.map((item) => item.key));
    // An acknowledged marker spends its notable-first precedence (#3225). The
    // acknowledgment IS the flag dismissal — one state, not two (owner ruling
    // 2026-08-20) — read through the same suppression bus every other consumer of
    // the key reads, which is also where a new draw has already re-armed it.
    const labSuppressions = getFindingSuppressions(profile.id);
    const labAcknowledged = (name: string): boolean => {
      const rec = labSuppressions.get(biomarkerFlagDismissalKey(name));
      return rec != null && isSuppressed(rec, on);
    };
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
      // FRESH RESULTS ARE RELEVANT (#4232). A result collected inside the window
      // claims Standing's attention tier whether or not it is notable, and the claim
      // ends on acknowledgment or when the window lapses, whichever is first — the
      // acknowledge lifecycle #3225 already runs, read through the same suppression
      // bus above. The date is the COLLECTION date the record carries, so a
      // backfilled import of old results claims nothing.
      const acknowledged = labAcknowledged(name);
      const fresh = clinicalResultClaimsFreshness(
        observation.date,
        on,
        acknowledged
      );
      labPromotions.set(name, {
        changed,
        fresh,
        // Which rows host their own acknowledge control, and why — see
        // `clinicalResultHostsAcknowledge`, which owns the rule so this surface and
        // the result detail page's "Seen it" cannot drift apart.
        ...(clinicalResultHostsAcknowledge({
          collectedOn: observation.date,
          today: on,
          flag: observation.flag,
          acknowledged,
          hasAttentionItem: activeAttentionKeys.has(findingKey),
        })
          ? { acknowledgeKey: findingKey }
          : {}),
        ...(changed
          ? {
              sharedFactKey: `upcoming.${findingKey}`,
            }
          : {}),
      });
    }
    labRows = cappedFamilyGather(
      recentLabHighlights(
        observations,
        Number.MAX_SAFE_INTEGER,
        on,
        labAcknowledged
      ),
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
        // COUNTDOWN GRAMMAR, UNBOUNDED, and deliberately not the household card's
        // `upcomingDueText` (#2806 bounds the overdue side there at 30 days). #303
        // binds the two surfaces to the same PICK — `pickNextAppointment` above — not
        // to the same phrasing, and their phrasings already differ on the future side
        // (#2579-B prints "Sep 26" on the card and "in 45 days" here). Routing this
        // through the shared formatter would change both ends of that at once, which
        // is a decision about the dashboard's copy and not about #2806.
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
  const goalProgress = getOutcomeGoalProgressMap(profile.id, goals);

  const freqTargets = getFrequencyTargetProgress(profile.id).filter(
    ({ target }) =>
      (trainingRelevant ||
        dashboardHabitDomain(target.scope_kind) !== "training") &&
      (strengthTrainingAvailable || !isStrengthProgrammingScope(target))
  );
  const orderedFreqTargets = orderDashboardHabits(freqTargets);

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
  // through the SAME findings-bus store — so a dismiss on either atom (or a tab)
  // drops the finding out for free.
  //
  // Data-quality and coaching observations become separate atomic statements. Both
  // retain the same shared finding identity, dismissal, and routine-fatigue policy.
  //
  // DISMISSAL FATIGUE (#2386). The dashboard is the ROUTINE surface for these — the
  // place a finding leads without being asked for — so it is where repeat dismissal is
  // read as an answer. `routineOrder` reranks the already-filtered set over the SAME
  // suppression map: a topic the user has declined across two separate raisings drops
  // behind everything unfatigued, and a topic declined across four leaves this surface
  // entirely. Nothing is silenced — every one of them still renders on its own tab,
  // which is where the user goes looking, and the shared bus is untouched.
  const activeCoaching = routineOrder(
    activeFindings(
      collectCoachingFindings(profile.id, on, units.weightUnit, formatPrefs),
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
  );
  const coachingObservations = coachingObservationFindings(activeCoaching);
  const dataQualityFindings = activeCoaching.filter(
    isDataQualityDashboardFinding
  );

  // The recap gather is shared with the notification; each line becomes an atomic
  // dashboard statement with the stable `weekly-recap` presentation selector.
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
  // Relevance is transient and computed here: it is a
  // pure function of today's state, so it collapses the moment everything it names is
  // logged and comes back if the servings are undone. Nothing about it is persisted and
  // it never creates persisted presentation state.
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
  const routineSlot =
    foodLoggingApplicable && access === "write"
      ? currentFoodSlotWindow(profile.id)
      : null;
  const routineOffer =
    routineSlot != null
      ? getUsualRoutineOffer(profile.id, routineSlot.slot, on)
      : null;
  // THE OFFER'S PLACEMENT WINDOW IS THE WINDOW IT IS ABOUT (#3265). This used to be
  // `mealTimeWindows(nowMealAnchors)` — the intake REMINDER anchors ±60 min, which is
  // when a dose is DUE, a different question from whether a food routine still stands.
  // Those windows close at 21:00 while the offer is `currentFoodSlot`-anchored and
  // Evening runs to midnight, so between 21:00 and local midnight the dashboard computed
  // the offer, paid its DB reads, and then dropped it as expired before any lane was
  // built — for exactly the population an Evening routine describes. The span comes back
  // from the same call that chose the slot, so the two can no longer disagree.
  //
  // `endsBefore - 1` because `FoodSlotWindow` is half-open and `localTimeWindow` takes an
  // INCLUSIVE closing minute. The span always contains the current minute (the slot was
  // derived from it), so it is never the empty Morning window.
  const routineTiming =
    routineSlot != null
      ? localTimeWindow(routineSlot.opensAt, routineSlot.endsBefore - 1)
      : null;
  // The label names every write, in display names: a slug is not a promise anybody can
  // read. The subject line follows writeSubjectName so a caregiver acting on another
  // profile is never ambiguous about whose morning this logs (#1013).
  const routineControl = routineOffer
    ? {
        window: routineOffer.window,
        food: usualRoutineFoodMembers(routineOffer, foodGroupName),
        proteinGrams: routineOffer.proteinGrams,
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
  //
  // The PROFILE-LOCAL hour decides whether today is complete enough to compare against
  // whole days (#3258). Local, not UTC — a delta appearing on the server's clock would
  // be the same artifact in a different disguise.
  // THE DAY SO FAR (#4767 item 2) — the SAME IntradayChart the /history day view
  // draws, in its existing compact geometry. No second implementation and no model
  // of its own: the events are `gatherHistoryLog`'s own resolved day rows, the same
  // list the day view hands the panel, so a window drawn here can never name
  // something that page would not show.
  //
  // GATED LIKE THE CARD IT REPLACES, and gated CHEAPLY FIRST. `getLatestHrDay` is one
  // indexed read; a profile with no wearable, or a morning nothing has synced into
  // yet, pays that and stops — the day gather below never runs for them, and they see
  // no frame at all rather than an empty axis. The second half of the gate is n > 1:
  // one sample is a dot, not a day (the same rule the sparkline column applies at
  // `loneReading`).
  const intradayCandidate =
    getLatestHrDay(profile.id) === on
      ? getIntradayDay(
          profile.id,
          on,
          gatherHistoryLog(profile.id, {
            loginId: login.id,
            day: on,
            limit: DASHBOARD_INTRADAY_DAY_ROWS,
          }).dayEvents
        )
      : null;
  const intradayToday =
    intradayCandidate && (intradayCandidate.hr?.pointCount ?? 0) > 1
      ? intradayCandidate
      : null;

  const stepsRows = getMetricDailyTotals(profile.id, "steps");
  const stepsSummary =
    stepsRows.length > 0
      ? summarizeStepsToday(stepsRows, on, hourInTz(timezone, dashboardNow))
      : null;

  // vitals-latest (#1221): the latest BP + resting HR readings with a trend arrow, over
  // the SAME series queries behind Trends → Vitals, each reduced via the shared
  // latestTrend helper and framed by the per-quantity presentation floor (#2303) — the
  // whole model is `getVitalsLatestModel` (#221), which the DB tier pins end to end.
  // Null components self-omit; an all-null model is the data-aware CTA.
  const vitalsModel = getVitalsLatestModel(profile.id, on);

  // Cycle phase is a Standing reading. The separate write candidate reuses the one
  // cycle control state shared with the Cycle page and quick-log sheet (#1892/#2801).
  const cyclePeriods = cycleApplicable ? listCyclePeriods(profile.id) : [];
  const cycleControl = cycleApplicable
    ? cycleControlState(cyclePeriods, on, getForecastSuspension(profile.id))
    : null;
  const cycleModel =
    cycleControl?.day != null && cycleControl.phase != null
      ? { day: cycleControl.day, phase: cycleControl.phase }
      : null;

  // Ongoing N-of-1 protocols reuse the same detail-page computations (comparison,
  // adherence, outcome, and practice) before each fact becomes its own candidate.
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
  const presentations = new Map<string, DashboardStandingPresentation>();
  const aheadPresentations = new Map<string, DashboardStandingPresentation>();
  // ONE DECLARATION PER CANDIDATE (#4076): its row. Cards left `/` entirely, so
  // there is no second node to declare and no lane left that would render one — what
  // a fact EARNS goes in the row's trailing slot, its write included. A candidate
  // that places with no row at all is a hard failure in the canvas, EXCEPT for the
  // nav duplicates the tail deliberately drops (they own no content of their own).
  const add = (
    candidate: DashboardCandidate,
    presentation?: DashboardStandingPresentation
  ) => {
    candidates.push(candidate);
    if (presentation) presentations.set(candidate.candidateId, presentation);
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
    // AHEAD SAYS WHEN, AND NOW ALSO WHY (#4076, #4319). A schedule's sentence is its
    // due text; the row below says WHAT, because outside Ahead the item's own detail
    // is the content a person came to read — the biomarker retest sentence, "Vitamin
    // D3 · 2000 IU". What the due text no longer does is defer the WHY one tap to
    // /upcoming: the item's reason fragments come from the producer the digest reads,
    // so the push and the page cannot word one fact two ways.
    //
    // THE DUE TEXT IS `attentionAheadDetail` AND NOT `upcomingDueText` (#4468), which
    // is the whole of that fix: a dose scheduled for a later slot says "from 11:00"
    // so the row states WHY it is here rather than now. It is passed IN as the due
    // text rather than wrapping the result, because the two are not interchangeable
    // and taking either alone silently drops the other's behaviour. Safe because a
    // dose is not a named-line domain, so its due text flows through this producer
    // instead of being replaced by a cause fragment. Pinned on a real dose item in
    // lib/__db_tests__/upcoming-aggregate.test.ts — neither issue's own tests can see
    // the nesting.
    aheadPresentations.set(candidate.candidateId, {
      label: item.title,
      detail: upcomingRowQualifiers(
        item,
        attentionAheadDetail(item, on, formatPrefs)
      ).join(" · "),
      href: item.href,
    });
    // The write follows the control to the row (#4076). A non-actionable attention
    // fact is still suppressible (isItemSuppressibleFlag) and this is the only mount
    // of its snooze/dismiss, so the row hosts it in the trailing slot rather than the
    // card that used to be the only shape that could.
    add(candidate, {
      label: item.title,
      detail: attentionRowDetail(item, on, formatPrefs),
      href: item.href,
      control: canWrite ? (
        <>
          {item.doseId != null && (
            /* ONE ACTION GRAMMAR SECTION-WIDE (#4752 item 7). "Mark taken" was a
               bare verb beside a row that already said everything except WHEN, so
               the slot moves onto the control that writes it and the verb becomes
               one word. Same action, same undo — only the sentence changed. */
            <DoseConfirmButton
              action={markAttentionDose}
              undoAction={undoAttentionDose}
              fields={{ dose_id: item.doseId }}
              payload={attentionDoseChipLabel(item, on, formatPrefs)}
              ariaLabel={`Take ${item.title}`}
              testid="attention-mark-taken"
            />
          )}
          {item.followUpResolve != null && (
            <FollowUpResolveControls
              action={async (fd) => {
                "use server";
                await resolveFollowUp(fd);
              }}
              carePlanItemId={item.followUpResolve.carePlanItemId}
              resolvingRecordId={item.followUpResolve.resolvingRecordId}
            />
          )}
          {isItemSuppressibleFlag(item) && (
            <SnoozeDismissMenu
              itemName={item.title}
              signalKey={item.key}
              snoozeOnly={item.carePersistent === true}
              snoozeAction={snoozeAttention}
              dismissAction={dismissAttention}
            />
          )}
        </>
      ) : undefined,
    });
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
      add(preventiveReviewCandidate(profileSubject, offer, sourceOrder++), {
        label: item.title,
        detail: (
          <>
            {preventiveReviewQuestion(offer.ruleKey)}{" "}
            <span className="font-medium">{offer.recordName}</span>
          </>
        ),
        control: canWrite ? (
          <PreventiveReviewControls
            confirmAction={async (fd) => {
              "use server";
              return confirmPreventiveRecord(fd);
            }}
            dismissAction={async (fd) => {
              "use server";
              return dismissPreventiveRecord(fd);
            }}
            recordId={offer.recordId}
            ruleKey={offer.ruleKey}
            recordName={offer.recordName}
            recordDate={offer.recordDate}
            question={preventiveReviewQuestion(offer.ruleKey)}
            today={on}
            profileId={profile.id}
          />
        ) : undefined,
      });
    }
  }

  if (workoutPresence?.state === "active") {
    add(
      setupCandidates.liveWorkout(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        workoutPresence.activityId
      ),
      {
        label: "Workout in progress",
        href: "/training",
        actionLabel: "Continue",
      }
    );
  }

  for (const cockpit of illnessCockpits) {
    const key = cockpit.episodeKey;
    const href = cockpit.episodeHref ?? "/history";
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
      {
        label: `${cockpit.displayName} is sick`,
        value: cockpit.status.dayLabel,
        detail: stateDetail,
        href,
      }
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
        {
          label: `${cockpit.displayName}'s latest temperature`,
          value: cockpit.status.temperature.value,
          detail: cockpit.status.temperature.when,
          href,
        }
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
        {
          label: `${cockpit.displayName}'s latest illness medicine`,
          value: [medication.name, medication.dose].filter(Boolean).join(" · "),
          detail: medication.when,
          href,
        }
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
      {
        label: "Recently resolved",
        value: item.situation,
        detail: item.crossProfile ? item.displayName : undefined,
        href: item.episodeHref,
        control: (
          <RecentlyResolvedReopenControls
            item={item}
            dismissAction={dismissRecentlyResolved}
          />
        ),
      }
    );
  }
  if (promoteHouseholdHistory) {
    // NO NODE AND NO ROW. This fact is a link to "Illness episodes" and nothing
    // else, so Show everything draws the page as a door instead of a card that
    // restates the sidebar (#3366). It still places, so completeness is unchanged.
    add(
      careCandidates.householdHistory({
        subject: { scope: "login" },
        sourceOrder: sourceOrder++,
      }),
      undefined
    );
  }

  for (const offer of streamLifecycleOffers) {
    add(
      setupCandidates.streamOffer(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        offer.key
      ),
      {
        label: offer.title,
        detail: offer.body,
        control: (
          <StreamLifecycleOfferControls
            offer={offer}
            // The accept/decline PAIR is chosen by the offer's kind, once, here — so
            // a row can never wire "Keep them ready" to the action that turns the
            // reminder off.
            acceptAction={
              offer.kind === "onboard"
                ? acceptStreamReminder
                : declineStreamReminder
            }
            declineAction={
              offer.kind === "onboard"
                ? dismissStreamReminderOffer
                : keepStreamReminder
            }
          />
        ),
      }
    );
  }

  const finishedActivityId = workoutPresence?.activityId;
  const finishedDayHref = historyDayIntradayHref(workoutPresence?.date ?? on);
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
        {
          value,
          // THE RECEIPT'S PHYSIOLOGY DOOR (#4767 item 4). "Session complete" used to
          // land on /training, which answers what you LOGGED; the question this
          // moment raises is what it DID to you, and only the day view's intraday
          // panel answers that. The session's OWN day, not today — the finished
          // window carries a day of slack across midnight.
          href: finishedDayHref,
          moment: { title: "Session complete", href: finishedDayHref },
        }
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
    const strengthValue =
      record.kind === "1rm"
        ? record.bodyweight
          ? `BW × ${record.reps}`
          : `${fmtWeight(record.weightKg, units.weightUnit)} × ${record.reps}`
        : `${fmtWeight(record.weightKg, units.weightUnit)} top`;
    add(
      progressCandidates.trainingResult(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        key,
        on,
        0
      ),
      {
        label: loadContextLabel(record.exercise, record.equipment),
        value: strengthValue,
        detail: "New personal record",
        href: "/training?tab=analyze",
      }
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
      {
        label: record.activity,
        value,
        detail: "New personal record",
        href: "/training?tab=analyze",
      }
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
        {
          label: stepLabels[step - 1],
          detail: `Setup step ${step} of ${ONBOARDING_STEP_COUNT}`,
          href: `/onboarding?step=${step}` as AppRoute,
          actionLabel: "Continue",
        }
      );
    }
    add(
      setupCandidates.onboardingProgress(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "wizard"
      ),
      {
        label: "Profile setup progress",
        value: `${firstRemainingStep - 1} of ${ONBOARDING_STEP_COUNT} steps complete`,
        href: "/onboarding",
      }
    );
  }
  if (onboardingChecklist && onboardingChecklistCompletion) {
    const onboardingChecklistSteps = orderedOnboardingChecklistTasks(
      onboardingChecklist.focuses,
      onboardingChecklistCompletion
    );
    // THE CHECKLIST IS A MOMENT BLOCK, NOT A ROW (#4362 ruling 3). It was one
    // candidate whose facts column joined every remaining label with "·" — one door
    // for four steps, and none of the sentences saying why any of them is worth
    // doing. A person setting up the app is exactly who deserves per-step doors, so
    // each step is its own row under one header, which is what every other group of
    // same-origin atoms already does.
    onboardingChecklistSteps.forEach((step, index) => {
      add(
        setupCandidates.onboardingChecklistStep(
          { subject: profileSubject, sourceOrder: sourceOrder++ },
          step.suggestion
        ),
        {
          label: step.label,
          // The row's own door: with no control in the trailing slot the row is
          // link-wrapped, so the step's name IS the way in.
          href: step.href,
          detail: step.benefit,
          // The block's header, declared once by its first member (the canvas reads
          // the first that has one) and printed over the whole set.
          moment:
            index === 0 ? { title: "A few useful next steps" } : undefined,
        }
      );
    });
    add(
      setupCandidates.onboardingProgress(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "checklist"
      ),
      {
        // No label: the block's header already names the set, and printing it again
        // on the row beneath would say the same thing twice. What this row carries
        // is the reassurance the block's own copy owes a first-run reader, and the
        // dismiss for the whole set.
        //
        // THE SENTENCE IS SHORTER THAN THE ONE THE CARD PRINTED, and not by taste:
        // the card's second half ("You do not need to complete every suggestion")
        // is second-person, and the dashboard is a cross-profile surface — a carer
        // reading a ward's setup is not the person being addressed. #945's guard
        // catches it here, where it could not in the deleted component. The first
        // half already says the whole thing.
        detail: "Pick what helps now and leave the rest for later.",
        control: (
          <form action={dismissOnboardingChecklist}>
            <Button type="submit" pendingLabel="…">
              Hide
            </Button>
          </form>
        ),
      }
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
  add(moodCheckinCandidate, {
    label: todayMood ? "Update today's mood" : "Log today's mood",
    detail: isMoodCheckinPaused({
      enabled: getProfileMoodCheckin(profile.id),
      ignoredCount: getMoodCheckinIgnored(profile.id),
    })
      ? "Daily reminders are paused."
      : undefined,
    control: <DashboardQuickEntryAction form="mood" />,
  });
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
        {
          label: title,
          value,
          href: "/trends#body",
          moment: { title: "Today's check-in", href: "/trends#body" },
        }
      );
    });
    sourceOrder += moodReadings.length;
  }

  // PRN DOSE CONTROLS LEFT THE TAIL (#4076 ruling 4, the #4083 pattern verbatim).
  // The quick logger's Consume segment (`log-dose`, lib/log-sheet.ts) already owns
  // doses, so the capability follows the sheet and the per-supplement tail rows retire
  // with their controls rather than being restated as a row that cannot host them.

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
      // BOTH WRITES FOLLOW THE CONTROLS TO THE ROW (#4076). This is still the only
      // mount of `snoozeCoaching` and `acknowledgeRest`; what changed is that a row
      // can now host them. Every sentence the card printed is kept, in the facts
      // column — the recommendation, its concurrent firing reasons (#1148: shown
      // BEFORE a snooze can suppress them), its suggested set and its injury notes.
      {
        label: "Coaching",
        value: rec.title,
        detail: coachingRowDetail(rec),
        href: rec.actionHref ?? "/training",
        actionLabel: rec.actionHref ? (rec.actionLabel ?? "Open") : undefined,
        control: (
          <>
            {canAcknowledgeRest(rec) && (
              <form action={acknowledgeRest}>
                <input
                  type="hidden"
                  name="reason_ids"
                  value={(rec.firingReasonIds ?? []).join(",")}
                />
                <Button
                  type="submit"
                  pendingLabel="…"
                  data-testid="coaching-training-anyway"
                >
                  Training anyway
                </Button>
              </form>
            )}
            <form action={snoozeCoaching}>
              <input
                type="hidden"
                name="dedupe_key"
                value={coachingDedupeKey(rec.id)}
              />
              <Button
                type="submit"
                pendingLabel="…"
                data-testid="coaching-snooze"
              >
                Snooze
              </Button>
            </form>
          </>
        ),
      }
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
    const habitHref = dashboardHabitHref(
      dashboardHabitDomain(progress.target.scope_kind)
    );
    // A moment, not the whole week (#3224). "Unmet" spans seven days, so spelling
    // the window `!met` kept every open target parked in Now. The rhythm answers
    // when this target normally gets done; with no rhythm there is no moment.
    const momentOpen = frequencyTargetLogWindowOpen(
      profile.id,
      progress.target,
      on,
      nowMinutes
    );
    const behind = progress.pace === "behind";
    add(
      progressCandidates.targetProgress(
        { subject: profileSubject, sourceOrder: sourceOrder + index * 2 },
        id,
        !progress.met,
        // Owner ruling #3548: a behind target is a HIGHLIGHTED READING in Standing's
        // attention tier, "not a Now card". A calendar week compares against its own
        // zero-evidence opening, so crossing into behind on day 4 stays a live
        // transition for the rest of the week — which, before this, kept both
        // readings parked in Now exactly as #3245 described the log offers doing.
        // The crossing is still told; `owed` is where it is told from. What the
        // promotion keeps is the transitions that remain Now facts: reaching met,
        // and coming back onto pace.
        weeklyTargetStateChanged(progress, progress.previous ?? null) &&
          !behind,
        behind
      ),
      {
        label: frequencyScopeLabel(
          progress.target.scope_kind,
          progress.target.scope_value
        ),
        value: `${progress.count} of ${progress.per_week}`,
        // #3543: the count alone made the reader do the division against the day
        // of the week. The verdict already exists on this object; the word is the
        // non-color channel (#1220) and the tint only seconds it.
        detail: behind ? (
          <>
            this week ·{" "}
            <span
              data-testid="standing-pace"
              className={`badge ${PACE_BADGE_CLASS.behind}`}
            >
              {frequencyPaceLabel("behind")}
            </span>
          </>
        ) : (
          "this week"
        ),
        href: habitHref,
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
        // Owner ruling #3245: `owed` COMPOSES WITH THE MOMENT. Behind pace alone
        // put a never-touched 2x/week target back in Now from day 4 of every
        // week, filling the cap with cards nobody could act on. The standing fact
        // is told by the pace word on the reading above; the card earns a Now slot
        // only while this is a moment the person would normally do it.
        behind && momentOpen,
        momentOpen
      ),
      {
        // THE ROW SAYS WHAT IT IS, AND THE CONTROL SAYS WHAT IT DOES (#4841 item 2).
        // The label used to be `Log ${scope_value}` beside an action that also read
        // "Log", so the row printed the verb twice and named its subject by the
        // STORED KEY — "Log Lower · 0 of 2 this week · Log". `cadenceScopeNoun` is
        // the app's existing answer to "what is this target called" (the recap and
        // the practice nudge already ask it), so the noun comes from there rather
        // than from a second casing rule here.
        label: cadenceScopeNoun(
          progress.target.scope_kind,
          progress.target.scope_value
        ),
        detail: `${progress.count} of ${progress.per_week} this week`,
        href: habitHref,
        actionLabel: "Log",
      }
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
      {
        label: protocol.name,
        value: `${protocol.daysElapsed} days`,
        href: protocol.href,
      }
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
        {
          label: "Adherence",
          value: protocol.adherence.value,
          detail: protocol.adherence.detail,
          href: protocol.href,
          moment: { title: protocol.name, href: protocol.href },
        }
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
        {
          label: protocol.primaryOutcome.label,
          value: protocol.primaryOutcome.framing,
          href: protocol.href,
          moment: { title: protocol.name, href: protocol.href },
        }
      );
    if (protocol.practiceName && protocol.practiceUsuallyToday && canWrite)
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
        {
          label: `Log ${protocol.practiceName}`,
          href: protocol.href,
          actionLabel: "Open",
        }
      );
  });
  sourceOrder += activeProtocols.length * 4;

  for (const finding of dataQualityFindings) {
    add(
      progressCandidates.statement(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "data-quality.finding",
        finding.dedupeKey,
        `finding.${finding.dedupeKey}`,
        // THE SHARED groupKey (#4076 part 2). Five findings each carrying a unique
        // key gave the moment-block fold nothing to fold on, so five rows each
        // headed "Data quality" scrolled past saying the same words. It is only
        // REACHABLE now: while these rendered cards the fold was never consulted.
        "data-quality.finding"
      ),
      findingRow(finding, dismissDataQualityGap, "Data quality")
    );
  }

  if (proteinToday) {
    // A number and a goal (#3257). It read "≥ 69 g · Goal ~80–105 g/day (1.2–1.6 g/kg,
    // general fitness) · … · From logged foods + protein logged — a floor, actual likely
    // higher": an inequality, the band's derivation, two table names, and a hedge about
    // the ESTIMATOR. Amount and band now come from the parts Telegram reads, so the "+"
    // carries the floor in one character; the rest moved to the row's hover.
    const proteinLine = proteinTodayLineParts(proteinToday);
    add(
      dailyCandidates.protein(
        {
          subject: profileSubject,
          applicable: foodLoggingApplicable,
          sourceOrder: sourceOrder++,
        },
        on,
        // `both-sources` carries integration data too (#3903), so it is external.
        proteinToday.todayIntake?.basis === "tracked" ||
          proteinToday.todayIntake?.basis === "both-sources"
          ? "external"
          : "manual",
        mealTimeWindows(nowMealAnchors)
      ),
      // The row renders every part of #3257's copy: the figure with its floor "+",
      // the band, the trailing average in "g", and the derivation behind the
      // disclosure control.
      {
        value: proteinLine.amount,
        detail: [
          `Goal ${proteinLine.band}`,
          proteinToday.trailing.grams != null && !proteinToday.trailing.dayOne
            ? `7-day average ${Math.round(proteinToday.trailing.grams)} g`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        disclosure: proteinTodayExplanation(proteinToday),
        href: "/nutrition",
        moment: { title: "Nutrition today", href: "/nutrition" },
        presence: "current",
      }
    );
  } else if (foodLoggingApplicable)
    add(
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
  if (routineControl && routineTiming)
    add(
      dailyCandidates.usualRoutine(
        {
          subject: profileSubject,
          applicable: foodLoggingApplicable,
          sourceOrder: sourceOrder++,
        },
        routineControl.window,
        on,
        routineTiming
      ),
      {
        // A CONTROL-ONLY ROW, and the one on the page. The composed-morning offer's
        // control IS its own label: it names EVERY serving and EVERY dose the tap
        // will write, because a label is a promise the write core re-derives and
        // intersects (#2458) — and #3736 already ruled that a control naming doses
        // cannot compress into a pill. Giving the row its own label as well would
        // print the same promise twice, which is the defect this grammar replaced.
        // The control is unchanged from the quick-log sheet's mount, whose reserved
        // height pins it (LOG_SHEET_CONTEXT_RESERVE_PX).
        control: <UsualRoutineControl {...routineControl} />,
      }
    );

  if (intradayToday)
    add(
      dailyCandidates.intraday(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        on
      ),
      {
        // The lag sentence is the row's FACTS — the one thing the drawing cannot
        // say about itself (#4767 item 5).
        value: intradayFreshness(intradayToday) ?? undefined,
        href: historyDayIntradayHref(on),
        presence: "current",
        figure: (
          <IntradayChart
            model={intradayToday}
            formatPrefs={formatPrefs}
            profileId={profile.id}
            variant="compact"
            className="w-full"
          />
        ),
      }
    );

  if (stepsSummary)
    add(
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
            // Absent for most of the day BY DESIGN (#3258): the summary withholds it
            // until today can be compared, so the row states the neutral average alone
            // rather than a percentage that was only ever counting the hours.
            stepsSummary.deltaPct == null
              ? null
              : `${stepsSummary.deltaPct > 0 ? "+" : ""}${stepsSummary.deltaPct}% vs prior 7 days`,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        // The desktop column (#3252) draws the window this row's own sentence talks
        // about: today plus the prior seven days, the same span `summarizeStepsToday`
        // averages, off the same series it was handed. Steps declare `slot-null`, so a
        // day nobody measured is a HOLE in the stroke rather than a zero — a total is
        // not a level and may not be bridged.
        series: {
          points: stepsRows.filter(
            (row) => row.date >= shiftDateStr(on, -STEPS_TRAILING_DAYS)
          ),
          seriesKey: "metric:steps",
          stale: false,
          name: `Steps, today and the prior ${STEPS_TRAILING_DAYS} days`,
          pointLabel: (point) =>
            `${point.value.toLocaleString("en-US")} steps · ${formatLongDate(point.date, formatPrefs)}`,
          loneCaption: `Single reading · ${formatLongDate(on, formatPrefs)}`,
        },
        href: "/trends#body",
        presence: "current",
      }
    );
  else
    add(
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

  // Each vital row resolves its OWN state before it renders: a year-quiet quantity takes
  // the dormant seat, a live one is untouched. The branch is per row rather than per
  // family precisely so a 2022 blood pressure cannot collapse this morning's resting
  // heart rate (#3226).
  const bpAge = vitalsModel?.bp
    ? glanceAgeToken({
        date: vitalsModel.bp.date,
        today: on,
        freshness: vitalsModel.bp.freshness,
        form: "long",
        floorLabel: VITAL_PRESENTATION_FLOORS["blood-pressure"].label,
        dateLabel: formatLongDate(vitalsModel.bp.date, formatPrefs),
      })
    : null;
  const restingHrAge = vitalsModel?.restingHr
    ? glanceAgeToken({
        date: vitalsModel.restingHr.date,
        today: on,
        freshness: vitalsModel.restingHr.freshness,
        form: "long",
        floorLabel: VITAL_PRESENTATION_FLOORS["resting-hr"].label,
        dateLabel: formatLongDate(vitalsModel.restingHr.date, formatPrefs),
      })
    : null;
  if (vitalsModel?.bp?.dormant)
    add(
      dailyCandidates.vitalDormant(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "blood-pressure",
        vitalsModel.bp.date
      ),
      {
        detail:
          dormantRecordSince("blood-pressure", vitalsModel.bp.date) ??
          dormantRecordLine(
            "blood-pressure",
            freshnessAgeDays(vitalsModel.bp.date, on) ??
              DORMANCY_DOMAINS["blood-pressure"].collapseAfterDays
          ),
        href: "/trends#body",
        actionLabel: "Vitals history",
        // THE DOOR THAT ENDS THE DORMANCY (#4841 item 3). The line says a reading is
        // missing; until now the only thing it opened was the history of the reading
        // it says is missing. This is the door #4757 gives a stale reading, on the
        // row where the reading is gone altogether — the same form, the same group
        // and the same words as `staleMeasurementDoor` puts on the live vitals rows,
        // so the family speaks once. It is spelled out rather than borrowed because
        // that helper is gated on a glance-age token, and a dormant row has no
        // reading left to have an age. "Vitals history" stays beside it as the
        // family's door, like every other row here.
        control: (
          <DashboardQuickEntryAction
            form="measurements"
            prefill={{ measurementGroup: "vitals" }}
            actionLabel="Log a vital"
          />
        ),
        presence: "dormant",
      }
    );
  else if (vitalsModel?.bp)
    add(
      dailyCandidates.vital(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "blood-pressure",
        vitalsModel.bp.date
      ),
      {
        value: (() => {
          const age = bpAge!;
          const direction = vitalsModel.bp.direction;
          return (
            <span
              className="inline-flex flex-wrap items-baseline gap-x-2"
              data-testid="vitals-latest-bp"
            >
              <span>{`${vitalsModel.bp.systolic}/${vitalsModel.bp.diastolic} mmHg`}</span>
              <StandingAge age={age} testId="vitals-latest-bp-age" />
              {direction && (
                <span className="sr-only">{`${direction === "flat" ? "flat" : direction} versus previous blood pressure`}</span>
              )}
            </span>
          );
        })(),
        href: "/trends#body",
        disclosure: bpAge?.title ?? undefined,
        control: staleMeasurementDoor(bpAge!, "vitals", "Log a vital"),
        presence: "current",
      }
    );
  if (vitalsModel?.restingHr?.dormant)
    add(
      dailyCandidates.vitalDormant(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "resting-heart-rate",
        vitalsModel.restingHr.date
      ),
      {
        detail:
          dormantRecordSince("resting-hr", vitalsModel.restingHr.date) ??
          dormantRecordLine(
            "resting-hr",
            freshnessAgeDays(vitalsModel.restingHr.date, on) ??
              DORMANCY_DOMAINS["resting-hr"].collapseAfterDays
          ),
        href: "/trends#body",
        actionLabel: "Vitals history",
        // Its blood-pressure sibling's door, for the same reason (#4841 item 3).
        control: (
          <DashboardQuickEntryAction
            form="measurements"
            prefill={{ measurementGroup: "vitals" }}
            actionLabel="Log a vital"
          />
        ),
        presence: "dormant",
      }
    );
  else if (vitalsModel?.restingHr)
    add(
      dailyCandidates.vital(
        { subject: profileSubject, sourceOrder: sourceOrder++ },
        "resting-heart-rate",
        vitalsModel.restingHr.date
      ),
      {
        value: (() => {
          const age = restingHrAge!;
          const direction = vitalsModel.restingHr.direction;
          return (
            <span
              className="inline-flex flex-wrap items-baseline gap-x-2"
              data-testid="vitals-latest-resting-hr"
            >
              <span>{`${vitalsModel.restingHr.value} bpm`}</span>
              <StandingAge age={age} testId="vitals-latest-resting-hr-age" />
              {direction && (
                <span className="sr-only">{`${direction === "flat" ? "flat" : direction} versus previous resting heart rate`}</span>
              )}
            </span>
          );
        })(),
        // The desktop column (#3252). These are the points the gather ALREADY pulled
        // to decide this row's arrow (the bounded trend tail, lib/queries/vitals-latest
        // — two readings, or one), carried through rather than re-read: the plot draws
        // exactly the movement the arrow claims. The tone follows this row's own glance
        // age, so a resting HR past its 180-day floor is amber in both places at once.
        series: {
          points: vitalsModel.restingHr.points,
          seriesKey: "metric:resting_hr",
          stale: vitalsModel.restingHr.freshness === "due",
          name: "Resting heart rate, latest readings",
          pointLabel: (point) =>
            `${point.value} bpm · ${formatLongDate(point.date, formatPrefs)}`,
          loneCaption: `Single reading · ${formatLongDate(vitalsModel.restingHr.date, formatPrefs)}`,
        },
        href: "/trends#body",
        disclosure: restingHrAge?.title ?? undefined,
        control: staleMeasurementDoor(restingHrAge!, "vitals", "Log a vital"),
        presence: "current",
      }
    );
  add(
    setupCandidates.vitalsBootstrap({
      subject: profileSubject,
      applicable: canWrite,
      sourceOrder: sourceOrder++,
    }),
    {
      label: "Vitals",
      control: (
        <DashboardQuickEntryAction
          form="measurements"
          prefill={{ measurementGroup: "vitals" }}
          actionLabel="Log a vital"
        />
      ),
    }
  );
  if (cycleModel)
    add(
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
      {
        label: nextAppt.title,
        value: nextAppt.whenLabel,
        detail: nextAppt.dueText,
        href: nextAppt.href,
        moment: { title: "Next appointment", href: "/records/history/visits" },
      }
    );

  labRows.forEach((row, index) => {
    const acknowledgeKey = labPromotions.get(row.name)?.acknowledgeKey;
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
        detail: <StandingAge age={age} testId="recent-lab-date" />,
        href: row.href,
        disclosure: age.title ?? undefined,
        moment: { title: "Recent clinical results", href: "/results" },
        presence: "current",
        control:
          canWrite && acknowledgeKey ? (
            <SnoozeDismissMenu
              itemName={row.name}
              signalKey={acknowledgeKey}
              snoozeAction={snoozeAttention}
              dismissAction={dismissAttention}
            />
          ) : undefined,
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
      {
        label: "Clinical results",
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
    add(
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
    add(
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
    if (latestWeight) {
      // Weight's glance floor is the one its Trends card already reads (#4757): the
      // self-measured six weeks of TREND_METRIC_PRESENTATION_FLOORS, by reference, so
      // the dashboard and the chart cannot disagree about how old a weigh-in may be.
      // Between that floor and the 90-day dormancy collapse the row keeps its value,
      // goes amber, and grows the door.
      const weightAge = glanceAgeToken({
        date: latestWeight.date,
        today: on,
        freshness: trendMetricPresentationFreshness(
          "weight",
          latestWeight.date,
          on
        ),
        form: "long",
        floorLabel: TREND_METRIC_PRESENTATION_FLOORS.weight.label,
        dateLabel: formatLongDate(latestWeight.date, formatPrefs),
      });
      add(
        progressCandidates.weightLatest(
          { subject: profileSubject, sourceOrder: sourceOrder++ },
          latestWeight.date,
          weightEngagement
        ),
        {
          label: "Latest",
          value: `${latestWeight.value} ${units.weightUnit}`,
          // The date stays visible when the destination door appears (#3555).
          detail: <StandingAge age={weightAge} testId="weight-latest-age" />,
          // The desktop column (#3252): the SAME trailing-90-day series the weight
          // domain already derived above for this page — not a second read, and not a
          // second window. The tone follows this row's own glance age, as the resting
          // HR plot does.
          series: {
            points: bodyMetrics,
            seriesKey: "metric:weight",
            stale: weightAge.stale,
            name: `Weight, last ${WEIGHT_TREND_WINDOW_DAYS} days`,
            pointLabel: (point) =>
              `${point.value} ${units.weightUnit} · ${formatLongDate(point.date, formatPrefs)}`,
            loneCaption: `Single reading · ${formatLongDate(latestWeight.date, formatPrefs)}`,
          },
          href: "/trends#body",
          disclosure: weightAge.title ?? undefined,
          control: staleMeasurementDoor(weightAge, "body", "Log weight"),
          presence: "current",
        }
      );
    }
    add(
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
      {
        label: "Sleep",
        // The SAME headline /sleep prints, marked the same way: one decision, three
        // surfaces (#2097). The row replaces the figures rather than sitting above
        // them — the state exists precisely because the only number available is a
        // different night's.
        value: (
          <span
            data-testid="sleep-waiting-headline"
            data-kind={sleepWaiting.kind}
          >
            {sleepWaiting.headline}
          </span>
        ),
        detail: [
          sleepWaitingDetail(sleepWaiting, {
            clock: (min) => formatClockMinutes(formatPrefs.timeFormat, min),
            when: (iso) => formatRelativeTime(iso),
          }),
          sleepPreviousNightLabel,
        ]
          .filter(Boolean)
          .join(" · "),
        href: "/sleep",
      }
    );
  else if (lastSleepRecord == null)
    add(
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
    add(
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
      { label: "Sleep", href: "/data", actionLabel: "Sync a source" }
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
              nowMinutes,
              sleepClockSkewSuspect
            )
        ),
        {
          label: title,
          value,
          // #3970 owner ruling (2026-08-30). The band used to be a DISCLOSURE on
          // both the bed-time and the wake-time member — the same string, two 34px
          // buttons, on one line. It inlines ONCE instead, as plain detail text after
          // the wake time, so #3253's glance-context rider survives with no per-row
          // control. Duration never carried it and still does not: a duration has no
          // usual bed-and-wake pair to be measured against.
          detail: sleepClockSkewSuspect
            ? key === "duration"
              ? undefined
              : SLEEP_SKEW_HEDGE
            : key === "wake-time"
              ? usualSleepBand
              : undefined,
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
      {
        label: formatSleepWindow(
          formatPrefs.timeFormat,
          nap.startMinutes,
          nap.endMinutes
        ),
        value: formatHm(nap.durationMin),
        href: "/sleep#naps",
        moment: { title: "Today's naps", href: "/sleep#naps" },
      }
    )
  );
  if (todayNaps.length > 0)
    add(
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
    add(
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
        moment: { title: "Healthspan pillars", href: "/longevity" },
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
        `finding.${finding.dedupeKey}`,
        "coaching.observation"
      ),
      findingRow(finding, dismissCoachingObservation, "Coaching observations")
    )
  );
  sourceOrder += coachingObservations.length;

  const recapMomentTitle = weeklyRecap
    ? `${recapScaleEntry(weeklyRecap.scale).label} · ${recapRangeLabel(
        weeklyRecap.start,
        weeklyRecap.end,
        formatPrefs
      )}`
    : "";
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
      {
        // A bare line is already self-labelled (#1935); printing the label
        // beside it would name the row twice.
        ...(line.bare ? {} : { label: line.label }),
        value: line.value,
        detail: recapLineAnnotation(line),
        href: "/history",
        // THE MOMENT (#3365). Six recap facts used to be six identical cards, one
        // line each; the scale and the window they all share is stated once, at the
        // head of the block they fold into.
        moment: { title: recapMomentTitle, href: "/history" },
      }
    )
  );

  const dashboardPlacements = rankDashboardCandidates(candidates, {
    activeProfileId: profile.id,
    minutesOfDay: nowMinutes,
    today: on,
    upcoming,
  });
  const illnessGroupKeys = orderedIllnessGroupKeys(dashboardPlacements);
  const illnessByGroupKey = new Map(
    illnessCockpits.map((cockpit) => [cockpit.stateIdentity!.groupKey, cockpit])
  );
  const placedEpisodeCandidateIds = new Set(
    dashboardPlacements
      .filter(
        (placement) =>
          placement.lane === "now" && placement.nowLayer === "illness"
      )
      .map((placement) => placement.candidate.candidateId)
  );
  const placedIllnessCockpits = illnessGroupKeys.map((groupKey) => {
    const cockpit = illnessByGroupKey.get(groupKey);
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

  // The placement canvas gets a DECLARED width (#3253). The dashboard rendered bare
  // into the shell, whose only limit is the 110rem 3xl cap, so on a wide monitor
  // "Mark taken" sat ~1,400px from its own card's title and Standing's rows were
  // two-thirds dead space. `wide` is the existing 72rem token — no new width invented
  // — and `mx-auto` centres it inside the shell exactly the way
  // app/(app)/records/layout.tsx already does.
  return (
    <PageContainer
      width="wide"
      className="mx-auto"
      data-testid="dashboard-canvas"
    >
      {/* THE DASHBOARD DECLARES ITSELF (#3087). Every logging control placed on this
          canvas — the weigh-in widget, the symptom bar, the food bar, the "Log a
          dose" card, the reading button — is the SAME component its domain page
          mounts, posting the SAME Server Action. Without this the server reads all of
          them as that page's own form, and `dashboard-widget` is produced by nothing.
          The attention card's act-now confirms are separate actions of their own and
          stamp `dashboard-hero` at the action; this covers the widget half. */}
      <LoggedViaSurface value="dashboard-widget">
        <DashboardPlacementCanvas
          dateLabel={formatLongDate(on, formatPrefs)}
          placements={dashboardPlacements}
          presentations={presentations}
          aheadPresentations={aheadPresentations}
          attentionBadgeCount={attentionBadgeCount}
          nowSubjects={nowSubjects}
          illnessGroupNode={
            placedIllnessCockpits.length > 0 ? (
              <IllnessNowGroup
                cockpits={placedIllnessCockpits}
                initialCollapsedActive={illnessUi.collapsedActive}
                initialOpenOtherKey={illnessUi.openOtherKey}
                saveState={saveIllnessNowState}
              />
            ) : undefined
          }
        />
      </LoggedViaSurface>
    </PageContainer>
  );
}
