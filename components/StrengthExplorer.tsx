"use client";

import { useState } from "react";
import type { UnitPrefs } from "@/lib/settings";
import type {
  ExerciseStat,
  GoalProgress,
  RecentByExercise,
} from "@/lib/queries";
import type { Goal, Sex } from "@/lib/types";
import { strengthStanding } from "@/lib/strength-standards";
import { lastSessionPR } from "@/lib/coaching";
import { formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import { EmptyState } from "@/components/ui";
import MobileDetailPage from "@/components/MobileDetailPage";
import { openDetailOnMobile } from "@/components/mobileDetail";
import LevelBadge from "@/components/LevelBadge";
import ScrollFade from "@/components/ScrollFade";
import ExerciseDetailPanel, {
  e1rmText,
  bestSetText,
} from "@/components/ExerciseDetailPanel";

export default function StrengthExplorer({
  exercises,
  bodyweightKg,
  units,
  recentByExercise,
  goals,
  goalProgress,
  sex,
}: {
  exercises: ExerciseStat[];
  bodyweightKg: number | null;
  units: UnitPrefs;
  recentByExercise: RecentByExercise;
  goals: Goal[];
  // Auto-derived progress keyed by goal id (plain object — crosses the
  // server/client boundary, unlike a Map).
  goalProgress: Record<number, GoalProgress>;
  // Profile sex, so strength standards/levels use the sex-appropriate chart.
  sex?: Sex | null;
}) {
  const [selected, setSelected] = useState(exercises[0]?.exercise ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const wu = units.weightUnit;
  const todayStr = dateStrInTz(useTimezone());

  function selectExercise(exercise: string) {
    setSelected(exercise);
    openDetailOnMobile(() => setDetailOpen(true));
  }

  if (exercises.length === 0) {
    return (
      <EmptyState message="No strength data yet. Log a workout with weight and reps to see analysis and benchmarks." />
    );
  }

  const current =
    exercises.find((e) => e.exercise === selected) ?? exercises[0];

  // The lifter's standing for an exercise — the SINGLE strength-level model. Null
  // (⇒ no badge) when the lift isn't covered or sex/bodyweight is unset.
  function standingFor(e: ExerciseStat) {
    return strengthStanding(e.exercise, e.e1rmKg, sex, bodyweightKg);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {/* Exercise table */}
      <div className="card min-w-0 lg:col-span-3">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Exercises
        </h2>
        <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
          Select an exercise to see its details and progress.
        </p>
        <ScrollFade>
          <table className="w-full whitespace-nowrap">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/10">
                <th className="th">Exercise</th>
                <th className="th">Est. 1RM</th>
                <th className="th">Best set</th>
                <th className="th">Level</th>
                <th className="th">Last</th>
              </tr>
            </thead>
            <tbody>
              {exercises.map((e) => {
                const standing = standingFor(e);
                const active = e.exercise === current.exercise;
                const isPR = lastSessionPR(e).e1rm;
                return (
                  <tr
                    key={e.exercise}
                    onClick={() => selectExercise(e.exercise)}
                    className={`cursor-pointer border-b border-black/5 transition dark:border-white/10 ${
                      active
                        ? "bg-brand-50 dark:bg-brand-950"
                        : "hover:bg-brand-50/60 dark:hover:bg-brand-950/50"
                    }`}
                  >
                    <td className="td font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {e.exercise}
                        {isPR && (
                          <span
                            className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                            title="New personal record in the latest session"
                          >
                            🏆 PR
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="td font-semibold">
                      {e1rmText(e, wu, bodyweightKg)}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {bestSetText(e, wu)}
                    </td>
                    <td className="td font-medium">
                      {standing ? (
                        <LevelBadge
                          level={standing.level}
                          exercise={e.exercise}
                          sex={sex}
                          bodyweightKg={bodyweightKg}
                        />
                      ) : (
                        <span className="text-slate-300 dark:text-slate-600">
                          —
                        </span>
                      )}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {formatRelativeDate(e.lastDate, todayStr)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>

      {/* Details — beside the list on desktop, in a bottom sheet on mobile. */}
      <div className="card hidden lg:col-span-2 lg:block">
        <ExerciseDetailPanel
          stat={current}
          bodyweightKg={bodyweightKg}
          units={units}
          recent={recentByExercise[current.exercise.toLowerCase()]}
          goals={goals}
          goalProgress={goalProgress}
          sex={sex}
        />
      </div>

      <MobileDetailPage
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={current.exercise}
      >
        <ExerciseDetailPanel
          stat={current}
          bodyweightKg={bodyweightKg}
          units={units}
          recent={recentByExercise[current.exercise.toLowerCase()]}
          goals={goals}
          goalProgress={goalProgress}
          sex={sex}
        />
      </MobileDetailPage>
    </div>
  );
}
