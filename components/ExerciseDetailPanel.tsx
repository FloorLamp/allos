"use client";

import type { ReactNode } from "react";
import type { UnitPrefs } from "@/lib/settings";
import type { ExerciseStat, GoalProgress } from "@/lib/queries";
import type { Goal, Sex } from "@/lib/types";
import { dispWeight, fmtWeight } from "@/lib/units";
import { liftInfo } from "@/lib/lifts";
import {
  strengthStanding,
  strengthLevelLabel,
  strengthLevelColor,
  strengthStandingPhrase,
  bodyweightMultiple,
} from "@/lib/strength-standards";
import { goalsForExercise, goalTargetText } from "@/lib/goals";
import { formatLongDate, formatRelativeDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import { suggestNextSet, lastSessionPR, nextSetText } from "@/lib/coaching";
import LineChartCard from "@/components/LineChartCard";
import { chartSeries } from "@/lib/chart-colors";
import LevelBadge from "@/components/LevelBadge";
import { StatBox } from "@/components/StatBox";
import ExerciseGuideSection from "@/components/ExerciseGuideSection";

const PR_CHIP = (
  <span
    className="badge cursor-help bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
    title="New personal record set in your latest session"
  >
    PR
  </span>
);

// Est. 1RM, with a × bodyweight multiple appended when bodyweight is known —
// "88 lb (0.49× BW)" for weighted lifts, or just "1.30× BW" for bodyweight lifts
// (whose absolute 1RM isn't meaningful). Falls back gracefully without a bodyweight.
export function e1rmText(
  e: ExerciseStat,
  wu: UnitPrefs["weightUnit"],
  bodyweightKg: number | null
): string {
  const mult = bodyweightMultiple(e.e1rmKg, bodyweightKg);
  if (e.bodyweight) return mult ? `${mult.toFixed(2)}× BW` : "BW";
  const base = `${dispWeight(e.e1rmKg, wu, 0)} ${wu}`;
  return mult ? `${base} (${mult.toFixed(2)}× BW)` : base;
}
export function bestSetText(
  e: ExerciseStat,
  wu: UnitPrefs["weightUnit"]
): string {
  if (e.bodyweight) return `BW × ${e.bestReps}`;
  return `${fmtWeight(e.bestWeightKg, wu)} × ${e.bestReps}`;
}

// Per-exercise detail: muscle/region badges, benchmark stat grid, training-volume
// trend, and any matching goals. Shared by the Strength page and the journal's
// right-hand detail pane.
export default function ExerciseDetailPanel({
  stat,
  bodyweightKg,
  units,
  goals,
  goalProgress,
  recent,
  onFilterTag,
  headerRight,
  showTrend = true,
  showRecent = true,
  showLevel = true,
  sex,
}: {
  stat: ExerciseStat;
  bodyweightKg: number | null;
  units: UnitPrefs;
  // Profile sex, so strength standards/levels use the sex-appropriate chart.
  sex?: Sex | null;
  goals?: Goal[];
  // Auto-derived progress keyed by goal id (plain object — crosses the
  // server/client boundary, unlike a Map).
  goalProgress?: Record<number, GoalProgress>;
  // Recent sessions of this exercise (newest first), already summarized.
  // `href` links to the session's activity in the journal; `date` is preformatted.
  recent?: {
    date: string;
    href: string;
    equipment: string | null;
    text: string;
  }[];
  // When provided, the muscle/region badges become buttons that filter by them.
  onFilterTag?: (kind: "muscle" | "region", value: string) => void;
  // Optional control pinned to the right of the header, after the level badge
  // (e.g. a close button when shown in a dismissable panel).
  headerRight?: ReactNode;
  // Compare owns the main chart; other surfaces keep the compact embedded trend.
  showTrend?: boolean;
  // Compare also owns the full session table.
  showRecent?: boolean;
  // Analyze shows the benchmark progression in a dedicated card.
  showLevel?: boolean;
}) {
  const formatPrefs = useFormatPrefs();
  const todayStr = dateStrInTz(useTimezone());
  const wu = units.weightUnit;
  const info = liftInfo(stat.exercise);

  // Bodyweight-band strength standing (#152) — the SINGLE strength-level source.
  // Both the header level badge AND the coaching line below derive from this one
  // computation (no more flat-ratio second model that could disagree by a tier).
  // Hidden entirely when sex or bodyweight is unset, or the lift isn't covered.
  // Gated on showLevel so it doesn't double up with the Analyze Benchmarks card.
  const standing =
    showLevel && sex && bodyweightKg
      ? strengthStanding(stat.exercise, stat.e1rmKg, sex, bodyweightKg)
      : null;
  const badge = standing
    ? {
        level: standing.level,
        label: strengthLevelLabel(standing.level),
        color: strengthLevelColor(standing.level),
      }
    : null;
  // standing is non-null only when sex was set (see the gate above); the extra
  // `&& sex` narrows the type for strengthStandingPhrase's Sex parameter.
  const standingMsg =
    standing && sex ? strengthStandingPhrase(standing, sex, wu) : null;
  const matchedGoals = goals
    ? goalsForExercise(goals, stat.exercise).filter((g) => !g.archived)
    : [];
  const nextSet = suggestNextSet(stat, wu);
  const pr = lastSessionPR(stat);

  // When bodyweight is unknown the trend is total reps per session (a raw count);
  // otherwise it's weight×reps volume (bodyweight folded in for bodyweight lifts).
  const repsTrend = stat.volumeIsReps;
  const chart = stat.volume.map((v) => ({
    date: v.date,
    value: repsTrend ? v.volumeKg : dispWeight(v.volumeKg, wu, 0),
  }));

  // A muscle/region badge, clickable to filter when onFilterTag is provided.
  const tagBadge = (kind: "muscle" | "region", value: string, cls: string) =>
    onFilterTag ? (
      <button
        type="button"
        onClick={() => onFilterTag(kind, value)}
        title={`Show ${value} activities`}
        className={`badge ${cls} cursor-pointer transition hover:ring-1 hover:ring-current`}
      >
        {value}
      </button>
    ) : (
      <span className={`badge ${cls}`}>{value}</span>
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Below lg the panel renders inside MobileDetailPage, whose header
            already shows the name — hide the inline one there. */}
        <h2 className="font-semibold text-slate-800 max-lg:hidden dark:text-slate-100">
          {stat.exercise}
        </h2>
        {info?.muscle &&
          tagBadge(
            "muscle",
            info.muscle,
            "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
          )}
        {info?.region &&
          info.region !== info.muscle &&
          tagBadge(
            "region",
            info.region,
            "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
          )}
        {(badge || headerRight) && (
          <div className="ml-auto flex items-center gap-2">
            {badge && (
              <LevelBadge
                level={badge.level}
                exercise={stat.exercise}
                sex={sex}
                bodyweightKg={bodyweightKg}
              />
            )}
            {headerRight}
          </div>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3">
        {/* Est. 1RM carries the × bodyweight multiple inline, so there's no
            separate × Bodyweight box. */}
        <StatBox
          label="Est. 1RM"
          value={e1rmText(stat, wu, bodyweightKg)}
          badge={pr.e1rm ? PR_CHIP : undefined}
        />
        <StatBox
          label="Top weight"
          value={stat.bodyweight ? "BW" : fmtWeight(stat.topWeightKg, wu)}
          badge={pr.weight ? PR_CHIP : undefined}
        />
        <StatBox
          label="Best set"
          value={bestSetText(stat, wu)}
          sub={formatLongDate(stat.bestDate, formatPrefs)}
        />
        <StatBox label="Sessions" value={String(stat.sessions)} />
        <StatBox
          label="Last trained"
          value={formatRelativeDate(stat.lastDate, todayStr)}
          sub={formatLongDate(stat.lastDate, formatPrefs)}
          href={`/training?tab=log#activity-${stat.lastActivityId}`}
        />
        {matchedGoals.map((g) => {
          const pct = goalProgress?.[g.id]?.pct ?? 0;
          return (
            <StatBox
              key={g.id}
              label="Goal"
              value={goalTargetText(g, wu) ?? g.title}
              href="/training?tab=goals#goals"
              sub={`${pct}% complete`}
              progress={pct}
            />
          );
        })}
      </dl>

      {standingMsg && (
        <div
          data-testid="strength-standard"
          className="mt-4 rounded-lg border border-black/10 bg-slate-50/70 px-3 py-2 dark:border-white/10 dark:bg-white/5"
        >
          <div className="text-sm font-medium text-slate-600 dark:text-slate-300">
            Strength standard
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {standingMsg}
          </p>
        </div>
      )}

      {nextSet && (
        <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 dark:border-brand-900 dark:bg-brand-950/40">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-brand-600 dark:text-brand-400">
              Next set
            </span>
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {nextSetText(nextSet, wu)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {nextSet.rationale}
          </p>
        </div>
      )}

      {showTrend && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {repsTrend ? "Reps over time" : "Training volume over time"}
          </h3>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            {repsTrend
              ? "Total reps per session"
              : `${wu} lifted per session (weight × reps)`}
          </p>
          {/* The chart's full ISO dates get a compact MM-DD axis + friendly tooltip
              from LineChartCard's date defaults. */}
          <LineChartCard
            data={chart}
            label={repsTrend ? "Reps" : "Volume"}
            unit={repsTrend ? "" : ` ${wu}`}
            color={chartSeries.violet}
          />
        </div>
      )}

      {showRecent && recent && recent.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {recent.length === 1
              ? "Last session"
              : `Last ${recent.length} sessions`}
          </h3>
          <ul className="space-y-1 text-sm">
            {recent.map((r, i) => (
              <li
                key={i}
                className="flex items-baseline justify-between gap-3 border-b border-black/5 pb-1 last:border-0 dark:border-white/5"
              >
                <a
                  href={r.href}
                  className="shrink-0 text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
                >
                  {r.date}
                </a>
                <span className="flex items-baseline justify-end gap-2 text-right">
                  {r.equipment && (
                    <span
                      className="badge shrink-0 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      title="Equipment used"
                    >
                      {r.equipment}
                    </span>
                  )}
                  <span className="tabular-nums text-slate-600 dark:text-slate-300">
                    {r.text}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Static how-to guide for catalog lifts (#734). Renders nothing for a
          custom (non-catalog) lift — getExerciseGuide returns undefined. The
          aggregate panel spans every implement, so no single equipment is passed
          (all per-implement notes are shown). */}
      <ExerciseGuideSection name={stat.exercise} />
    </div>
  );
}
