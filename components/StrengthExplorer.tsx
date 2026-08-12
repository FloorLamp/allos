"use client";

import type { UnitPrefs } from "@/lib/settings";
import type {
  ExerciseStat,
  GoalProgress,
  RecentByExercise,
} from "@/lib/queries";
import type { OutcomeGoal, Sex } from "@/lib/types";
import { strengthStanding } from "@/lib/strength-standards";
import { exerciseHistoryKey } from "@/lib/lifts";
import { lastSessionPR } from "@/lib/coaching";
import { formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import LevelBadge from "@/components/LevelBadge";
import ExplorerShell, { type ExplorerColumn } from "@/components/ExplorerShell";
import ExerciseDetailPanel, {
  e1rmText,
  bestSetText,
} from "@/components/ExerciseDetailPanel";

// Strength master–detail explorer: the shared ExplorerShell (#1491 item 3) with
// strength's columns (PR badge, level standing) and detail panel.
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
  goals: OutcomeGoal[];
  // Auto-derived progress keyed by goal id (plain object — crosses the
  // server/client boundary, unlike a Map).
  goalProgress: Record<number, GoalProgress>;
  // Profile sex, so strength standards/levels use the sex-appropriate chart.
  sex?: Sex | null;
}) {
  const wu = units.weightUnit;
  const todayStr = dateStrInTz(useTimezone());

  const columns: ExplorerColumn<ExerciseStat>[] = [
    {
      header: "Exercise",
      cellClassName: "font-medium",
      cell: (e) => (
        <span className="inline-flex items-center gap-1.5">
          {e.exercise}
          {lastSessionPR(e).e1rm && (
            <span
              className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              title="New personal record in the latest session"
            >
              🏆 PR
            </span>
          )}
        </span>
      ),
    },
    {
      header: "Est. 1RM",
      cellClassName: "font-semibold",
      cell: (e) => e1rmText(e, wu, bodyweightKg),
    },
    {
      header: "Best set",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (e) => bestSetText(e, wu),
    },
    {
      header: "Level",
      cellClassName: "font-medium",
      cell: (e) => {
        // The lifter's standing for an exercise — the SINGLE strength-level
        // model. Null (⇒ no badge) when the lift isn't covered, sex/bodyweight
        // is unset, or (#2326) no free-weight set backs it: the Est. 1RM column
        // beside this one still shows every set's best, machine included.
        const standing = strengthStanding(
          e.exercise,
          e.freeWeightE1rmKg,
          sex,
          bodyweightKg
        );
        return standing ? (
          <LevelBadge
            level={standing.level}
            exercise={e.exercise}
            sex={sex}
            bodyweightKg={bodyweightKg}
          />
        ) : (
          <span className="text-slate-300 dark:text-slate-600">—</span>
        );
      },
    },
    {
      header: "Last",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (e) => formatRelativeDate(e.lastDate, todayStr),
    },
  ];

  return (
    <ExplorerShell
      heading="Exercises"
      hint="Select an exercise to see its details and progress."
      emptyMessage="No strength data yet. Log a workout with weight and reps to see analysis and benchmarks."
      emptyAction={{ href: "/training?tab=log", label: "Go to Log" }}
      items={exercises}
      itemKey={(e) => e.exercise}
      columns={columns}
      renderDetail={(e) => (
        <ExerciseDetailPanel
          stat={e}
          bodyweightKg={bodyweightKg}
          units={units}
          recent={recentByExercise[exerciseHistoryKey(e.exercise)]}
          goals={goals}
          goalProgress={goalProgress}
          sex={sex}
        />
      )}
    />
  );
}
