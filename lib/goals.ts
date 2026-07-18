import type { BodyMetricKind, Goal, GoalStatus } from "./types";
import { GOAL_STATUSES } from "./types";
import type { GoalProgress } from "./goal-progress";
import { baseLiftName, variantOf } from "./lifts";
import { foodGroupName } from "./food-groups";
import { fmtWeight, round } from "./units";
import type { WeightUnit } from "./settings";
import { formatSeconds } from "./duration";
import { daysBetweenDateStr } from "./date";

// Runtime guard for a goal lifecycle status, single-sourced from GOAL_STATUSES (and
// thus from the goals.status CHECK — see the enum-parity test). Used by the write
// action so a status value is validated against the one source of truth instead of a
// re-typed literal pair that could drift from the union/CHECK (issue #328).
export function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    typeof value === "string" &&
    (GOAL_STATUSES as readonly string[]).includes(value)
  );
}

// The single "is this goal live (active and not filed away)?" predicate. Goal
// liveness is DUAL-AXIS: status must be "active" AND archived must be falsy —
// GOAL_STATUSES also has "achieved", and archived is an independent column, so a
// raw `status === "active"` check that forgets `archived` is the classic bug. Every
// surface that filters to live goals routes through here (issue: goal-liveness
// canonical predicate). Takes the two fields so callers can pass a partial row.
export function isGoalLive(g: {
  status: GoalStatus | string;
  archived: number | boolean | null | undefined;
}): boolean {
  return g.status === "active" && !g.archived;
}

// The single "what percent complete is this goal?" computation, shared by every
// surface that renders a goal percentage (the household card via goalHighlights,
// the dashboard's ActiveGoalsWidget, and the training GoalsManager) so they can
// never disagree (issue #307 — this was re-derived inline in three places, and
// the goals page's auto-vs-manual test had drifted).
//
// A goal's percentage has one of three bases, in priority order:
//   1. Derived progress — for exercise-linked and body-metric goals, whose
//      progress is computed upstream (getGoalProgressMap) and passed in. 0 when
//      not yet computed (no matching sets / no reading).
//   2. Manual current/target — a freeform goal with a numeric target, capped at
//      100.
//   3. No numeric basis → null (render no bar).
//
// A goal is "derived" iff it is exercise-linked (BOTH `exercise` AND `metric`
// set — the definition in lib/types.ts) OR body-linked (`body_metric` set). This
// is exactly the set getGoalProgressMap builds progress for; a `metric` set
// WITHOUT an `exercise` is not a well-formed exercise goal, has no progress
// entry, and so falls through to the freeform current/target basis (issue #307's
// user-visible bug: the household/dashboard copies tested `metric || body_metric`
// and showed such a goal a bogus 0%, while the goals page showed current/target).
export function goalPct(g: Goal, progress?: GoalProgress): number | null {
  if ((g.exercise && g.metric) || g.body_metric) return progress?.pct ?? 0;
  if (g.target_value && g.current_value != null)
    return Math.min(100, Math.round((g.current_value / g.target_value) * 100));
  return null;
}

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

// The unified pace-verdict tone shared by the goal progress bar and the weekly-habit
// chip (#780). Four states, a SUPERSET of FrequencyPace (below): "failed" is reachable
// ONLY by a dated goal past its deadline short of target — a recurring week never
// "fails" (it resets), so FrequencyPace stays 3-state and its values are a structural
// subset of these. Names are semantic, not hues, so a hue swap (retiring #760's
// one-off "sky" for the app's established "brand" progress color) lives in ONE place.
export type PaceTone = "met" | "on-pace" | "behind" | "failed";

// The ONE tone→class mapping both surfaces format over, so the goal bar and the habit
// chip can never drift into two color languages (#780). `FILL` tints the goal bar AND
// the chip's filled squares (bg-*); `BORDER` frames the chip; `BADGE` styles the
// /nutrition text pill — all keyed by the SAME PaceTone. Edit a hue here, both move.
export const PACE_FILL_CLASS: Record<PaceTone, string> = {
  met: "bg-emerald-500",
  "on-pace": "bg-brand-500",
  behind: "bg-amber-500",
  failed: "bg-rose-500",
};

export const PACE_BORDER_CLASS: Record<PaceTone, string> = {
  met: "border-emerald-400 dark:border-emerald-700",
  "on-pace": "border-brand-400 dark:border-brand-700",
  behind: "border-amber-400 dark:border-amber-600",
  failed: "border-rose-400 dark:border-rose-800",
};

export const PACE_BADGE_CLASS: Record<PaceTone, string> = {
  met: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "on-pace":
    "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  behind: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

// The pace verdict for an OUTCOME goal's progress bar (#780). Geometry (bar length)
// already shows "how far"; color shows a PACE verdict so a day-one goal never reads
// as a rose "failing" bar:
//   - progress at/over target (pct ≥ 100) → "met".
//   - no target date → "on-pace": a goal with no deadline can't be paced, and the
//     bar's length already conveys progress, so never invent a behind/failed verdict.
//   - a DATED goal whose deadline has passed short of target → "failed" (the only
//     genuine failure — rose).
//   - otherwise linear pace over the goal's [created_at, target_date] window: on pace
//     iff progress ≥ the share the elapsed fraction owes, else "behind".
// Pure calendar math (daysBetweenDateStr), client-safe — no DB.
export function goalPaceTone(
  pct: number,
  opts: { createdAt: string; targetDate: string | null; today: string }
): PaceTone {
  if (pct >= 100) return "met";
  const { createdAt, targetDate, today } = opts;
  if (!targetDate) return "on-pace"; // no deadline → can't pace
  const remaining = daysBetweenDateStr(today, targetDate);
  if (remaining != null && remaining < 0) return "failed"; // deadline passed short
  const total = daysBetweenDateStr(createdAt, targetDate);
  const elapsed = daysBetweenDateStr(createdAt, today);
  if (total == null || elapsed == null || total <= 0) return "on-pace";
  const frac = Math.min(1, Math.max(0, elapsed / total));
  return pct >= 100 * frac ? "on-pace" : "behind";
}

// Progress-bar tint for a goal — a formatter over the shared tone→class map (#780).
// Colors by the PACE verdict (goalPaceTone), NOT raw completion, so a fresh goal reads
// on-pace (brand) instead of the old rose "failing" bar. Callers with goal dates pass
// them; the dateless overload (e.g. StatBox's generic stat bars, which aren't dated
// goals) gets the no-deadline verdict → brand until complete.
export function goalBarClass(
  pct: number,
  opts?: { createdAt: string; targetDate: string | null; today: string }
): string {
  return PACE_FILL_CLASS[
    goalPaceTone(pct, opts ?? { createdAt: "", targetDate: null, today: "" })
  ];
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

// Paced status of a weekly frequency target (issue #748 item 3). A target used to be
// only "met" (count >= per_week) or, by omission, "Behind" — so on the first day of the
// week EVERY unmet habit read amber "Behind", punishing a fresh week. This adds a middle
// "on-pace" state: you're on pace while your count keeps up with the share of the week
// already elapsed. The floor gives a neutral early-week grace — a 2×/week habit needs
// floor(2×1/7)=0 servings to be on pace on day 1, so it isn't flagged Behind until the
// week has matured enough that a serving is actually owed.
//
// Pure (no DB), so both surfaces that show a paced target — the /nutrition Weekly habits
// card and the dashboard Goals-and-habits widget — key on the SAME state (one question,
// one computation). `elapsedDays` is the number of days in the profile's week window
// through today, inclusive (1..7); a rolling 7-day window is always fully elapsed, so a
// rolling-mode target is "on-pace" only once complete, which matches its always-mature
// window.
export type FrequencyPace = "met" | "on-pace" | "behind";

export function frequencyPace(
  count: number,
  perWeek: number,
  elapsedDays: number
): FrequencyPace {
  if (perWeek <= 0 || count >= perWeek) return "met";
  const elapsed = Math.min(7, Math.max(1, Math.trunc(elapsedDays)));
  const owedSoFar = Math.floor((perWeek * elapsed) / 7);
  return count >= owedSoFar ? "on-pace" : "behind";
}

// The badge/label text for a paced target — one place both surfaces format over.
export function frequencyPaceLabel(pace: FrequencyPace): string {
  return pace === "met"
    ? "On track"
    : pace === "on-pace"
      ? "On pace"
      : "Behind";
}

// Display label for a frequency target's scope ("Lower body", "Cardio", "Chest").
export function frequencyScopeLabel(kind: string, value: string): string {
  if (!value) return value;
  if (kind === "group") return GROUP_LABELS[value] ?? value;
  if (kind === "type") return value[0].toUpperCase() + value.slice(1);
  if (kind === "food_group") return foodGroupName(value);
  // Mobility-region (#840): the region label with a "Mobility:" qualifier so it reads
  // apart from the strength `region` target of the same region (trained ≠ mobilized, #482).
  if (kind === "mobility_region") return `Mobility: ${value}`;
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
