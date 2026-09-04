import DestinationLink from "@/components/DestinationLink";
import CardSectionHeader from "@/components/CardSectionHeader";
import {
  getActivityDates,
  getActivitySuggestions,
  getCardioByActivity,
  getDayLoadInputs,
  getActiveDaysStrip,
  getFrequencyTargetProgressForHome,
  getIllnessCoachingContext,
  getTrainingWeekDayTypes,
  getRecentDatedExercises,
  getReportedBurden,
  getRestAck,
  getRestEpisode,
  getRestingHrSignal,
  getSleepSignal,
  getStrengthByExercise,
  getStrengthLadder,
  getWorkoutPresence,
  getActivitiesSince,
  getCardioZoneCoverage,
  getSportByActivity,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { formatRelativeDate } from "@/lib/format-date";
import { formatMinutes } from "@/lib/duration";
import {
  frequencyScopeLabel,
  isFrequencyScope,
  isStrengthProgrammingScope,
} from "@/lib/frequency-targets";
import {
  getUnitPrefs,
  getDisplayFormatPrefs,
  getProfileAge,
} from "@/lib/settings";
import {
  isAdultForClinical,
  isStrengthTrainingRelevant,
} from "@/lib/life-stage";
import {
  coverageFromSets,
  coverageList,
  coverageContributions,
} from "@/lib/muscle-coverage";
import {
  contextualNextSet,
  deloadAdjust,
  nextSetText,
  recentCardioPRs,
  recommendCoaching,
  suggestNextSet,
  type CardioPR,
} from "@/lib/coaching";
import { loadingDates } from "@/lib/training-zones";
import { recommendNextWorkout } from "@/lib/workout-recommendation";
import { getActiveRoutine, getRoutineCycleStatus } from "@/lib/routines";
import { availableEquipmentKinds } from "@/lib/equipment";
import { buildRoutineSessionPrefill } from "@/lib/activity-form-model";
import { getInjuries, getInjuryConstraints } from "@/lib/injuries";
import MobilitySection from "./MobilitySection";
import { getConditionConsiderations, getNiggleContext } from "@/lib/queries";
import { getActiveSituations } from "@/lib/settings/profile-attrs";
import {
  isBuiltInInjurySituation,
  sameSituation,
  BUILTIN_POOR_SLEEP_SITUATION,
} from "@/lib/situations";
import { exerciseInjuryVerdict, injuryReviewDue } from "@/lib/injury-model";
import { resolveTrainingTemper } from "@/lib/niggle-model";
import { getEnduranceEvents, getEnduranceArm } from "@/lib/queries";
import {
  disciplineLabel,
  eventKindLabel,
  eventTitle,
  EVENT_KIND_SUGGESTIONS,
} from "@/lib/endurance-plan";
import TodaysSessionCard from "./TodaysSessionCard";
import InjuryBar from "./InjuryBar";
import EndurancePlanBar, { type EndurancePlanView } from "./EndurancePlanBar";
import { PendingTextLink } from "@/components/PendingLink";
import { fmtDistance, fmtKmh } from "@/lib/units";
import PrCard from "@/components/PrCard";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import TrainingFindings from "./TrainingFindings";
import WeekSpine from "./WeekSpine";
import ActiveDaysStrip from "@/components/ActiveDaysStrip";
import { buildWeekSpine } from "@/lib/training-week-spine";
import TrainingContextChips from "./TrainingContextChips";
import FitnessCheckStrip from "./FitnessCheckStrip";
import MuscleCoverageCard from "./MuscleCoverageCard";
import StrengthStandardsLadder from "./StrengthStandardsLadder";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";
import { buildMuscleVolumeFindings } from "@/lib/rule-findings";
import { activeFindings } from "@/lib/findings";
import { getFindingSuppressions } from "@/lib/queries";
import type { StrengthLadderRow } from "@/lib/strength-ladder";
import { shiftDateStr } from "@/lib/date";
import { rankTrainingSuites } from "@/lib/training-suite-rank";
import { sessionOverviewRollup } from "@/lib/session-overview";
import EnduranceDepthSuite from "./EnduranceDepthSuite";
import SportDepthSuite from "./SportDepthSuite";
import TrainingOverviewActions from "./TrainingOverviewActions";

const KIND_LABEL: Record<CardioPR["kind"], string> = {
  distance: "longest",
  speed: "fastest",
  duration: "longest time",
};

// Cardio PRs render top-3 + "show all → Analyze" (#1496). Strength progress lives
// on the standards ladder above, where the current and prior dots explain the gain.
const PR_CAP = 3;

function prValue(p: CardioPR, du: "km" | "mi"): string {
  if (p.kind === "distance") return fmtDistance(p.distanceKm, du);
  if (p.kind === "speed") return fmtKmh(p.speedKmh, du);
  return formatMinutes(p.durationMin);
}

// Training → Overview is the doing surface. Order is deliberate and static:
//   1. Today's session (the daily payload leads)
//   2. This week — the WEEK SPINE (#2566): the seven-day band, captioned by the
//      week's counts and the weekly routine's cadence chips, as ONE card
//   3. Training watch — true coaching exceptions in ONE capped card
//   4. Muscle coverage + mobility
//   5. Injuries / event plans (the descriptive copy renders only when they're live)
//   6. Recent cardio PRs — top 3 + "show all → Analyze"
// Aggregate volume/cadence and intensity-mix charts stay retired here (#3512):
// muscle coverage carries the volume judgment, while HR zones live on Analyze's
// data-gated All training view.
export default async function OverviewSection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const du = units.distanceUnit;
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const todayStr = today(profile.id);
  const profileAge = getProfileAge(profile.id);
  const adultClinicalContent = isAdultForClinical(profileAge);
  const strengthTrainingAvailable = isStrengthTrainingRelevant(profileAge);

  // The week's (day, type) tallies — ONE row set, folded twice (#2566/#221): into the
  // spine's seven day cells, and into the caption's session/active-day counts. The
  // same fold backs `getTrainingLogWeekSummary`, which is what the Training Log and
  // History still read, so no surface can state a different week from this one.
  const weekDays = getTrainingWeekDayTypes(profile.id);
  const spine = buildWeekSpine({
    start: weekDays.start,
    today: todayStr,
    rows: weekDays.rows,
  });
  // The weekly routine, scoped to the targets whose home IS this page (#2888) —
  // strength regions and groups, activity types, and mobility regions. A food habit or
  // a wellness practice is a real target on a real page; that page is not this one.
  const targets = getFrequencyTargetProgressForHome(
    profile.id,
    "training"
  ).filter(
    ({ target }) =>
      strengthTrainingAvailable || !isStrengthProgrammingScope(target)
  );
  const fitnessModel = adultClinicalContent
    ? assembleFitnessCheckModel(profile.id).model
    : null;
  const strength = getStrengthByExercise(profile.id);
  const cardio = getCardioByActivity(profile.id, du, formatPrefs);
  const cardioPrs = recentCardioPRs(cardio, todayStr, 30);

  // (date, exercise) rows over the recent window — one scan reused for the
  // recovery-aware recommendation below AND the weekly muscle-coverage list.
  const datedExercises = getRecentDatedExercises(profile.id);
  // Weekly per-muscle coverage: the SAME attribution (coverageFromSets, #482)
  // that feeds any future SVG heat / volume-band verdict, rendered list-first.
  const coverageDays = 7;
  const coverage = coverageList(
    coverageFromSets(datedExercises, todayStr, coverageDays)
  );
  const coverageEvidence = coverageContributions(
    datedExercises,
    todayStr,
    coverageDays
  );
  const belowTargetCount = activeFindings(
    buildMuscleVolumeFindings(profile.id, todayStr),
    getFindingSuppressions(profile.id),
    todayStr
  ).length;

  // Both ladder dots come from ONE measurement lane, and getStrengthLadder is where
  // that is decided and pinned (#3132). Gated on the adult-clinical floor, like the
  // other population-norm surfaces: the standards tables are adult norms.
  const ladderRows: StrengthLadderRow[] = adultClinicalContent
    ? getStrengthLadder(profile.id, todayStr)
    : [];
  const recentActivities = getActivitiesSince(
    profile.id,
    shiftDateStr(todayStr, -365)
  );
  const suiteRanking = rankTrainingSuites(recentActivities, todayStr).filter(
    ({ suite }) => strengthTrainingAvailable || suite !== "strength"
  );
  const enduranceOverview = sessionOverviewRollup(
    recentActivities
      .filter((activity) => activity.type === "cardio")
      .map((activity) => ({
        id: activity.id,
        title: activity.title,
        date: activity.date,
        durationMin: activity.duration_min,
        distanceKm: activity.distance_km,
        avgSpeedKmh: activity.avg_speed_kmh,
      })),
    todayStr
  );
  const cardioZones = getCardioZoneCoverage(
    profile.id,
    weekDays.start,
    weekDays.end
  );
  const vo2Percentile =
    fitnessModel?.results.find((result) => result.key === "vo2max")
      ?.percentile ?? null;
  const sports = getSportByActivity(
    profile.id,
    getDisplayFormatPrefs(login.id)
  );
  const sportCadence = targets
    .filter((target) => isFrequencyScope(target.target, "type", "sport"))
    .map((target) => ({
      id: target.target.id,
      label: frequencyScopeLabel(
        target.target.scope_kind,
        target.target.scope_value
      ),
      count: target.count,
      perWeek: target.per_week,
    }));

  // ONE coaching input, shared by the recovery-aware next-workout card engine and
  // the routine-session resolver, so both read the same computation (#221). A
  // strong recovery signal (poor sleep / elevated resting HR / overtraining)
  // downgrades a "train X" nudge to a rest suggestion; threading the active routine
  // + equipment availability lets today's routine day resolve.
  const coachingInput = {
    today: todayStr,
    routine: targets,
    strength,
    cardio,
    trainingDates: getActivityDates(profile.id),
    // Load-aware date set (#754): only hard sessions extend the overtraining/load
    // rest triggers, so a synced easy recovery day doesn't fire "rest or light day"
    // on the light day itself.
    loadingDates: loadingDates(getDayLoadInputs(profile.id)),
    datedExercises,
    availableEquipment: availableEquipmentKinds(profile.id),
    activeRoutine: getActiveRoutine(profile.id),
    // The mesocycle deload flag (#741), resolved once by the ONE gather and threaded
    // through so this card, the recovery-aware next-workout engine, and (elsewhere)
    // the Telegram nudge all read the same "is it a deload week."
    deloadWeek:
      getRoutineCycleStatus(profile.id, todayStr)?.isDeloadWeek ?? false,
    sleep: getSleepSignal(profile.id),
    // Declared Poor sleep tilts the rest rec on the unified verdict (#1292) — the SAME
    // signal the dashboard/Telegram surfaces read, so this card agrees (#221).
    poorSleepDeclared: getActiveSituations(profile.id).some((s) =>
      sameSituation(s, BUILTIN_POOR_SLEEP_SITUATION)
    ),
    // Today's reported burden (#1300): the SAME shared verdict the dashboard/Telegram read,
    // so this card tilts toward an easier session in lockstep (#221).
    reportedBurden: getReportedBurden(profile.id, todayStr),
    restingHr: getRestingHrSignal(profile.id),
    restEpisode: getRestEpisode(profile.id),
    // "Training anyway" acknowledgment (#1150): the SAME per-day marker the dashboard
    // card + Telegram read, so this overview card transforms into calm training guidance
    // in lockstep (one computation, #221).
    restAck: getRestAck(profile.id, todayStr),
    // Situation-aware hold (#837): the SAME illness context gatherCoachingInput reads,
    // so this overview card holds the gap nags during an open episode exactly like the
    // dashboard coaching atom — never a second, drifting derivation (#221).
    illness: getIllnessCoachingContext(profile.id, todayStr),
    // Rest-card tense (#921): soften "rest today" to next-session framing while a
    // session is live, matching the dashboard/Telegram surfaces (one computation).
    workoutActive: getWorkoutPresence(profile.id).state === "active",
    // Injury constraints (#838) + condition considerations (#666): the SAME gather the
    // dashboard/Telegram surfaces use, so the exclusion/tempering/notes here agree (#221).
    injuries: getInjuryConstraints(profile.id),
    // Live niggles (#3211 part 3) — the SAME gather gatherCoachingInput reads, so this
    // overview tempers and discloses the niggle exactly like the dashboard widget and the
    // Telegram nudge rather than being the one surface that ignores it (#221).
    niggles: getNiggleContext(profile.id),
    considerations: getConditionConsiderations(profile.id),
    // Plan-aware cardio arm (#839): the SAME arm the dashboard/Telegram surfaces read, with
    // the illness pause applied — so the note here agrees everywhere (#221).
    endurancePlanArm: getEnduranceArm(
      profile.id,
      todayStr,
      getIllnessCoachingContext(profile.id, todayStr).openEpisode
    ),
    weightUnit: wu,
  };
  const [nextWorkout] = recommendCoaching(coachingInput);
  // Today's resolved routine session (#740), when an active routine exists — the
  // authoritative recommendation. Rendered as its own card in place of the generic
  // next-workout card, with a per-slot prescription + load target and a "Log this
  // session" hand-off to live mode.
  const nw = recommendNextWorkout(coachingInput);
  const session = nw.session;

  // The injury bar's rows (#838) + the suggest-only Injury-situation bridge state.
  const injuries = getInjuries(profile.id).map((i) => ({
    id: i.id,
    label: i.label,
    regions: i.regions,
    // Carried so an in-place scope correction (#2297) round-trips the finer muscle list
    // the form has no control for, instead of clearing it.
    muscles: i.muscles,
    status: i.status,
    since: i.since,
    notes: i.notes,
    // #2024 — the declared precision, so the chip shows the constraint the user actually
    // wrote instead of only its fallback region. `reviewDue` is a SUGGEST-only prompt:
    // reaching the date changes nothing until the user taps.
    laterality: i.laterality,
    movements: i.movements,
    exercises: i.exercises,
    loadFactor: i.loadFactor,
    reviewDate: i.reviewDate,
    reviewDue: i.status !== "resolved" && injuryReviewDue(i, todayStr),
  }));
  const hasInjurySituation = getActiveSituations(profile.id).some(
    isBuiltInInjurySituation
  );
  // The injury form's exercise picker (#2199) reads the SAME frequency-ranked lift list
  // the activity form, GoalForm and the routine builder consume (#1676) — catalog base
  // names plus this profile's own custom lifts, most-trained first — rather than a
  // second, catalog-ordered vocabulary. cache()d per request, so this is free here.
  const liftOptions = strengthTrainingAvailable
    ? getActivitySuggestions(profile.id).lifts
    : [];

  // Events (#839, generalized by #3285): every ACTIVE upcoming event, with its
  // recomputed this-week trajectory where the cardio pair makes one derivable —
  // shaped into the display view (distances formatted server-side in the login's
  // unit). An event with no discipline (a lifting meet, a tournament) renders the
  // same card without the trajectory block, which is why the view's trajectory half
  // is optional rather than the card being a second component.
  const endurancePlans: EndurancePlanView[] = getEnduranceEvents(
    profile.id,
    todayStr
  ).map(({ plan, card, weeksToEvent }) => ({
    id: plan.id,
    title: eventTitle(plan),
    badge: plan.discipline
      ? disciplineLabel(plan.discipline)
      : eventKindLabel(plan.kind),
    eventDate: formatRelativeDate(plan.eventDate, todayStr),
    weeksToEvent,
    trajectory: card && {
      weeksToEvent: card.trajectory.weeksToEvent,
      feasible: card.trajectory.feasible,
      message: card.trajectory.message,
      targetVolume: fmtDistance(card.thisWeek.targetVolumeKm, du),
      actualVolume: fmtDistance(card.actualVolumeKm, du),
      progressPct: Math.max(
        0,
        Math.min(
          100,
          card.thisWeek.targetVolumeKm > 0
            ? Math.round(
                (card.actualVolumeKm / card.thisWeek.targetVolumeKm) * 100
              )
            : 0
        )
      ),
      longSession: fmtDistance(card.thisWeek.longSessionKm, du),
      longSessionDone: card.longSessionDone,
      hasLongSession: card.thisWeek.longSessionKm > 0,
    },
    notes: plan.notes,
  }));
  const sessionCard = session
    ? {
        label:
          session.kind === "cardio" ? session.label : `${session.label} day`,
        focus: session.focus as string[],
        prefill: buildRoutineSessionPrefill(session, todayStr),
        deloadWeek: session.deloadWeek,
        slots: session.slots
          .filter((s) => s.exercise)
          .map((s) => {
            const base = s.seed ? suggestNextSet(s.seed, wu) : null;
            // The slot's LOAD target runs through the ONE shared contextualNextSet
            // (#1115 Fix B): deload week (#741) AND recovering-injury temper (#838) —
            // this closes the today's-session card's injury-temper gap (#923 closed it
            // for deload, left it open for injury). The SET COUNT still reduces on a
            // deload week via the same deloadAdjust math (shared, #741).
            // #2024: the injury axis resolves through the SHARED per-exercise verdict,
            // so an exercise- or movement-scoped constraint tempers exactly this lift and
            // a user-declared load preference beats the app's fallback fraction.
            const slotInjury = exerciseInjuryVerdict(
              nw.injuryConstraints,
              s.exercise
            );
            // #3211 part 3: the live-niggle tier folds in through the SAME shared
            // resolver the coaching card uses, so this card cannot seed an un-tempered
            // load while the card beside it names the niggle as the reason it eased off.
            const slotTemper = resolveTrainingTemper(
              slotInjury,
              nw.niggleTempers,
              s.exercise
            );
            const nextSet = contextualNextSet(base, s.exercise, {
              deloadWeek: session.deloadWeek,
              recoveringRegion: slotTemper.recoveringRegion,
              recoveringFactor: slotTemper.factor,
              temperRationale: slotTemper.rationale,
            });
            const sets = session.deloadWeek
              ? deloadAdjust({
                  exercise: s.exercise,
                  sets: s.sets,
                  nextSet: null,
                }).sets
              : s.sets;
            const reps =
              s.repMin === s.repMax ? `${s.repMax}` : `${s.repMin}–${s.repMax}`;
            return {
              exercise: s.exercise,
              prescription: `${sets} × ${reps}`,
              target: nextSet ? nextSetText(nextSet, wu) : null,
            };
          }),
      }
    : null;
  // Show the routine "Today's session" card as the primary recommendation — EXCEPT
  // when a recovery signal has overridden the top rec to rest (rest still wraps the
  // result, per the spec). The generic "Next workout" card then carries the rest /
  // on-track / no-routine states, so the two never duplicate.
  const showSessionCard = sessionCard != null && nextWorkout.kind !== "rest";

  return (
    <section className="space-y-6">
      {/* 1. TODAY'S SESSION — the doing surface leads with the daily payload
          (#1496/#1490). Either the resolved routine session (#740) or the generic
          next-workout card, plus the injury/condition context riding alongside it;
          exactly one of the two cards renders, so they never duplicate. */}
      <div className="space-y-6" data-testid="training-today">
        {!strengthTrainingAvailable && (
          <div className="card" data-testid="age-appropriate-activity-card">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                  Activity
                </h3>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Log play, walks, sports, mobility, and other everyday
                  movement.
                </p>
              </div>
              <TrainingOverviewActions />
            </div>
          </div>
        )}

        {strengthTrainingAvailable && showSessionCard && sessionCard && (
          <TodaysSessionCard
            label={sessionCard.label}
            focus={sessionCard.focus}
            slots={sessionCard.slots}
            prefill={sessionCard.prefill}
            deloadWeek={sessionCard.deloadWeek}
            context={<TrainingContextChips context={nw} />}
          />
        )}

        {strengthTrainingAvailable && !showSessionCard && (
          <div className="card" data-testid="next-workout-card">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                  Next workout
                </h3>
                <p
                  className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100"
                  data-testid="next-workout-title"
                >
                  {nextWorkout.title}
                </p>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  {nextWorkout.target && (
                    <div>
                      <dt className="section-label">Target</dt>
                      <dd className="mt-0.5 font-semibold text-slate-700 dark:text-slate-200">
                        {nextWorkout.target}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="section-label">Reason</dt>
                    <dd className="mt-0.5 text-slate-500 dark:text-slate-400">
                      {nextWorkout.detail}
                    </dd>
                  </div>
                </dl>
              </div>
              {/* The card's action rail (#3473). "View details" goes THROUGH
                  TrainingOverviewActions rather than beside it: below `md` it
                  shares a line with "Log activity", and two controls only share
                  a line if they share a flex container. `stacked` keeps the
                  `md`+ rail — a right-aligned column — exactly as it was. */}
              <TrainingOverviewActions
                stacked
                secondary={
                  nextWorkout.actionHref ? (
                    <PendingTextLink
                      href={nextWorkout.actionHref}
                      label="workout details"
                      testId="next-workout-details"
                      className="btn-ghost"
                    >
                      View details
                    </PendingTextLink>
                  ) : null
                }
              />
            </div>
            <TrainingContextChips context={nw} />
          </div>
        )}
      </div>

      {/* 2. THIS WEEK — the WEEK SPINE (#2566, Viz 1). One band, seven days on the
          profile's own week window, logged sessions stacked as type-colored blocks,
          today ringed. It replaces the two-number tile ("Sessions 4 · Days 3" — a
          tally with no shape) and COMPOSES with the routine, which used to be a
          separate card in a separate vocabulary: the cadence ledger's own chips are
          this band's caption now, so which days / what kind / what the routine still
          wants are one read instead of three.

          Nothing here recomputes anything. The band's day cells and the caption's
          counts fold the SAME (day, type) rows (getTrainingWeekDayTypes → both
          buildWeekSpine and getTrainingLogWeekSummary, #221), and the chips are the
          unchanged cadence rollup, narrowed to the scopes whose declared home is this
          page (#2888) — same counts, same pace, fewer rows. No score, no verdict: an
          empty day is empty, a day after today is "ahead", and neither is a miss. */}
      <div className="card" data-testid="training-week">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          This week
        </h3>
        <WeekSpine spine={spine} />

        {/* THE ACTIVE-DAYS BAND, HOME AT LAST (#4079's anti-drop census). It used to
            head the Log tab, where it answered "how often lately" beside a feed that
            answers "what, exactly" — two questions, one surface. It belongs to the
            week card, next to the spine it extends: the spine is this week, the band
            is the run-up to it, and both read the same activity days. */}
        <div className="mt-4">
          <ActiveDaysStrip data={getActiveDaysStrip(profile.id, 21)} />
        </div>

        <div className="mt-5 border-t border-black/10 pt-4 dark:border-white/10">
          <CardSectionHeader title="Weekly targets" variant="label">
            {/* The chips RENDER here and are EDITED in Plan (#2892) — one home. */}
            <DestinationLink
              href="/training?tab=plan#targets"
              className="text-xs text-link"
            >
              Edit targets
            </DestinationLink>
          </CardSectionHeader>
          {targets.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              No weekly targets set yet.
            </p>
          ) : (
            <>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Targets that still need work lead the row.
              </p>
              <div className="mt-3">
                <WeeklyTargets
                  targets={targets.map((t) => ({
                    id: t.target.id,
                    label: frequencyScopeLabel(
                      t.target.scope_kind,
                      t.target.scope_value
                    ),
                    count: t.count,
                    perWeek: t.per_week,
                    met: t.met,
                    pace: t.pace,
                  }))}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {fitnessModel && <FitnessCheckStrip model={fitnessModel} />}

      {/* 3. TRAINING WATCH — true observational exceptions (issue #45, domain 4)
          in one capped card, distinct from the recommendation and coverage above. */}
      {strengthTrainingAvailable && <TrainingFindings />}

      {!strengthTrainingAvailable && (
        <MobilitySection profileId={profile.id} today={todayStr} />
      )}

      {/* The three depth suites never hide. Their order follows the profile's
          recency-weighted observed mix; an empty domain collapses to its log door. */}
      {suiteRanking.map(({ suite, share }) => (
        <div
          key={suite}
          className="space-y-6"
          data-testid={`training-depth-suite-${suite}`}
          data-share={share.toFixed(3)}
        >
          {suite === "strength" ? (
            <>
              <MuscleCoverageCard
                coverage={coverage}
                contributions={coverageEvidence}
                days={coverageDays}
                belowTargetCount={belowTargetCount}
              />
              {/* Mobility remains a separate question and view (#482). */}
              <MobilitySection profileId={profile.id} today={todayStr} />
              {adultClinicalContent && (
                <StrengthStandardsLadder rows={ladderRows} weightUnit={wu} />
              )}
            </>
          ) : suite === "endurance" ? (
            <EnduranceDepthSuite
              zones={cardioZones}
              form={enduranceOverview}
              vo2={vo2Percentile}
              distanceUnit={du}
              adultClinicalContent={adultClinicalContent}
            />
          ) : (
            <SportDepthSuite cadence={sportCadence} sports={sports} />
          )}
        </div>
      ))}

      {/* 5. INJURIES / EVENT PLANS — conditional cards (#1496): they carry their
          full descriptive block only when something is live. With none logged each
          collapses to its one-line "＋ log" affordance, which STAYS (it is the only
          door to logging the first injury/plan) rather than vanishing entirely. */}
      {strengthTrainingAvailable && (
        <InjuryBar
          injuries={injuries}
          liftOptions={liftOptions}
          suggestActivateSituation={!hasInjurySituation}
        />
      )}

      <EndurancePlanBar
        plans={endurancePlans}
        distanceUnit={du}
        kindSuggestions={EVENT_KIND_SUGGESTIONS}
      />

      {/* 6. RECENT CARDIO PRs — strength progress is already visible in the
          standards ladder; this remains the cardio hand-off to Analyze. */}
      {cardioPrs.length > 0 && (
        <div>
          <PrCard
            title="Recent cardio PRs"
            testId="overview-cardio-prs"
            items={cardioPrs.slice(0, PR_CAP).map((p) => ({
              name: p.activity,
              value: prValue(p, du),
              meta: `${KIND_LABEL[p.kind]} - ${formatRelativeDate(p.date, todayStr)}`,
            }))}
            action={
              cardioPrs.length > PR_CAP ? (
                <DestinationLink
                  href="/training?tab=analyze"
                  data-testid="overview-cardio-prs-all"
                  className="shrink-0 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
                >
                  Show all {cardioPrs.length}
                </DestinationLink>
              ) : undefined
            }
          />
        </div>
      )}
    </section>
  );
}
