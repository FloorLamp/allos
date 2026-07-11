import {
  getActivityDates,
  getCardioByActivity,
  getCardioIntensityMix,
  getCardioVolumeByWeek,
  getFrequencyTargetProgress,
  getJournalWeekSummary,
  getRecentDatedExercises,
  getRestEpisode,
  getRestingHrSignal,
  getSleepSignal,
  getStrengthByExercise,
  getVolumeByDate,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { formatRelativeDate } from "@/lib/format-date";
import { formatMinutes } from "@/lib/duration";
import { frequencyScopeLabel } from "@/lib/goals";
import { getUnitPrefs } from "@/lib/settings";
import {
  recentCardioPRs,
  recentPRs,
  recommendCoaching,
  type CardioPR,
} from "@/lib/coaching";
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

  const cardio = getCardioByActivity(profile.id, du);
  const cardioPrs = recentCardioPRs(cardio, todayStr, 30);
  const weekly = getCardioVolumeByWeek(profile.id);
  const mix = getCardioIntensityMix(profile.id);
  const mixTotal = mix.reduce((s, b) => s + b.minutes, 0);

  // One recovery-aware recommendation for the next-workout card, from the shared
  // rule-based engine. A strong recovery signal (poor sleep / elevated resting
  // HR / overtraining) downgrades a "train X" nudge to a rest suggestion.
  const [nextWorkout] = recommendCoaching({
    today: todayStr,
    routine: targets,
    strength,
    cardio,
    trainingDates: getActivityDates(profile.id),
    datedExercises: getRecentDatedExercises(profile.id),
    sleep: getSleepSignal(profile.id),
    restingHr: getRestingHrSignal(profile.id),
    restEpisode: getRestEpisode(profile.id),
    weightUnit: wu,
  });
  // The card offers "log/view" actions for actionable nudges; rest/on-track are
  // informational.
  const nextActionable =
    nextWorkout.kind === "strength" ||
    nextWorkout.kind === "cardio" ||
    nextWorkout.kind === "setup";

  return (
    <section className="space-y-6">
      {/* Observational training-balance findings (issue #45, domain 4) — distinct
          from the next-workout recommendation below. */}
      <TrainingFindings />

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
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    Target
                  </dt>
                  <dd className="mt-0.5 font-semibold text-slate-700 dark:text-slate-200">
                    {nextWorkout.target}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  Reason
                </dt>
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

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            This week
          </h3>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Sessions
              </dt>
              <dd className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {summary.sessions}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Days
              </dt>
              <dd className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {summary.activeDays}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Streak
              </dt>
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
          <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
            Targets that still need work lead the row.
          </p>
          {targets.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400 dark:text-slate-500">
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
                }))}
              />
            </div>
          )}
        </div>
      </div>

      <div className="space-y-6 opacity-85">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Trends and records
          </h3>
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
              <p className="text-sm text-slate-400 dark:text-slate-500">
                No strength sessions logged yet.
              </p>
            ) : (
              <LineChartCard
                data={volume}
                label="Volume"
                unit={` ${wu}`}
                color="#16a34a"
              />
            )}
          </div>

          {weekly.data.length > 0 && (
            <div className="card">
              <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
                Cardio volume
              </h3>
              <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
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
