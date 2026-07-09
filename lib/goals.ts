import type { BodyMetricKind, Goal } from "./types";
import { baseLiftName, variantOf } from "./lifts";
import { fmtWeight, round } from "./units";
import type { WeightUnit } from "./settings";
import { formatSeconds } from "./duration";

export const BODY_METRIC_LABELS: Record<BodyMetricKind, string> = {
  weight: "Bodyweight",
  body_fat: "Body fat",
  resting_hr: "Resting HR",
};

// Format a body-metric value with its unit. Weight is canonical kg, shown in the
// user's weight unit; body fat is a %, resting HR is bpm.
export function fmtBodyMetric(
  metric: BodyMetricKind,
  value: number | null | undefined,
  wu: WeightUnit
): string {
  if (value == null) return "—";
  if (metric === "weight") return fmtWeight(value, wu);
  if (metric === "body_fat") return `${round(value, 1)}%`;
  return `${Math.round(value)} bpm`;
}

// Human-readable target for a body-metric goal, e.g. "Bodyweight → 75 kg".
export function goalBodyTargetText(goal: Goal, wu: WeightUnit): string | null {
  if (!goal.body_metric) return null;
  return `${BODY_METRIC_LABELS[goal.body_metric]} → ${fmtBodyMetric(
    goal.body_metric,
    goal.target_value,
    wu
  )}`;
}

// Progress-bar tint for a goal's completion percentage: far from done reads red,
// then amber, then green as it nears the target, and emerald once complete.
export function goalBarClass(pct: number): string {
  if (pct >= 100) return "bg-emerald-500";
  if (pct >= 67) return "bg-brand-500";
  if (pct >= 34) return "bg-amber-500";
  return "bg-rose-500";
}

// Whether a logged set's exercise satisfies an exercise-linked goal. A goal that
// stores a composed variant name ("Dumbbell Curl") matches that variant exactly;
// a goal that stores a base/plain name ("Curl", "Back Squat") matches any variant
// sharing that base (so logging "Dumbbell Curl" credits a "Curl" goal).
export function goalMatchesExercise(goal: Goal, exerciseName: string): boolean {
  if (!goal.exercise) return false;
  const goalName = goal.exercise.trim().toLowerCase();
  const setName = exerciseName.trim().toLowerCase();
  if (goalName === setName) return true;
  const goalIsComposed = variantOf(goal.exercise)?.equipment != null;
  if (goalIsComposed) return false;
  return baseLiftName(exerciseName).trim().toLowerCase() === goalName;
}

// Exercise-linked goals matching this exercise (for the exercise detail panel).
// Only considers goals with a metric set; freeform goals never appear here.
export function goalsForExercise(goals: Goal[], exerciseName: string): Goal[] {
  return goals.filter(
    (g) => g.metric != null && goalMatchesExercise(g, exerciseName)
  );
}

const GROUP_LABELS: Record<string, string> = {
  Upper: "Upper body",
  Lower: "Lower body",
  Core: "Core",
  Full: "Full body",
};

// Display label for a frequency target's scope ("Lower body", "Cardio", "Chest").
export function frequencyScopeLabel(kind: string, value: string): string {
  if (!value) return value;
  if (kind === "group") return GROUP_LABELS[value] ?? value;
  if (kind === "type") return value[0].toUpperCase() + value.slice(1);
  return value;
}

// Human-readable target for an exercise-linked goal, e.g. "Barbell Bench Press
// 100 kg", "Squat 5×5 @ 100 kg", "Pull Up × 12", "Plank 2:00". Null for freeform.
export function goalTargetText(goal: Goal, wu: WeightUnit): string | null {
  if (!goal.exercise || !goal.metric) return null;
  const w =
    goal.target_weight_kg != null ? fmtWeight(goal.target_weight_kg, wu) : null;
  switch (goal.metric) {
    case "weight":
      return `${goal.exercise} ${w ?? ""}${goal.target_reps ? ` × ${goal.target_reps}` : ""}`.trim();
    case "reps":
      return `${goal.exercise} × ${goal.target_reps ?? "?"}${w ? ` @ ${w}` : ""}`;
    case "sets":
      return `${goal.exercise} ${goal.target_sets ?? "?"}×${goal.target_reps ?? "?"}${w ? ` @ ${w}` : ""}`;
    case "hold":
      return `${goal.exercise} ${formatSeconds(goal.target_duration_sec)}`;
    default:
      return goal.exercise;
  }
}
