import {
  getActivityDates,
  getCardioByActivity,
  getCardioIntensityMix,
  getCardioVolumeByWeek,
  getDayLoadInputs,
  getFrequencyTargetProgress,
  getIllnessCoachingContext,
  getJournalWeekSummary,
  getRecentDatedExercises,
  getRestEpisode,
  getRestingHrSignal,
  getSleepSignal,
  getStrengthByExercise,
  getVolumeByDate,
  getWorkoutPresence,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { chartSeries } from "@/lib/chart-colors";
import { formatRelativeDate } from "@/lib/format-date";
import { formatMinutes } from "@/lib/duration";
import { frequencyScopeLabel } from "@/lib/goals";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import {
  coverageFromSets,
  coverageList,
  SECONDARY_CREDIT,
} from "@/lib/muscle-coverage";
import { bandVerdict, bandPresentation } from "@/lib/muscle-volume-bands";
import {
  deloadAdjust,
  nextSetText,
  recentCardioPRs,
  recentPRs,
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
import { getConditionConsiderations } from "@/lib/queries";
import { getActiveSituations } from "@/lib/settings/profile-attrs";
import { isBuiltInInjurySituation } from "@/lib/situations";
import { excludedRegionLabel } from "@/lib/injury-model";
import { getEndurancePlanCards, getEnduranceArm } from "@/lib/queries";
import TodaysSessionCard from "./TodaysSessionCard";
import InjuryBar from "./InjuryBar";
import EndurancePlanBar, { type EndurancePlanView } from "./EndurancePlanBar";
import MuscleAnatomy from "@/components/MuscleAnatomy";
import { dispWeight, fmtDistance, fmtKmh, fmtWeight } from "@/lib/units";
import LineChartCard from "@/components/LineChartCard";
import LogActivityButton from "@/components/LogActivityButton";
import PrCard from "@/components/PrCard";
import StackedBarCard from "@/components/StackedBarCard";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import TrainingFindings from "./TrainingFindings";

const KIND_LABEL: Record<CardioPR["kind"], string> = {
  distance: "longest",
  speed: "fastest",
  duration: "longest time",
};

const INTENSITY_COLOR: Record<string, string> = {
  Easy: "bg-emerald-500",
  Moderate: "bg-amber-500",
  Hard: "bg-rose-500",
  Unspecified: "bg-slate-400",
};

// Set credit is fractional (secondary muscles count 0.5), so render whole
// numbers plainly and half-credit with one decimal.
function fmtSets(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function prValue(p: CardioPR, du: "km" | "mi"): string {
  if (p.kind === "distance") return fmtDistance(p.distanceKm, du);
  if (p.kind === "speed") return fmtKmh(p.speedKmh, du);
  return formatMinutes(p.durationMin);
}

export default async function OverviewSection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const du = units.distanceUnit;
  const todayStr = today(profile.id);

  const summary = getJournalWeekSummary(profile.id);
  const targets = getFrequencyTargetProgress(profile.id);
  const strength = getStrengthByExercise(profile.id);
  const strengthPrs = recentPRs(strength, todayStr, 30);
  const volume = getVolumeByDate(profile.id).map((v) => ({
    date: v.date,
    value: dispWeight(v.volume, wu, 0),
  }));

  const cardio = getCardioByActivity(
    profile.id,
    du,
    getDisplayFormatPrefs(login.id)
  );
  const cardioPrs = recentCardioPRs(cardio, todayStr, 30);
  const weekly = getCardioVolumeByWeek(profile.id);
  const mix = getCardioIntensityMix(profile.id);
  const mixTotal = mix.reduce((s, b) => s + b.minutes, 0);

  // (date, exercise) rows over the recent window — one scan reused for the
  // recovery-aware recommendation below AND the weekly muscle-coverage list.
  const datedExercises = getRecentDatedExercises(profile.id);
  // Weekly per-muscle coverage: the SAME attribution (coverageFromSets, #482)
  // that feeds any future SVG heat / volume-band verdict, rendered list-first.
  const coverageDays = 7;
  const coverage = coverageList(
    coverageFromSets(datedExercises, todayStr, coverageDays)
  );
  const coverageMax = coverage.reduce((m, r) => Math.max(m, r.sets), 0);

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
    restingHr: getRestingHrSignal(profile.id),
    restEpisode: getRestEpisode(profile.id),
    // Situation-aware hold (#837): the SAME illness context gatherCoachingInput reads,
    // so this overview card holds the gap nags during an open episode exactly like the
    // dashboard coaching widget — never a second, drifting derivation (#221).
    illness: getIllnessCoachingContext(profile.id, todayStr),
    // Rest-card tense (#921): soften "rest today" to next-session framing while a
    // session is live, matching the dashboard/Telegram surfaces (one computation).
    workoutActive: getWorkoutPresence(profile.id).state === "active",
    // Injury constraints (#838) + condition considerations (#666): the SAME gather the
    // dashboard/Telegram surfaces use, so the exclusion/tempering/notes here agree (#221).
    injuries: getInjuryConstraints(profile.id),
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
    status: i.status,
    since: i.since,
    notes: i.notes,
  }));
  const hasInjurySituation = getActiveSituations(profile.id).some(
    isBuiltInInjurySituation
  );

  // Endurance event plans (#839): the active plans' recomputed this-week trajectory,
  // shaped into the display view (distances formatted server-side in the login's unit).
  const endurancePlans: EndurancePlanView[] = getEndurancePlanCards(
    profile.id,
    todayStr
  ).map((c) => {
    const t = c.trajectory;
    return {
      id: c.plan.id,
      title:
        c.plan.eventName?.trim() ||
        `${fmtDistance(c.plan.targetDistanceKm, du)} ${c.plan.discipline}`,
      disciplineLabel:
        c.plan.discipline === "run"
          ? "Run"
          : c.plan.discipline === "ride"
            ? "Ride"
            : "Swim",
      eventDate: formatRelativeDate(c.plan.eventDate, todayStr),
      weeksToEvent: t.weeksToEvent,
      feasible: t.feasible,
      message: t.message,
      targetVolume: fmtDistance(c.thisWeek.targetVolumeKm, du),
      actualVolume: fmtDistance(c.actualVolumeKm, du),
      progressPct: Math.max(
        0,
        Math.min(
          100,
          c.thisWeek.targetVolumeKm > 0
            ? Math.round((c.actualVolumeKm / c.thisWeek.targetVolumeKm) * 100)
            : 0
        )
      ),
      longSession: fmtDistance(c.thisWeek.longSessionKm, du),
      longSessionDone: c.longSessionDone,
      hasLongSession: c.thisWeek.longSessionKm > 0,
      notes: c.plan.notes,
    };
  });
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
            // On a deload week run the slot's sets + load target through the ONE
            // shared deloadAdjust (#741) so this card and the recommendation copy
            // can't disagree; otherwise the ordinary prescription.
            const { sets, nextSet } = session.deloadWeek
              ? deloadAdjust({
                  exercise: s.exercise,
                  sets: s.sets,
                  nextSet: base,
                })
              : { sets: s.sets, nextSet: base };
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
  // The card offers "log/view" actions for actionable nudges; rest/on-track are
  // informational.
  const nextActionable =
    nextWorkout.kind === "strength" ||
    nextWorkout.kind === "cardio" ||
    nextWorkout.kind === "setup";
  // Show the routine "Today's session" card as the primary recommendation — EXCEPT
  // when a recovery signal has overridden the top rec to rest (rest still wraps the
  // result, per the spec). The generic "Next workout" card then carries the rest /
  // on-track / no-routine states, so the two never duplicate.
  const showSessionCard = sessionCard != null && nextWorkout.kind !== "rest";

  return (
    <section className="space-y-6">
      {/* Observational training-balance findings (issue #45, domain 4) — distinct
          from the next-workout recommendation below. */}
      <TrainingFindings />

      {/* User-declared injury constraints (#838): log/edit/resolve, and the engine trains
          around active regions (disclosed on the recommendation below). */}
      <InjuryBar
        injuries={injuries}
        suggestActivateSituation={!hasInjurySituation}
      />

      {/* Endurance event plans (#839): a race goal → a safe weekly volume trajectory
          (ramp/long-session/recovery/taper). The plan-aware cardio arm rides the
          recommendation below; the long session surfaces as a calm coaching finding. */}
      <EndurancePlanBar plans={endurancePlans} distanceUnit={du} />

      {showSessionCard && sessionCard && (
        <TodaysSessionCard
          label={sessionCard.label}
          focus={sessionCard.focus}
          slots={sessionCard.slots}
          prefill={sessionCard.prefill}
          deloadWeek={sessionCard.deloadWeek}
        />
      )}

      {/* Injury exclusion disclosure (#838) + condition considerations (#666) — the calm
          context riding ALONGSIDE the (unchanged) recommendation. NEVER silent: the excluded
          regions are named so the user sees WHY a region is set aside. */}
      {(nw.excludedRegions.length > 0 ||
        nw.temperedRegions.length > 0 ||
        nw.considerations.length > 0 ||
        nw.substitutionSuggested) && (
        <div
          className="card border-l-4 border-l-amber-400 bg-amber-50/40 dark:bg-amber-500/5"
          data-testid="training-context-notes"
        >
          {nw.substitutionSuggested && (
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
              Today&apos;s routine day works only injured regions — consider a
              substitution day rather than pushing through.
            </p>
          )}
          {nw.excludedRegions.length > 0 && (
            <p
              className="text-sm text-slate-700 dark:text-slate-200"
              data-testid="injury-exclusion-note"
            >
              Avoiding{" "}
              {nw.excludedRegions.map((d) => excludedRegionLabel(d)).join(", ")}
              .
            </p>
          )}
          {nw.temperedRegions.length > 0 && (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Easing back on {nw.temperedRegions.join(", ")} — lighter targets
              while you recover.
            </p>
          )}
          {nw.considerations.map((c) => (
            <p
              key={c.key}
              className="mt-1 text-sm text-slate-600 dark:text-slate-300"
              data-testid="condition-consideration-note"
            >
              {c.note}
            </p>
          ))}
        </div>
      )}

      {!showSessionCard && (
        <div className="card">
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
            {nextActionable && (
              <div className="flex flex-wrap gap-2">
                {nextWorkout.actionHref && (
                  <a href={nextWorkout.actionHref} className="btn-ghost">
                    View details
                  </a>
                )}
                <LogActivityButton className="btn">
                  Log activity
                </LogActivityButton>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            This week
          </h3>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <dt className="section-label">Sessions</dt>
              <dd className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {summary.sessions}
              </dd>
            </div>
            <div>
              <dt className="section-label">Days</dt>
              <dd className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {summary.activeDays}
              </dd>
            </div>
            <div>
              <dt className="section-label">Streak</dt>
              <dd className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {summary.streak}
              </dd>
            </div>
          </dl>
        </div>

        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Weekly routine
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Targets that still need work lead the row.
          </p>
          {targets.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
              No weekly routine set yet.
            </p>
          ) : (
            <div className="mt-4">
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
          )}
        </div>
      </div>

      <div className="card" data-testid="muscle-coverage">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Muscle coverage
        </h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Sets per muscle over the last {coverageDays} days. Primary movers
          count 1, assisting muscles count {SECONDARY_CREDIT}. The chip shows
          each muscle against its weekly volume band.
        </p>
        {coverage.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            No strength sets logged in the last {coverageDays} days.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-6 sm:flex-row sm:items-start">
            {/* The accessible per-muscle list stays permanent (#736 list-first);
                the anatomy figure (#737) renders ALONGSIDE it, never replacing
                it. */}
            <ul className="flex-1 space-y-2">
              {coverage.map((row) => {
                // ONE verdict (#221): the shared bandVerdict + palette the
                // finding engine AND the SVG figure (#737) below also read — no
                // second computation, so chip, tint, and observation cannot
                // drift.
                const pres = bandPresentation(
                  bandVerdict(row.muscle, row.sets)
                );
                return (
                  <li
                    key={row.muscle}
                    data-testid="muscle-coverage-row"
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="w-28 shrink-0 text-slate-600 dark:text-slate-300">
                      {row.label}
                    </span>
                    <span
                      className="h-2.5 min-w-[0.375rem] rounded-full bg-emerald-500/80"
                      style={{
                        width: `${coverageMax > 0 ? (row.sets / coverageMax) * 100 : 0}%`,
                      }}
                      aria-hidden="true"
                    />
                    <span
                      data-testid="muscle-coverage-verdict"
                      data-verdict={pres.verdict}
                      className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${pres.badgeClass}`}
                    >
                      {pres.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                      {fmtSets(row.sets)} {row.sets === 1 ? "set" : "sets"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {/* Heat per muscle from the SAME coverageFromSets result the list
                renders (#221/#482). Each muscle is tinted by the SHARED #742
                band verdict (bandPresentation(bandVerdict(...)).color), so the
                figure and the list chips read the same palette — the coordinated
                outcome #737 designed the per-entry `color` prop for. The
                component's own intensity ramp stays the fallback for any entry
                left without a color. */}
            <MuscleAnatomy
              mode="coverage"
              coverage={coverage.map((row) => ({
                muscle: row.muscle,
                sets: row.sets,
                color: bandPresentation(bandVerdict(row.muscle, row.sets))
                  .color,
              }))}
              className="mx-auto w-full max-w-[14rem] shrink-0 sm:mx-0 sm:w-52"
            />
          </div>
        )}
      </div>

      {/* Mobility (#840): self-contained tap-the-moves log + region-coverage strip,
          a SEPARATE view next to muscle coverage (never merged — #482). */}
      <MobilitySection profileId={profile.id} today={todayStr} />

      <div className="space-y-6 opacity-85">
        <div>
          <h3 className="section-label">Trends and records</h3>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {strengthPrs.length > 0 && (
            <PrCard
              title="Recent strength PRs"
              items={strengthPrs.map((p) => ({
                name: p.exercise,
                value:
                  p.kind === "1rm"
                    ? p.bodyweight
                      ? `BW x ${p.reps}`
                      : `${fmtWeight(p.weightKg, wu)} x ${p.reps}`
                    : `${fmtWeight(p.weightKg, wu)} top`,
                meta: formatRelativeDate(p.date, todayStr),
              }))}
            />
          )}

          {cardioPrs.length > 0 && (
            <PrCard
              title="Recent cardio PRs"
              items={cardioPrs.map((p) => ({
                name: p.activity,
                value: prValue(p, du),
                meta: `${KIND_LABEL[p.kind]} - ${formatRelativeDate(p.date, todayStr)}`,
              }))}
            />
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card">
            <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Strength volume
            </h3>
            {volume.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No strength sessions logged yet.
              </p>
            ) : (
              <LineChartCard
                data={volume}
                label="Volume"
                unit={` ${wu}`}
                color={chartSeries.brand}
              />
            )}
          </div>

          {weekly.data.length > 0 && (
            <div className="card">
              <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
                Cardio volume
              </h3>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                Minutes per week, by activity
              </p>
              <StackedBarCard
                data={weekly.data}
                series={weekly.series}
                unit=" min"
                labelPrefix="Week of "
              />
            </div>
          )}
        </div>

        {mixTotal > 0 && (
          <div className="card">
            <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Cardio intensity mix
            </h3>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800">
              {mix.map((b) => (
                <div
                  key={b.intensity}
                  className={INTENSITY_COLOR[b.intensity] ?? "bg-slate-400"}
                  style={{ width: `${(b.minutes / mixTotal) * 100}%` }}
                  title={`${b.intensity}: ${formatMinutes(b.minutes)}`}
                />
              ))}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              {mix.map((b) => (
                <li key={b.intensity} className="flex items-center gap-1.5">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${INTENSITY_COLOR[b.intensity] ?? "bg-slate-400"}`}
                  />
                  {b.intensity} - {formatMinutes(b.minutes)} - {b.sessions}x
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
