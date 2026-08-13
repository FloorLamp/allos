import type {
  BodyMetricKind,
  OutcomeGoal,
  OutcomeGoalDirection,
  OutcomeGoalStatus,
} from "./types";
import { OUTCOME_GOAL_DIRECTIONS, OUTCOME_GOAL_STATUSES } from "./types";
import type { GoalProgress } from "./goal-progress";
import { baseLiftName, variantOf } from "./lifts";
import { fmtWeight, round } from "./units";
import type { WeightUnit } from "./settings";
import { formatSeconds } from "./duration";
import { daysBetweenDateStr } from "./date";
import { isBiomarkerGoal } from "./biomarker-goal";
import { PACE_FILL_CLASS, type ProgressPaceTone } from "./pace-presentation";

// Runtime guard for a goal lifecycle status, single-sourced from OUTCOME_GOAL_STATUSES (and
// thus from the goals.status CHECK — see the enum-parity test). Used by the write
// action so a status value is validated against the one source of truth instead of a
// re-typed literal pair that could drift from the union/CHECK (issue #328).
export function isOutcomeGoalStatus(
  value: unknown
): value is OutcomeGoalStatus {
  return (
    typeof value === "string" &&
    (OUTCOME_GOAL_STATUSES as readonly string[]).includes(value)
  );
}

// Runtime guard for a goal's target direction, single-sourced from OUTCOME_GOAL_DIRECTIONS
// (and thus from the goals.target_direction CHECK — see the enum-parity test), the
// same discipline isOutcomeGoalStatus follows. The write action validates the submitted
// direction against the one source of truth rather than a re-typed literal pair.
export function isOutcomeGoalDirection(
  value: unknown
): value is OutcomeGoalDirection {
  return (
    typeof value === "string" &&
    (OUTCOME_GOAL_DIRECTIONS as readonly string[]).includes(value)
  );
}

// The single "is this goal live (active and not filed away)?" predicate. Goal
// liveness is DUAL-AXIS: status must be "active" AND archived must be falsy —
// OUTCOME_GOAL_STATUSES also has "achieved", and archived is an independent column, so a
// raw `status === "active"` check that forgets `archived` is the classic bug. Every
// surface that filters to live goals routes through here (issue: goal-liveness
// canonical predicate). Takes the two fields so callers can pass a partial row.
export function isGoalLive(g: {
  status: OutcomeGoalStatus | string;
  archived: number | boolean | null | undefined;
}): boolean {
  return g.status === "active" && !g.archived;
}

// Typed outcome goals are identified by the structural fields that already define
// their behavior. The legacy `goals.category` values are deliberately absent: that
// column is user-authored grouping text for freeform goals, not a discriminator.
export function outcomeGoalKind(
  goal: Pick<
    OutcomeGoal,
    | "exercise"
    | "metric"
    | "body_metric"
    | "biomarker_name"
    | "target_direction"
  >
): OutcomeGoal["kind"] {
  if (goal.exercise && goal.metric) return "exercise";
  if (goal.body_metric) return "body";
  if (isBiomarkerGoal(goal)) return "biomarker";
  return "freeform";
}

// The subtitle a goal wears on Upcoming (#2615 item 4).
//
// Two defects in one line. FIRST, the band mixed vocabularies: every TYPED goal fell
// through to the generic "Goal deadline" (`categoryLabel` is null for them by
// construction — it is freeform grouping text), while a freeform goal printed its
// user-authored word verbatim, so "Goal deadline" and "strength goal" sat in the same
// list describing the same kind of thing. SECOND, and worse on a training profile: an
// exercise-linked "Bench Press" goal and a freeform goal someone also titled "Bench
// Press" were INDISTINGUISHABLE — same title, same generic subtitle — and the
// subtitle is exactly where the distinguishing attribute belongs.
//
// So the subtitle comes from the goal's own STRUCTURAL kind, which is the thing that
// actually differs, and only a freeform goal keeps its user-authored grouping
// (capitalized, so the band reads in one voice — the word is still theirs). Total
// over OutcomeGoalKind: a fifth kind is a compile error here rather than a silent
// fall-back to "Goal deadline".
const GOAL_KIND_DETAIL: Record<
  Exclude<OutcomeGoal["kind"], "freeform">,
  string
> = {
  exercise: "Exercise-linked goal",
  body: "Body goal",
  biomarker: "Biomarker goal",
};

export function goalUpcomingDetail(
  goal: Pick<OutcomeGoal, "kind" | "categoryLabel">
): string {
  if (goal.kind !== "freeform") return GOAL_KIND_DETAIL[goal.kind];
  const category = goal.categoryLabel?.trim();
  if (!category) return "Goal deadline";
  return `${category.charAt(0).toLocaleUpperCase()}${category.slice(1)} goal`;
}

// The single "what percent complete is this goal?" computation, shared by every
// surface that renders a goal percentage (the household card via goalHighlights,
// the dashboard's ActiveGoalsWidget, and the training GoalsManager) so they can
// never disagree (issue #307 — this was re-derived inline in three places, and
// the goals page's auto-vs-manual test had drifted).
//
// A goal's percentage has one of three bases, in priority order:
//   1. Derived progress — for exercise-linked, body-metric, and biomarker goals,
//      whose progress is computed upstream (getOutcomeGoalProgressMap) and passed
//      in. 0 when not yet computed (no matching sets / no reading).
//   2. Manual current/target — a freeform goal with a numeric target, capped at
//      100.
//   3. No numeric basis → null (render no bar).
export function goalPct(
  g: OutcomeGoal,
  progress?: GoalProgress
): number | null {
  if ((g.exercise && g.metric) || g.body_metric || isBiomarkerGoal(g))
    return progress?.pct ?? 0;
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
export function goalBodyTargetText(
  goal: OutcomeGoal,
  wu: WeightUnit
): string | null {
  if (!goal.body_metric) return null;
  return `${BODY_METRIC_LABELS[goal.body_metric]} → ${fmtBodyMetric(
    goal.body_metric,
    goal.target_value,
    wu
  )}`;
}

// Outcome-goal pace has four states. "failed" is reachable
// ONLY by a dated goal past its deadline short of target — a recurring week never
// "fails" (it resets). The neutral presentation palette stays shared without making
// frequency-target code depend on this outcome-goal module.
export type OutcomeGoalPace = ProgressPaceTone;

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
//
// `evidenceDate` (#1853) makes the owed line advance on EVIDENCE instead of on the
// clock, for a goal whose quantity only changes when it is measured. A body-weight
// goal is measured daily, so on day 40 of 100 the clock genuinely owes 40% and the
// scale can genuinely report whether you are there. A LAB goal cannot: it advances
// per result. With `evidenceDate` set, the elapsed term is measured to the last
// RESULT rather than to today, so the verdict is frozen between draws — a goal
// cannot slide from "on pace" to "behind" on a Tuesday when no lab was drawn, which
// would be measuring the calendar rather than the person. An explicit null means no
// evidence has landed at all, which is "nothing to pace yet", never "behind".
//
// Omitting the field is the DAILY model, byte-for-byte as before: every existing
// caller (exercise goals, body-metric goals, StatBox's generic bars) is unaffected.
// The DEADLINE half still reads `today` in both models — a passed deadline is a fact
// about the calendar, and a lab goal whose date has gone by with no result is not
// quietly still "on pace".
export function goalPaceTone(
  pct: number,
  opts: {
    createdAt: string;
    targetDate: string | null;
    today: string;
    evidenceDate?: string | null;
  }
): OutcomeGoalPace {
  if (pct >= 100) return "met";
  const { createdAt, targetDate, today } = opts;
  if (!targetDate) return "on-pace"; // no deadline → can't pace
  const remaining = daysBetweenDateStr(today, targetDate);
  if (remaining != null && remaining < 0) return "failed"; // deadline passed short
  const perResult = "evidenceDate" in opts;
  if (perResult && !opts.evidenceDate) return "on-pace"; // no result yet → nothing to say
  const asOf = perResult ? opts.evidenceDate! : today;
  const total = daysBetweenDateStr(createdAt, targetDate);
  const elapsed = daysBetweenDateStr(createdAt, asOf);
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
export function goalMatchesExercise(
  goal: OutcomeGoal,
  exerciseName: string
): boolean {
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
export function goalsForExercise(
  goals: OutcomeGoal[],
  exerciseName: string
): OutcomeGoal[] {
  return goals.filter(
    (g) => g.metric != null && goalMatchesExercise(g, exerciseName)
  );
}

// Human-readable target for an exercise-linked goal, e.g. "Barbell Bench Press
// 100 kg", "Squat 5×5 @ 100 kg", "Pull Up × 12", "Plank 2:00". Null for freeform.
export function goalTargetText(
  goal: OutcomeGoal,
  wu: WeightUnit
): string | null {
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
