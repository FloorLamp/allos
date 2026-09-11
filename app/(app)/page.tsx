import { Suspense, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import Disclosure from "@/components/Disclosure";
import { redirect } from "next/navigation";
import { now as clockNow } from "@/lib/clock";
import { today } from "@/lib/db";
import {
  collectAttentionDashboardData,
  getCycleTrackingRelevance,
  getDaylightOutdoorMinutesByDay,
  getFindingSuppressions,
  getLastNightSummary,
  getMetricDailyTotals,
  getNapHistory,
  getProteinToday,
  getSleepWaitingState,
  getWorkoutPresence,
  gatherCoachingInput,
  typicalBedTime,
  typicalWakeTime,
} from "@/lib/queries";
import { getForecastSuspension, listCyclePeriods } from "@/lib/cycle-store";
import { getActiveFastCached } from "@/lib/queries/fasting";
import { fastElapsedMs, formatFastDuration, type Fast } from "@/lib/fasting";
import type { WorkoutPresence } from "@/lib/workout-presence";
import {
  cycleControlState,
  type CycleControlState,
} from "@/lib/cycle-plausibility";
import PeriodOfferButton from "@/components/cycle/PeriodOfferButton";
import { summarizeStepsToday } from "@/lib/steps-today";
import { STEPS_AFTERNOON_HOUR } from "@/lib/steps-target";
import IntradayChart from "@/components/IntradayChart";
import { IntradayInteractionProvider } from "@/components/IntradayInteraction";
import { getIntradayDay } from "@/lib/queries/intraday";
import { intradayFreshness } from "@/lib/intraday";
import {
  isFoodLoggingRelevant,
  isStrengthTrainingRelevant,
  isTrainingRelevant,
} from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings/profile-attrs";
import {
  recommendCoaching,
  strengthAppropriateCoachingInput,
} from "@/lib/coaching";
import { COACHING_COLLECTION } from "@/lib/rule-findings";
import { activeFindings } from "@/lib/findings";
import { requireSession } from "@/lib/auth";
import { canWrite, requireScope, type ProfileScope } from "@/lib/scope";
import { writeSubjectName } from "@/lib/own-profile";
import { currentFoodSlotWindow } from "@/lib/queries/nutrition";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";
import { foodGroupName } from "@/lib/food-groups";
import { namesPhrase, usualRoutineFoodMembers } from "@/lib/usual-routine";
import { TIME_BUCKET_LABELS } from "@/lib/intake-schedule";
import { withAiLogContext } from "@/lib/ai-log";
import { runRecommendation } from "@/lib/recommendation-engine";
import {
  getDisplayFormatPrefs,
  getHomeLocation,
  getStepsDailyTarget,
  getIllnessNowUi,
  getOnboardingState,
  getRecentlyResolvedDismissed,
  getTimezone,
  getUnitPrefs,
  withPrimedSettings,
} from "@/lib/settings";
import {
  hhmmToMinutes,
  hourInTz,
  isRealIsoDate,
  parseUtcSql,
  shiftDateStr,
  zonedDateParts,
} from "@/lib/date";
import {
  formatClockMinutes,
  formatLongDate,
  formatMonthDay,
  formatRelativeTime,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { getUvDoseForDays } from "@/lib/queries/weather";
import { solarDay } from "@/lib/sun";
import { historyMemberFeed } from "@/lib/history";
import {
  HISTORY_DEFAULT_SHOW,
  historyRowPick,
  layoutHistoryDay,
  type HistoryRow,
} from "@/lib/history-format";
import { groupHistoryBundles } from "@/lib/history-bundle";
import HistoryRows from "./history/HistoryRows";
import { getIntakeDoses, getIntakeItems } from "@/lib/queries";
import { getActivitiesByDate } from "@/lib/queries/training/activities";
import type { Activity } from "@/lib/types/training";
import type { DoseLedgerItem } from "@/components/intake/dose-ledger-entry";
import { isOnDemand } from "@/lib/intake-schedule";
import {
  DaySelectToggle,
  DaySelectionBar,
  DaySelectionProvider,
} from "@/components/DaySelection";
import TimelineDayNav from "@/components/TimelineDayNav";
import PageContainer from "@/components/PageContainer";
import StreamedSection, { PendingSection } from "@/components/StreamedSection";
import IllnessNowGroup, {
  type IllnessContextCockpit,
} from "@/components/dashboard/IllnessNowGroup";
import RecentlyResolvedReopenControls, {
  type RecentlyResolvedItem,
} from "@/components/dashboard/RecentlyResolvedReopenControls";
import DoseConfirmButton from "@/components/DoseConfirmButton";
import SnoozeDismissMenu from "@/components/SnoozeDismissMenu";
import DoseSlotTakeAll from "@/components/dashboard/DoseSlotTakeAll";
import FollowUpResolveControls from "@/components/FollowUpResolveControls";
import FindingDismissButton from "@/components/FindingDismissButton";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import UsualRoutineControl from "@/components/dashboard/UsualRoutineControl";
import {
  LOGGED_EVENT_LIST,
  LOGGED_EVENT_ROW,
  LOGGED_EVENT_TRAILING,
} from "@/components/LoggedEventRow";
import { resolveFollowUp } from "./upcoming/actions";
import {
  episodeStatesForProfiles,
  openEpisodeRowsForProfiles,
  reopenEligibleFromState,
  type ProfileEpisodeState,
} from "@/lib/illness-episode-store";
import { openEpisodesFromState } from "@/lib/illness-episode";
import {
  assignOrderedEpisodeFacts,
  episodeCollapsedStatus,
  episodeLatestDose,
  orderIllnessCockpits,
} from "@/lib/illness-episode-format";
import {
  gatherDashboardIllnessCockpits,
  type DashboardIllnessCockpitModel,
} from "@/lib/dashboard-illness-cockpit";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { householdFanoutWithActing } from "@/lib/household-fanout";
import { careCandidates } from "@/lib/dashboard-candidates";
import IllnessCockpitBody from "../../components/illness/IllnessCockpitBody";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import AppBadge from "@/components/AppBadge";
import { attentionBadgeItems } from "@/lib/attention";
import {
  dismissAttention,
  dismissDataQualityGap,
  dismissRecentlyResolved,
  markAttentionDose,
  saveIllnessNowState,
  snoozeAttention,
  undoAttentionDose,
} from "./actions";
import {
  episodeHref,
  historyHref,
  trainingActivityPageHref,
} from "@/lib/hrefs";
import { visibleRecentlyResolved } from "@/lib/recently-resolved";
import { withReadSnapshot } from "@/lib/read-snapshot";
import { proteinTodayLineParts } from "@/lib/protein";
import { sleepWaitingDetail } from "@/lib/sleep-waiting";
import { SLEEP_SKEW_HEDGE } from "@/lib/sleep-clock-skew";
import { isSuspectSleepWakeDay } from "@/lib/queries/sleep-clock-skew";
import {
  formatHm,
  formatSleepWindow,
  formatUsualSleepBand,
  sleepRecordPresentation,
} from "@/lib/sleep-summary";
import { formatCount } from "@/lib/format-number";
import { fmtDistance } from "@/lib/units";
import type { DistanceUnit } from "@/lib/settings/display";
import {
  isItemSuppressibleFlag,
  upcomingDueText,
  type UpcomingItem,
} from "@/lib/upcoming";
import { itemDetailText } from "@/lib/upcoming-aggregate";
import {
  composeHomeList,
  composeHomeSetup,
  type HomeLaterEntry,
  type HomeList,
  type HomeNowRow,
  type HomeSetupRow,
} from "@/lib/home-list";
import type { OpenDayEpisode, OpenEpisode } from "@/lib/open-episode";
import { formatMinutes } from "@/lib/duration";
import HomeEndFastButton from "@/components/home/HomeEndFastButton";
import HomeReceipt from "@/components/home/HomeReceipt";
import { timelineEntryAnchorId } from "@/lib/timeline-format";
import type { WeightUnit } from "@/lib/settings/display";

export const dynamic = "force-dynamic";

// HOME IS THE RECORD'S DAY VIEW AT TODAY (#5435 §3).
//
// v2 ranked candidates into four lanes and cut them to a cap, so what a person saw at
// 07:40 was not what they saw at 16:00 and neither was the whole of what was owed. v3
// renders what `/history?day=<today>` renders — the day bar, the glance card and the
// day's own rows — with three additions that exist only on today: a folded Later row, a
// Now rule, and the due rows under it. WHAT GOES WHERE is `lib/home-list.ts`, which owns
// every seat decision and takes no clock and no DB of its own; this file is the
// URL → gather → render seam and nothing else.
//
// THE ROW CONTRACT (§5.1) reaches the DOM as `data-candidate-id`, deliberately keeping
// the attribute name the ranker used: it is the e2e locator, the dismissal key and the
// Telegram handoff's scroll target (§6.2), and 84 specs visit `/`. A rename is its own
// PR, if ever.

export default async function Dashboard() {
  const session = await requireSession();
  const scope = await requireScope();
  // ONE SPELLING OF THE OPENING (#5774). Home wrote the cache scope and its three
  // preloads out by hand, and the record's day view then wrote them again — the
  // second copy #5774 exists to prevent. The helper IS those four calls, so nothing
  // about the reads changes; what changes is that a third page cannot spell them a
  // third way.
  //
  // THE WHOLE ACCESSIBLE SET, not the acting profile alone. Home's second inline
  // `preloadProfileSettings` primed the household because Current care fans out over
  // every authorized profile (timezone, format and illness-UI reads per member), and
  // that set is exactly `scope.ids`. Priming it here instead of mid-render keeps the
  // preload in the frame that opens the cache, which is the only frame it reaches
  // (#5012) — see `withPrimedSettings`. The streamed sections below open their own,
  // for the same reason: an AsyncLocalStorage scope does not cross into a child
  // Server Component React schedules itself (§6.1's "the cache spans every boundary"
  // is that call, not an inherited scope).
  return withPrimedSettings(
    { loginId: scope.loginId, profileIds: scope.ids },
    () => {
      const profileAge = getProfileAge(session.profile.id);
      // #5435 §6.4: the navigation-triggered recommendation keeps its position —
      // before the onboarding redirect, inside the request's own frame, quota and
      // consent unchanged. Deleting presentation must not move this side effect.
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
      return withReadSnapshot(() => renderHome(session, scope, profileAge));
    }
  );
}

async function renderHome(
  session: Awaited<ReturnType<typeof requireSession>>,
  scope: ProfileScope,
  profileAge: ReturnType<typeof getProfileAge>
) {
  const { login, profile, access } = session;
  const writable = canWrite(scope, profile.id);
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
  const nowInstant = clockNow();
  const nowMinutes = hhmmToMinutes(zonedDateParts(timezone, nowInstant).hhmm);

  const accessible = scope.profiles;
  // Own-profile link (#1013): the acting-profile write forms name the subject when the
  // login is acting as someone OTHER than its own profile. Null (no naming) when acting
  // as self or no own-profile is set. Disambiguated (#534).
  const actingSubjectName = writeSubjectName(
    scope.ownProfileId,
    profile.id,
    disambiguateProfileNames(accessible).get(profile.id) ?? profile.name
  );
  const { attention } = collectAttentionDashboardData(profile.id, on, units);

  // Applicability belongs to each row and is never inferred from missing data. These
  // bits reuse the same life-stage/navigation decisions as the owning routes.
  const foodLoggingApplicable = isFoodLoggingRelevant(profileAge);
  const cycleApplicable = getCycleTrackingRelevance(profile.id, profileAge);
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
      canWrite: canWrite(scope, profileId),
      temperatureUnit: units.temperatureUnit,
      weightUnit: units.weightUnit,
      now: nowInstant,
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
        now: nowInstant,
      }
    );
    const displayStatus = episodeCollapsedStatus(
      displayEpisode,
      units.temperatureUnit,
      {
        timeZone: getTimezone(c.profileId),
        timeFormat: formatPrefs.timeFormat,
        now: nowInstant,
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
      canWrite: canWrite(scope, c.profileId),
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
          canWrite={canWrite(scope, c.profileId)}
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

  // ── THE THREE STATE ROWS, ON ONE LIFECYCLE (#5142 / §3.2 band 2) ──────────────
  //
  // Training, Fast and Period are three renderings of ONE question — "is this still
  // going?" — asked through `lib/open-episode.ts` and answered by the composer. This
  // page's job is to hand it each domain's own evidence, never a second reading of it.

  // The workout draft as an open episode. `lastSignalAt` is the draft's last save, which
  // is the presence derivation's own liveness signal (#451/#5142) — read back off the
  // result rather than recomputed here, so the dock and this row cannot disagree about
  // whether a session is still going.
  const workoutPresence = getWorkoutPresence(profile.id, nowInstant);
  const liveWorkout: OpenEpisode | null =
    workoutPresence.state === "active" && workoutPresence.lastSignalAt != null
      ? {
          kind: "workout",
          lastSignalAt: workoutPresence.lastSignalAt,
          expectedEnd: null,
        }
      : null;
  // A SESSION RECORDED ON THE PROFILE'S TODAY, which is not the same question as
  // `workoutPresence.state === "finished"`: that window is sixty minutes wide, so a
  // session logged this morning stops being "finished" by lunchtime and the row would
  // fall through to the next-workout arm for the rest of the day. The activity row's
  // own `date` IS the profile-local day it counts for, so "a session that ended before
  // midnight belongs to yesterday's record" (§3.2) is answered by the column rather
  // than re-derived here.
  //
  // A HUSK IS NOT A SESSION. The live draft is excluded by id — it is the in-progress
  // arm above, and a row cannot be both — and so is a row carrying no end, no duration
  // and no distance, which is the abandoned-draft shape `isDraftActivityRow` names.
  // Asked WITHOUT its set-count term, because the three columns here are also exactly
  // what the logged row prints, so one read answers both.
  const todaySession =
    getActivitiesByDate(profile.id, on).find(
      (activity) =>
        activity.id !== workoutPresence.activityId &&
        (activity.end_time != null ||
          activity.duration_min != null ||
          activity.distance_km != null)
    ) ?? null;
  // The shared next-workout recommendation, through the reader Home already pays for.
  // #5110's direct strength scan left Home with §7.2, so the logged state below carries
  // duration and distance only and this is asked purely for "is there one".
  const coachingInput = trainingRelevant
    ? strengthAppropriateCoachingInput(
        gatherCoachingInput(
          profile.id,
          units.weightUnit,
          units.distanceUnit,
          units.temperatureUnit
        ),
        strengthTrainingAvailable
      )
    : null;
  const nextWorkout = coachingInput
    ? recommendCoaching(coachingInput)[0]
    : null;

  // The fast as an open episode: a fast produces no evidence after its first tap, so its
  // start IS its last signal (`OpenEpisode.lastSignalAt`).
  const openFast = getActiveFastCached(profile.id);
  const fastStart = openFast ? parseUtcSql(openFast.started_at) : null;
  const fastEpisode: OpenEpisode | null =
    openFast && fastStart
      ? { kind: "fast", lastSignalAt: fastStart.getTime(), expectedEnd: null }
      : null;

  // The cycle domain's own answer, read rather than re-derived: two formulas over one
  // plausibility window is how the hero and the forecast card came to contradict each
  // other. §3.2 as the owner amended it (2026-09-11): a pregnancy silences the two
  // claim-making offers — which `canStart` already encodes — a postmenopausal
  // suspension silences nothing, and End is never silenced, so an open period's row
  // keeps its seat under every suspension.
  const cyclePeriods = cycleApplicable ? listCyclePeriods(profile.id) : [];
  const cycleControl = cycleApplicable
    ? cycleControlState(cyclePeriods, on, getForecastSuspension(profile.id))
    : null;
  const openPeriodStart = cycleControl?.openPeriodStart ?? null;
  const periodEpisode: OpenDayEpisode | null = isRealIsoDate(openPeriodStart)
    ? { kind: "period", lastSignalOn: openPeriodStart }
    : null;

  // THE COMPOSED ONE-TAP (#2458), kept as the seated slot's control rather than as a row
  // of its own: the window is `currentFoodSlot`'s, so the offer is evaluated for the
  // window it is ABOUT (#3265). Read-only access renders no control at all.
  const routineSlot =
    foodLoggingApplicable && writable
      ? currentFoodSlotWindow(profile.id)
      : null;
  const routineOffer =
    routineSlot != null
      ? getUsualRoutineOffer(profile.id, routineSlot.slot, on)
      : null;
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

  // ── THE ONE LIST (§3.2) ───────────────────────────────────────────────────────
  //
  // Every seat decision below this line is `composeHomeList`'s. It renders nothing,
  // reads no DB and takes no clock of its own, which is what makes "the order never
  // changes through the day" a property of one pure function rather than of this file.
  const homeList = composeHomeList({
    day: on,
    today: on,
    now: nowInstant.getTime(),
    minutesOfDay: nowMinutes,
    subject: { scope: "profile", profileId: profile.id },
    attention,
    training: {
      live: liveWorkout,
      loggedToday: todaySession != null,
      recommended: nextWorkout != null,
      applicable: trainingRelevant,
    },
    fast: fastEpisode,
    period: {
      episode: periodEpisode,
      canStartToday: cycleControl?.canStart === true,
      writable,
    },
  });

  // ── THE RECORD'S OWN DAY READ (§3.2 band 3, §7.3) ─────────────────────────────
  //
  // ONE day read serves the day bar's count, the record band and the chart: the events
  // the chart draws ticks for are the rows the list below shows, which is what makes "a
  // tick can never name something the list does not show" true by construction rather
  // than by two gathers agreeing. It is on the critical path because the day bar states
  // the count (§3.2); what streams behind the boundary is the glance card's own layers.
  const feed = historyMemberFeed(profile.id, {
    loginId: login.id,
    day: on,
    limit: HISTORY_DEFAULT_SHOW,
  });
  const dayRows = feed.gather.rows as HistoryRow[];
  const rowCount = dayRows.length;
  const layout = layoutHistoryDay(dayRows, { rollup: false });

  // The dose form's vocabulary, read once: which items exist (a retired item still took
  // the dose history keeps listing) and which still have a live dose to log against.
  const dosesByItem = new Map<number, DoseLedgerItem["doses"]>();
  for (const dose of getIntakeDoses(profile.id)) {
    const list = dosesByItem.get(dose.item_id) ?? [];
    list.push({
      id: dose.id,
      amount: dose.amount,
      time_of_day: dose.time_of_day,
      versions: dose.versions,
    });
    dosesByItem.set(dose.item_id, list);
  }
  const doseItems: DoseLedgerItem[] = getIntakeItems(profile.id).map(
    (item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      product: item.product,
      asNeeded: isOnDemand(item),
      doses: dosesByItem.get(item.id) ?? [],
    })
  );

  // SELECTION MODE, THE LEDGER'S (#5618 ruling 4), inherited whole: the record's Select
  // in the day bar, its boxes on the rows below, over the same per-row correction cores.
  const selectableCount = writable
    ? layout.visible.filter((row) => historyRowPick(row, profile.id) !== null)
        .length
    : 0;

  // THE TWO COLUMNS (§5.3): the list, and the glance card beside it, from `md` up. One
  // column on the phone, where the glance card leads — it is the day's own content, and
  // it is what the record puts directly under the day bar (#4918 ruling 2). The rail is
  // first in the document for that reason and placed into column 2 explicitly, so source
  // order reads correctly at the width that has no columns.
  const dayGrid = "md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:gap-6";
  const dayRail =
    "md:col-start-2 md:row-start-1 md:sticky md:top-6 md:self-start";
  const dayColumn = "md:col-start-1 md:row-start-1 md:min-w-0";

  return (
    <PageContainer width="wide" data-testid="dashboard-canvas">
      {/* THE PAGE DECLARES ITSELF (#3087). Every logging control placed here — the dose
          chips, the slot's Take all, the cockpit's symptom bar — is the SAME component
          its domain page mounts, posting the SAME Server Action. Without this the
          server reads all of them as that page's own form. */}
      <LoggedViaSurface value="dashboard-widget">
        {/* THE PAGE'S NAME, FOR A READER WHO CANNOT SEE ITS CHROME. Home spends no
            header: the nav already names it (#1616/#1661), the day bar below names
            the day, and #5435 §3 gives the page no title row at all. That leaves the
            document with no h1 and the day bar's h2 as its first heading, which is
            the gap `sr-only` exists for — the same shape `components/TabFirstPage.tsx`
            uses for a hub whose title the tab strip already carries. */}
        <h1 className="sr-only">Home</h1>
        {/* THE PWA BADGE, WHICH IS NOT PRESENTATION (#1424). It rode inside the
            placement canvas because that was the one component the page rendered;
            it belongs to the ACT-NOW SUBSET of the attention model, not to any
            layout, so it mounts here and survives the canvas. Count unchanged —
            `attentionBadgeItems` is the same pure selection over the same gather. */}
        <AppBadge count={attentionBadgeItems(attention, on).length} />
        {/* ── CURRENT CARE (§3.1) ────────────────────────────────────────────────
            Existing actionable safety items first, then every authorized open illness
            episode in the existing subject/episode order, each keeping the whole
            cockpit. Uncapped, collapsible, non-dismissible. Omitted when empty, with no
            all-clear claim. */}
        {illnessCockpits.length > 0 ? (
          <section data-testid="home-current-care" className="mb-4">
            <IllnessNowGroup
              cockpits={illnessCockpits}
              initialCollapsedActive={illnessUi.collapsedActive}
              initialOpenOtherKey={illnessUi.openOtherKey}
              saveState={saveIllnessNowState}
            />
          </section>
        ) : null}
        {/* REOPEN (§3.1), after the open episodes: for each profile in the existing
            bounded fanout, at most one eligible, undismissed row — "[Person] ·
            [episode] · resolved [date]" with the existing Reopen? and Hide controls.
            It renders only with write access TO THAT TARGET, which is the per-target
            correction §3.1 makes a prerequisite of the row: the shipped page tested
            the ACTING profile's access for every target, so a caregiver with write on
            one member and read-only on another was offered Reopen on both. Hide stays
            a per-login preference, for read-only viewers too. */}
        {recentlyResolved.length > 0 ? (
          <ul className={`${LOGGED_EVENT_LIST} mb-4`} data-testid="home-reopen">
            {recentlyResolved.map((item) => (
              <HomeRow
                key={`${item.profileId}:${item.episodeId}`}
                id={`care.illness-reopen:${item.profileId}:${item.episodeId}`}
                testId="home-reopen-row"
                title={
                  item.episodeHref ? (
                    <a className="hover:underline" href={item.episodeHref}>
                      {item.situation}
                    </a>
                  ) : (
                    item.situation
                  )
                }
                detail={
                  item.crossProfile ? item.displayName : "Recently resolved"
                }
                control={
                  <RecentlyResolvedReopenControls
                    item={item}
                    dismissAction={dismissRecentlyResolved}
                    canReopen={canWrite(scope, item.profileId)}
                  />
                }
              />
            ))}
          </ul>
        ) : null}

        <DaySelectionProvider
          config={{
            date: on,
            profileId: profile.id,
            testIdPrefix: "history",
            selectable: selectableCount > 0,
            moveTarget: { kind: "date", max: on },
          }}
        >
          {/* THE DAY BAR (§3.2), the record's own: ‹ yesterday, the date with its
              record count, and NO forward arrow — today has no day after it to walk to.
              Going back lands on the plain record of that day, which owes nothing and
              forecasts nothing. */}
          <TimelineDayNav
            prev={{
              href: historyHref({ day: shiftDateStr(on, -1) }),
              label: formatMonthDay(shiftDateStr(on, -1), formatPrefs),
            }}
            day={`${formatLongDate(on, formatPrefs)} — ${rowCount} record${
              rowCount === 1 ? "" : "s"
            }`}
            trailing={<DaySelectToggle />}
            targetSelector="[data-testid='dashboard-canvas']"
          />

          <div className={dayGrid}>
            <div className={dayRail} data-testid="home-glance-rail">
              {/* ── THE GLANCE CARD (§3.2), BEHIND THE FIRST BOUNDARY (§6.1) ──────
                  Current care, the Now band and the Quicklogger door are the shell;
                  the card's own layers stream behind it, so Due now is interactive
                  before the chart's gather resolves. The section opens its own primed
                  settings scope: an AsyncLocalStorage scope reaches the frame that
                  opened it and not the child Server Components React schedules below
                  it (#5012), so "the cache spans every boundary" is this call. */}
              <Suspense
                fallback={<PendingSection label="The day at a glance" />}
              >
                <StreamedSection>
                  <HomeGlance
                    profileId={profile.id}
                    loginId={login.id}
                    day={on}
                    dayEvents={feed.gather.dayEvents}
                    formatPrefs={formatPrefs}
                    timezone={timezone}
                    nowMinutes={nowMinutes}
                    nowInstant={nowInstant}
                    foodLoggingApplicable={foodLoggingApplicable}
                  />
                </StreamedSection>
              </Suspense>
            </div>

            <div className={dayColumn}>
              {/* ── THE LIST (§3.2): one list, three bands, in this order. ───────── */}
              <HomeLaterFold
                fold={homeList.later}
                formatPrefs={formatPrefs}
                today={on}
              />
              <HomeNowBand
                band={homeList.now}
                formatPrefs={formatPrefs}
                today={on}
                writable={writable}
                routineControl={routineControl}
                cycleControl={cycleControl}
                openFast={openFast}
                nowInstant={nowInstant}
                workoutPresence={workoutPresence}
                todaySession={todaySession}
                distanceUnit={units.distanceUnit}
                nextWorkoutTitle={nextWorkout?.title ?? null}
              />

              {/* THE VERBS SIT WITH THE ROWS THEY ACT ON (#5618 ruling 2's carve-out):
                  selection is a MODE, not a form. Renders nothing until Select is on. */}
              <div className="empty:hidden mb-3">
                <DaySelectionBar />
              </div>

              {/* ── THE RECORD (§3.2 band 3) ──────────────────────────────────────
                  The day's rows exactly as the record renders them under #5618 —
                  bundle rows, per-row menu, sheet-hosted edit, selection mode —
                  newest first, uncapped within the bounded day read. Not behind a
                  boundary: the read that feeds it is the day bar's own count, so a
                  boundary here would stream markup with no gather left behind it. */}
              <div data-testid="home-record">
                {rowCount === 0 ? (
                  <p
                    className="text-sm text-slate-500 dark:text-slate-400"
                    data-testid="history-empty-filtered"
                  >
                    No entries yet today.
                  </p>
                ) : (
                  <>
                    <HomeReceipt
                      rowId={
                        layout.visible[0]
                          ? timelineEntryAnchorId(layout.visible[0].id)
                          : null
                      }
                    />
                    <HistoryRows
                      rows={groupHistoryBundles(
                        layout.visible,
                        feed.gather.bundleFacts
                      )}
                      writableProfileIds={writable ? [profile.id] : []}
                      selectionSubjectId={profile.id}
                      doseItems={doseItems}
                      maxDates={{ [profile.id]: on }}
                      defaultTime={zonedDateParts(timezone, nowInstant).hhmm}
                      subjectNames={{}}
                    />
                  </>
                )}
              </div>

              {/* ── SETUP (§3.4), THE SECOND BOUNDARY (§6.1) ─────────────────────── */}
              <Suspense fallback={null}>
                <StreamedSection>
                  <HomeSetup
                    profileId={profile.id}
                    day={on}
                    loginId={login.id}
                    weightUnit={units.weightUnit}
                    formatPrefs={formatPrefs}
                  />
                </StreamedSection>
              </Suspense>
            </div>
          </div>
        </DaySelectionProvider>
      </LoggedViaSurface>
    </PageContainer>
  );
}

// ── ONE ROW SHAPE, TOP TO BOTTOM (§5.2) ─────────────────────────────────────────
//
// The Later, Now and Setup rows use the RECORD's own row shape — `LOGGED_EVENT_ROW`,
// 44px minimum, title, muted detail, trailing control — so the page is one list rather
// than three grammars stacked. The record band below them is the record's own rows
// (#5618), which carry that shape already.
//
// `data-candidate-id` is the row contract's id in the DOM (§5.1): the e2e locator, the
// dismissal key and the Telegram handoff's scroll target. The attribute NAME is kept
// from the ranker deliberately — 84 specs visit `/`.
function HomeRow({
  id,
  accent = false,
  title,
  detail,
  control,
  trailing,
  testId,
}: {
  id: string;
  /** The due slot's `--accent-soft` band (§5.2). */
  accent?: boolean;
  title: ReactNode;
  detail?: ReactNode;
  control?: ReactNode;
  trailing?: ReactNode;
  testId?: string;
}) {
  return (
    <li
      // The id is also the fragment a Telegram nudge's open-in-app link lands on
      // (§6.2): the row contract's own id, addressed the way a browser already
      // addresses an element, so there is no second deep-link scheme to define.
      id={id}
      data-candidate-id={id}
      data-testid={testId}
      // `target:` is the Telegram handoff's whole mechanism (§6.2): the row's id IS
      // the fragment the nudge's open-in-app link carries, so the browser scrolls to
      // it and this marks it. No deep-link scheme, and no script.
      className={`${LOGGED_EVENT_ROW} scroll-mt-24 transition-colors target:bg-(--accent-soft) ${
        accent ? "bg-(--accent-soft)" : ""
      }`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate">{title}</span>
        {detail ? (
          <span className="min-w-0 text-xs font-normal text-slate-500 dark:text-slate-400">
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className={LOGGED_EVENT_TRAILING}>{trailing}</span>
      ) : null}
      {control ? <span className="shrink-0">{control}</span> : null}
    </li>
  );
}

// ── THE LATER FOLD (§3.2 band 1) ────────────────────────────────────────────────
//
// ONE row, never more, whatever the schedule: six dose slots and a dentist appointment
// fold to one line, and so does one slot. Expanding lists the same entries as rows with
// their names and windows and NO CONTROLS — nothing on Home pre-logs, the same rule the
// quick-log sheet keeps (#5211). That is a property of `HomeLaterContent` itself: there
// is no control to leave out and no item riding along to reach one through.
//
// `<details>` rather than client state: the disclosure is the browser's, so the fold
// costs no JavaScript and works before hydration.
function HomeLaterFold({
  fold,
  formatPrefs,
  today,
}: {
  fold: HomeList["later"];
  formatPrefs: DisplayFormatPrefs;
  today: string;
}) {
  if (!fold) return null;
  const label = (entry: HomeLaterEntry): string => {
    const c = entry.content;
    if (c.kind === "dose-slot")
      return `${TIME_BUCKET_LABELS[c.bucket]} ${c.count}`;
    if (c.kind === "action") return c.name;
    return c.name;
  };
  const when = (entry: HomeLaterEntry): string | null => {
    const c = entry.content;
    if (c.kind === "commitment")
      return c.on ? formatMonthDay(c.on, formatPrefs, { today }) : null;
    return formatClockMinutes(formatPrefs.timeFormat, c.opensAt);
  };
  return (
    <Disclosure
      className={`${LOGGED_EVENT_LIST} mb-3`}
      data-testid="home-later"
    >
      <summary
        id={fold.row.id}
        data-candidate-id={fold.row.id}
        className={`${LOGGED_EVENT_ROW} cursor-pointer text-slate-500 marker:content-[''] dark:text-slate-400`}
      >
        <span className="min-w-0 flex-1 truncate">
          {["Later today", ...fold.entries.map(label)].join(" · ")}
        </span>
        {/* The disclosure chevron (§5.2), turned by the shared `group-open:`
            state `Disclosure` declares, so the fold's motion is the app's one
            continuity motion and not a second spelling of it (#3677). */}
        <IconChevronDown
          aria-hidden
          className={`${LOGGED_EVENT_TRAILING} h-4 w-4 transition-transform group-open:rotate-180`}
        />
      </summary>
      <ul>
        {fold.entries.map((entry) => (
          <HomeRow
            key={entry.id}
            id={entry.id}
            title={label(entry)}
            trailing={when(entry)}
            testId="home-later-entry"
          />
        ))}
      </ul>
    </Disclosure>
  );
}

// ── THE NOW BAND (§3.2 band 2) ──────────────────────────────────────────────────
//
// A rule reading "Now · <profile-local clock>", rendered once, between what is OWED and
// what is RECORDED, and directly under it the exact current actions in the composer's
// seat order. Nothing here decides which rows appear or in what order; every decision
// above the JSX belongs to `composeHomeList`.
function HomeNowBand({
  band,
  formatPrefs,
  today,
  writable,
  routineControl,
  cycleControl,
  openFast,
  nowInstant,
  workoutPresence,
  todaySession,
  distanceUnit,
  nextWorkoutTitle,
}: {
  band: HomeList["now"];
  formatPrefs: DisplayFormatPrefs;
  today: string;
  writable: boolean;
  routineControl: React.ComponentProps<typeof UsualRoutineControl> | null;
  cycleControl: CycleControlState | null;
  openFast: Fast | null;
  nowInstant: Date;
  workoutPresence: WorkoutPresence;
  todaySession: Activity | null;
  distanceUnit: DistanceUnit;
  nextWorkoutTitle: string | null;
}) {
  if (!band) return null;
  return (
    <section className="mb-3" data-testid="home-now">
      <h2
        className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
        data-testid="home-now-rule"
      >
        {`Now · ${formatClockMinutes(formatPrefs.timeFormat, band.minutesOfDay)}`}
      </h2>
      {band.rows.length > 0 ? (
        <ul className={LOGGED_EVENT_LIST}>
          {band.rows.map((row) => (
            <HomeNowRowView
              key={row.id}
              row={row}
              formatPrefs={formatPrefs}
              today={today}
              writable={writable}
              routineControl={routineControl}
              cycleControl={cycleControl}
              openFast={openFast}
              nowInstant={nowInstant}
              workoutPresence={workoutPresence}
              todaySession={todaySession}
              distanceUnit={distanceUnit}
              nextWorkoutTitle={nextWorkoutTitle}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function HomeNowRowView({
  row,
  formatPrefs,
  today,
  writable,
  routineControl,
  cycleControl,
  openFast,
  nowInstant,
  workoutPresence,
  todaySession,
  distanceUnit,
  nextWorkoutTitle,
}: {
  row: HomeNowRow;
  formatPrefs: DisplayFormatPrefs;
  today: string;
  writable: boolean;
  routineControl: React.ComponentProps<typeof UsualRoutineControl> | null;
  cycleControl: CycleControlState | null;
  openFast: Fast | null;
  nowInstant: Date;
  workoutPresence: WorkoutPresence;
  todaySession: Activity | null;
  distanceUnit: DistanceUnit;
  nextWorkoutTitle: string | null;
}) {
  const content = row.content;

  // A SLOT'S DUE DOSES ARE ONE ACT AT ONE MOMENT (#5063), so they are one row with its
  // members: individually identifiable chips on a second line, and the slot's own single
  // tap in the trailing cell — the usual-routine control when the routine's window IS
  // this slot, rather than a second row further down for the same act.
  if (content.kind === "dose-slot") {
    const members = content.items.map((item) => ({
      doseId: item.doseId!,
      // The CONTROL form of the name (#2858), collision-resolved by the gather: this
      // chip's tap WRITES, so it may not wear a name another item answers to.
      name: item.shortLabel ?? item.title,
      title: item.title,
    }));
    const routine =
      routineControl != null && routineControl.window === content.bucket
        ? routineControl
        : null;
    return (
      <HomeRow
        id={row.id}
        accent
        testId="home-dose-slot"
        title={`${TIME_BUCKET_LABELS[content.bucket]} (${members.length})`}
        detail={
          writable ? (
            // `gap-3` between two chips: `chip-base`'s coarse-pointer reach extends
            // 6px past the pill, so anything narrower overlaps two targets (#3938).
            <span className="flex w-full flex-wrap items-center gap-3">
              {members.map((member) => (
                <DoseConfirmButton
                  key={member.doseId}
                  action={markAttentionDose}
                  undoAction={undoAttentionDose}
                  fields={{ dose_id: member.doseId }}
                  payload={member.name}
                  ariaLabel={`Take ${member.title}`}
                  testid="attention-mark-taken"
                />
              ))}
              {routine && routine.food.length > 0 ? (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {`+ ${namesPhrase(routine.food.map((member) => member.name))}`}
                </span>
              ) : null}
            </span>
          ) : (
            namesPhrase(members.map((member) => member.name))
          )
        }
        trailing={content.overdue ? "Overdue" : undefined}
        control={
          writable ? (
            routine ? (
              <UsualRoutineControl {...routine} />
            ) : (
              <DoseSlotTakeAll date={today} doses={members} />
            )
          ) : undefined
        }
      />
    );
  }

  if (content.kind === "item") {
    const item = content.item;
    return (
      <HomeRow
        id={row.id}
        testId="home-action"
        title={item.title}
        detail={attentionRowDetail(item, today, formatPrefs)}
        control={
          writable ? (
            <>
              {item.doseId != null && (
                <DoseConfirmButton
                  action={markAttentionDose}
                  undoAction={undoAttentionDose}
                  fields={{ dose_id: item.doseId }}
                  payload={item.shortLabel ?? item.title}
                  ariaLabel={`Take ${item.title}`}
                  testid="attention-mark-taken"
                />
              )}
              {item.practiceLog != null && (
                <LogPracticeButton
                  practice={item.practiceLog.practice}
                  todayCount={item.practiceLog.todayCount}
                  today={today}
                  compact
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
          ) : undefined
        }
      />
    );
  }

  // TRAINING'S THREE STATES IN ONE DAY (§3.2). The state is the composer's reading of
  // one open-episode lifecycle; what each arm says and where its door goes is here.
  // The logged arm carries DURATION AND DISTANCE only (§7.2) — no PR verdict.
  if (content.kind === "training") {
    const state = content.state;
    if (state.kind === "in-progress")
      return (
        <HomeRow
          id={row.id}
          testId="home-training"
          title="Workout in progress"
          detail={`Started ${formatMinutes(workoutPresence.sinceMin)} ago`}
          control={
            <a className="btn-ghost btn-sm" href="/training">
              Continue
            </a>
          }
        />
      );
    if (state.kind === "logged")
      return (
        <HomeRow
          id={row.id}
          testId="home-training"
          title={todaySession?.title ?? "Workout"}
          // DURATION AND DISTANCE ONLY (§7.2). #5110's direct strength scan — the PR
          // row's `getStrengthByExercise` — left Home with the rest of the verdict
          // vocabulary; what the logged state says is what the session recorded.
          detail={
            [
              todaySession?.duration_min == null
                ? null
                : formatMinutes(todaySession.duration_min),
              todaySession?.distance_km == null
                ? null
                : fmtDistance(todaySession.distance_km, distanceUnit),
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          control={
            <a
              className="btn-ghost btn-sm"
              href={
                todaySession == null
                  ? "/training"
                  : trainingActivityPageHref(todaySession.id)
              }
            >
              Open
            </a>
          }
        />
      );
    return (
      <HomeRow
        id={row.id}
        testId="home-training"
        title="Next workout"
        detail={nextWorkoutTitle ?? undefined}
        control={
          <a className="btn-ghost btn-sm" href="/training">
            Start
          </a>
        }
      />
    );
  }

  // "Fast · elapsed · since clock", with End fast. Its START door is #3208's sheet row,
  // not this band: Home states what is running, and the Quicklogger begins things.
  if (content.kind === "fast") {
    const elapsed = openFast ? fastElapsedMs(openFast, nowInstant) : null;
    const start = openFast ? parseUtcSql(openFast.started_at) : null;
    return (
      <HomeRow
        id={row.id}
        testId="home-fast"
        title={`Fast · ${elapsed == null ? "" : formatFastDuration(elapsed)}`}
        detail={
          start
            ? `since ${formatClockMinutes(
                formatPrefs.timeFormat,
                start.getHours() * 60 + start.getMinutes()
              )}`
            : undefined
        }
        control={writable && openFast ? <HomeEndFastButton /> : undefined}
      />
    );
  }

  // THE PERIOD ROW, under the owner's 2026-09-11 amendment to §3.2: a pregnancy
  // silences the two claim-making offers (which `cycleControlState` already encodes in
  // `canStart`/`canReopen`), a postmenopausal suspension silences nothing, and End is
  // never silenced — closing an open period would otherwise strand the row.
  const state = content.state;
  return (
    <HomeRow
      id={row.id}
      testId="home-period"
      title={state.kind === "open" ? `Period · day ${state.day}` : "Period"}
      control={
        writable && cycleControl ? (
          <PeriodOfferButton
            state={cycleControl}
            surface="atom"
            variant="compact"
          />
        ) : undefined
      }
    />
  );
}

// ── THE GLANCE CARD (§3.2), BEHIND THE FIRST BOUNDARY (§6.1) ────────────────────
//
// The existing `getIntradayDay`/`IntradayChart` owner drawn full width of its column,
// with ONE facts line above it and nothing else. Each fact renders only when it exists.
//
// THE DAY-EVENTS READ IS THE LIST'S (§7.3): the events handed in are the rows the record
// band below shows, so a tick can never name something the list does not — and the day
// is read once for both. Only the DRAWING keeps the more-than-one-same-day-HR-point
// gate: no frame with fewer than two points, the facts line stays, and the card is
// omitted when there is neither a frame nor a fact.
async function HomeGlance({
  profileId,
  loginId,
  day,
  dayEvents,
  formatPrefs,
  timezone,
  nowMinutes,
  nowInstant,
  foodLoggingApplicable,
}: {
  profileId: number;
  loginId: number;
  day: string;
  dayEvents: Parameters<typeof getIntradayDay>[2];
  formatPrefs: DisplayFormatPrefs;
  timezone: string;
  nowMinutes: number;
  nowInstant: Date;
  foodLoggingApplicable: boolean;
}) {
  // ITS OWN PRIMED SCOPE. An AsyncLocalStorage scope covers the frame that opened it,
  // never the child Server Components React schedules below it (#5012) — so a streamed
  // section that gathers has to open the cache itself. That is what §6.1's "the
  // request-scoped setting read cache spans every boundary" asks for, and it is why
  // `withPrimedSettings` being ONE call matters: this is its third caller.
  return withPrimedSettings({ loginId, profileIds: [profileId] }, () =>
    renderGlance({
      profileId,
      day,
      dayEvents,
      formatPrefs,
      timezone,
      nowMinutes,
      nowInstant,
      foodLoggingApplicable,
    })
  );
}

function renderGlance({
  profileId,
  day,
  dayEvents,
  formatPrefs,
  timezone,
  nowMinutes,
  nowInstant,
  foodLoggingApplicable,
}: {
  profileId: number;
  day: string;
  dayEvents: Parameters<typeof getIntradayDay>[2];
  formatPrefs: DisplayFormatPrefs;
  timezone: string;
  nowMinutes: number;
  nowInstant: Date;
  foodLoggingApplicable: boolean;
}) {
  // LAST NIGHT. The same summary /sleep and the record's day view read — one decision,
  // three surfaces (#2097) — with the waiting state taking the headline's place when the
  // night has not arrived, the suspect-clock hedge replacing the usual band when the
  // recorded session disagrees with the heart rate across it (#4299), and the naps line
  // after it.
  const sleepSummary = getLastNightSummary(profileId);
  const sleepWaiting = getSleepWaitingState(
    profileId,
    sleepSummary?.wakeDay ?? null
  );
  const sleepPresentation = sleepSummary
    ? sleepRecordPresentation(sleepSummary.wakeDay, day, formatPrefs)
    : null;
  const skewSuspect =
    sleepSummary != null &&
    isSuspectSleepWakeDay(profileId, sleepSummary.wakeDay);
  const usualBand = (() => {
    if (!sleepSummary || skewSuspect) return null;
    const band = formatUsualSleepBand(
      formatPrefs.timeFormat,
      typicalBedTime(profileId),
      typicalWakeTime(profileId)
    );
    return band == null ? null : `Usual ${band}`;
  })();
  const clock = (minutes: number | null | undefined) =>
    minutes == null
      ? null
      : formatClockMinutes(formatPrefs.timeFormat, minutes);
  // "Last night" ONLY when the wake day is today (§3.2); otherwise the
  // tracking-aware waiting statement, which is the state the atom already owns.
  const sleepLine = sleepWaiting
    ? [
        sleepWaiting.headline,
        sleepWaitingDetail(sleepWaiting, {
          clock: (min) => formatClockMinutes(formatPrefs.timeFormat, min),
          when: (iso) => formatRelativeTime(iso),
        }),
      ]
        .filter(Boolean)
        .join(" · ")
    : sleepSummary
      ? [
          sleepSummary.wakeDay === day
            ? "Last night"
            : (sleepPresentation?.label ?? "Last night"),
          formatHm(sleepSummary.durationMin),
          clock(sleepSummary.bedMinutes) && clock(sleepSummary.wakeMinutes)
            ? `${clock(sleepSummary.bedMinutes)}–${clock(sleepSummary.wakeMinutes)}`
            : null,
          skewSuspect ? SLEEP_SKEW_HEDGE : usualBand,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  const naps = getNapHistory(profileId, 1).today;
  const napsLine =
    naps.length === 0
      ? null
      : `Naps · ${formatHm(
          naps.reduce((sum, nap) => sum + nap.durationMin, 0)
        )} · ${naps
          .map((nap) =>
            formatSleepWindow(
              formatPrefs.timeFormat,
              nap.startMinutes,
              nap.endMinutes
            )
          )
          .join(", ")}`;

  // STEPS for the local day, with the prior seven days' average, and the declared target
  // only after `STEPS_AFTERNOON_HOUR` — the summary withholds the comparison until today
  // can be compared (#3258), so the line states the neutral average alone until then.
  const localHour = hourInTz(timezone, nowInstant);
  const stepsRows = getMetricDailyTotals(profileId, "steps");
  const steps =
    stepsRows.length > 0
      ? summarizeStepsToday(stepsRows, day, localHour)
      : null;
  // The declared target joins the line only AFTER `STEPS_AFTERNOON_HOUR` (§3.2), which
  // is the hour the steps domain already decided a day can be judged at — restating a
  // target at 07:00 is a number, not news.
  const stepsTarget =
    localHour >= STEPS_AFTERNOON_HOUR ? getStepsDailyTarget(profileId) : null;
  const stepsLine =
    steps == null || steps.today == null
      ? null
      : [
          `${formatCount(steps.today)} steps`,
          steps.average7 == null
            ? null
            : `prior 7 days ${formatCount(steps.average7)}`,
          stepsTarget == null ? null : `target ${formatCount(stepsTarget)}`,
        ]
          .filter(Boolean)
          .join(" · ");

  // PROTEIN with its resolved goal band and recorded-intake basis, from the parts
  // Telegram reads — the "+" carries the floor in one character (#3257).
  const protein = foodLoggingApplicable ? getProteinToday(profileId) : null;
  const proteinParts = protein ? proteinTodayLineParts(protein) : null;
  const proteinLine = proteinParts
    ? `${proteinParts.amount} · Goal ${proteinParts.band}`
    : null;

  // THE RECORD'S EXISTING DAY FACTS — sunrise, sunset, outdoor minutes, peak UV — read
  // exactly as the record's day view reads them, single-subject only. UV rides on
  // daylight: the dose reader is only asked about a day that HAS outdoor minutes.
  const home = getHomeLocation(profileId);
  const sun = home ? solarDay(home.lat, home.lng, day, timezone) : null;
  const outdoorMinutes = home
    ? (getDaylightOutdoorMinutesByDay(profileId, [day]).get(day) ?? 0)
    : 0;
  const uv =
    home && outdoorMinutes > 0
      ? (getUvDoseForDays(profileId, [day]).get(day) ?? null)
      : null;
  const dayFacts = [
    sun?.sunriseMin != null && sun.sunsetMin != null
      ? `Sun ${clock(sun.sunriseMin)}–${clock(sun.sunsetMin)}`
      : null,
    outdoorMinutes > 0 ? `${outdoorMinutes} min outdoors` : null,
    uv && uv.uvSource === "live" && uv.peakUvIndex != null
      ? `Peak UV ${uv.peakUvIndex}`
      : null,
  ].filter(Boolean);

  const facts = [
    sleepLine,
    napsLine,
    stepsLine,
    proteinLine,
    ...dayFacts,
  ].filter(Boolean) as string[];

  // THE DRAWING'S OWN GATE, unchanged: a day gather always produces a model, and the
  // FRAME needs more than one same-day heart-rate point — one sample is a dot, not a
  // day. The facts line stays either way.
  const model = getIntradayDay(profileId, day, dayEvents);
  const frame = (model.hr?.pointCount ?? 0) > 1 ? model : null;

  // ABSENCE IS SILENT (§2.7): neither a frame nor a fact means no card, not an empty one.
  if (frame == null && facts.length === 0) return null;
  return (
    <div className="card mb-3" data-testid="home-glance">
      {facts.length > 0 ? (
        <p
          className="text-xs text-slate-600 dark:text-slate-300"
          data-testid="home-facts"
        >
          {facts.join(" · ")}
        </p>
      ) : null}
      {frame ? (
        // ONE ZOOM AND ONE CROSSHAIR FOR THE DAY (#4950): the chart renders its day
        // twice — compact and wide, both in the DOM — so the interaction state is
        // lifted here rather than owned by whichever drawing the container earns.
        <IntradayInteractionProvider>
          <IntradayChart
            model={frame}
            formatPrefs={formatPrefs}
            profileId={profileId}
            className="mt-2 w-full"
          />
          {intradayFreshness(frame) ? (
            <p
              className="mt-1 text-xs text-slate-500 dark:text-slate-400"
              data-testid="intraday-freshness"
            >
              {intradayFreshness(frame)}
            </p>
          ) : null}
        </IntradayInteractionProvider>
      ) : null}
    </div>
  );
}

// ── SETUP (§3.4), THE LAST BOUNDARY (§6.1) ──────────────────────────────────────
//
// The #5285 setup rows and the data-quality gap row, through the existing coaching bus
// and its existing dismissal identity, in the record's row grammar, each row opening its
// editor and dismissible. The block is absent when the bus has nothing — there is no
// "you're all set" row.
//
// HOME ASKS ONLY THE BUILDERS WHOSE FINDINGS IT SEATS (§7.1), never the whole coaching
// collection. `COACHING_COLLECTION` is inspectable data for exactly this (#2962): the
// subset is selected by joining on the builder NAME the registry records, so a typo is a
// compile error and there is no parallel list of builder calls to drift.
const HOME_SETUP_BUILDERS = ["buildDataQualityFindings"] as const;

async function HomeSetup({
  profileId,
  loginId,
  day,
  weightUnit,
  formatPrefs,
}: {
  profileId: number;
  loginId: number;
  day: string;
  weightUnit: WeightUnit;
  formatPrefs: DisplayFormatPrefs;
}) {
  return withPrimedSettings({ loginId, profileIds: [profileId] }, () => {
    const findings = COACHING_COLLECTION.filter((entry) =>
      (HOME_SETUP_BUILDERS as readonly string[]).includes(entry.builder)
    ).flatMap((entry) =>
      entry.run({ profileId, today: day, wu: weightUnit, prefs: formatPrefs })
    );
    const rows = composeHomeSetup(
      { scope: "profile", profileId },
      activeFindings(findings, getFindingSuppressions(profileId), day)
    );
    if (rows.length === 0) return null;
    return (
      <section className="mt-4" data-testid="home-setup">
        <h2 className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Setup
        </h2>
        <ul className={LOGGED_EVENT_LIST}>
          {rows.map((row: HomeSetupRow) => (
            <HomeSetupRowView key={row.id} row={row} />
          ))}
        </ul>
      </section>
    );
  });
}

function HomeSetupRowView({ row }: { row: HomeSetupRow }) {
  const finding = row.finding;
  return (
    <HomeRow
      id={row.id}
      testId="home-setup-row"
      title={
        finding.actionHref ? (
          <a className="hover:underline" href={finding.actionHref}>
            {finding.title}
          </a>
        ) : (
          finding.title
        )
      }
      detail={[finding.detail, finding.evidence].filter(Boolean).join(" · ")}
      control={
        <FindingDismissButton
          finding={finding}
          dismissAction={dismissDataQualityGap}
          dismissTestid="finding-dismiss"
        />
      }
    />
  );
}

// AN ATTENTION ROW SAYS WHAT, THEN WHEN (#4076). Outside a fold the item's own detail is
// the content a person came to read — the biomarker retest sentence, "Vitamin D3 · 2000
// IU" — and the due text seconds it. The detail keeps its own testid because the
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
  // `formatPrefs` the due text already uses.
  const detail = itemDetailText(item, today, formatPrefs);
  if (!detail) return due;
  return (
    <>
      <span data-testid="attention-item-detail">{detail}</span>
      {due ? ` · ${due}` : null}
    </>
  );
}
