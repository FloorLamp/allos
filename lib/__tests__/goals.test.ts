import { describe, expect, it } from "vitest";
import {
  BODY_METRIC_LABELS,
  fmtBodyMetric,
  frequencyScopeLabel,
  goalBarClass,
  goalBodyTargetText,
  goalMatchesExercise,
  goalPct,
  goalsForExercise,
  goalTargetText,
} from "@/lib/goals";
import type { Goal } from "@/lib/types";
import type { GoalProgress } from "@/lib/goal-progress";

// Minimal Goal factory: freeform by default; override the linked fields per test.
function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 1,
    title: "Goal",
    description: null,
    category: null,
    target_value: null,
    current_value: null,
    unit: null,
    target_date: null,
    status: "active",
    created_at: "2026-01-01",
    exercise: null,
    metric: null,
    target_weight_kg: null,
    target_reps: null,
    target_sets: null,
    target_duration_sec: null,
    body_metric: null,
    baseline_value: null,
    archived: 0,
    ...overrides,
  };
}

describe("fmtBodyMetric", () => {
  it("renders weight in the user's unit", () => {
    expect(fmtBodyMetric("weight", 75, "kg")).toBe("75 kg");
    // 75 kg ≈ 165.3 lb
    expect(fmtBodyMetric("weight", 75, "lb")).toBe("165.3 lb");
  });

  it("renders body fat as a percentage with one decimal", () => {
    expect(fmtBodyMetric("body_fat", 18.25, "kg")).toBe("18.3%");
  });

  it("renders resting HR as rounded bpm", () => {
    expect(fmtBodyMetric("resting_hr", 58.6, "kg")).toBe("59 bpm");
  });

  it("renders an em dash for null/undefined", () => {
    expect(fmtBodyMetric("weight", null, "kg")).toBe("—");
    expect(fmtBodyMetric("weight", undefined, "kg")).toBe("—");
  });
});

describe("goalBodyTargetText", () => {
  it("composes a labelled body target", () => {
    const g = makeGoal({ body_metric: "weight", target_value: 75 });
    expect(goalBodyTargetText(g, "kg")).toBe("Bodyweight → 75 kg");
  });

  it("uses the metric labels map", () => {
    const g = makeGoal({ body_metric: "resting_hr", target_value: 55 });
    expect(goalBodyTargetText(g, "kg")).toBe(
      `${BODY_METRIC_LABELS.resting_hr} → 55 bpm`
    );
  });

  it("returns null for a non-body goal", () => {
    expect(goalBodyTargetText(makeGoal(), "kg")).toBeNull();
  });
});

describe("goalBarClass", () => {
  it("tints by completion band", () => {
    expect(goalBarClass(100)).toBe("bg-emerald-500");
    expect(goalBarClass(120)).toBe("bg-emerald-500");
    expect(goalBarClass(67)).toBe("bg-brand-500");
    expect(goalBarClass(34)).toBe("bg-amber-500");
    expect(goalBarClass(33)).toBe("bg-rose-500");
    expect(goalBarClass(0)).toBe("bg-rose-500");
  });
});

describe("goalMatchesExercise", () => {
  it("matches an exact name regardless of case/whitespace", () => {
    const g = makeGoal({ exercise: "Deadlift" });
    expect(goalMatchesExercise(g, "  deadlift ")).toBe(true);
  });

  it("matches any variant sharing a base when the goal stores a base name", () => {
    const g = makeGoal({ exercise: "Curl" });
    expect(goalMatchesExercise(g, "Dumbbell Curl")).toBe(true);
    expect(goalMatchesExercise(g, "Cable Curl")).toBe(true);
  });

  it("matches a composed goal name only exactly", () => {
    const g = makeGoal({ exercise: "Dumbbell Curl" });
    expect(goalMatchesExercise(g, "Dumbbell Curl")).toBe(true);
    expect(goalMatchesExercise(g, "Cable Curl")).toBe(false);
    expect(goalMatchesExercise(g, "Curl")).toBe(false);
  });

  it("returns false when the goal has no exercise", () => {
    expect(goalMatchesExercise(makeGoal(), "Deadlift")).toBe(false);
  });
});

describe("goalsForExercise", () => {
  it("returns only metric-bearing goals that match the exercise", () => {
    const matchWithMetric = makeGoal({
      id: 1,
      exercise: "Curl",
      metric: "weight",
    });
    const matchNoMetric = makeGoal({ id: 2, exercise: "Curl", metric: null });
    const other = makeGoal({ id: 3, exercise: "Deadlift", metric: "weight" });
    const goals = [matchWithMetric, matchNoMetric, other];
    expect(goalsForExercise(goals, "Dumbbell Curl")).toEqual([matchWithMetric]);
  });
});

describe("frequencyScopeLabel", () => {
  it("maps group keys to friendly labels", () => {
    expect(frequencyScopeLabel("group", "Lower")).toBe("Lower body");
    expect(frequencyScopeLabel("group", "Core")).toBe("Core");
  });

  it("title-cases type scopes", () => {
    expect(frequencyScopeLabel("type", "cardio")).toBe("Cardio");
  });

  it("passes region and unknown values through", () => {
    expect(frequencyScopeLabel("region", "Chest")).toBe("Chest");
    expect(frequencyScopeLabel("group", "Mystery")).toBe("Mystery");
    expect(frequencyScopeLabel("type", "")).toBe("");
  });
});

describe("goalTargetText", () => {
  it("renders a weight goal with optional reps", () => {
    const g = makeGoal({
      exercise: "Barbell Bench Press",
      metric: "weight",
      target_weight_kg: 100,
    });
    expect(goalTargetText(g, "kg")).toBe("Barbell Bench Press 100 kg");

    const withReps = makeGoal({
      exercise: "Barbell Bench Press",
      metric: "weight",
      target_weight_kg: 100,
      target_reps: 5,
    });
    expect(goalTargetText(withReps, "kg")).toBe(
      "Barbell Bench Press 100 kg × 5"
    );
  });

  it("renders a reps goal with optional load", () => {
    const g = makeGoal({
      exercise: "Pull Up",
      metric: "reps",
      target_reps: 12,
    });
    expect(goalTargetText(g, "kg")).toBe("Pull Up × 12");

    const loaded = makeGoal({
      exercise: "Pull Up",
      metric: "reps",
      target_reps: 12,
      target_weight_kg: 10,
    });
    expect(goalTargetText(loaded, "kg")).toBe("Pull Up × 12 @ 10 kg");
  });

  it("renders a sets goal", () => {
    const g = makeGoal({
      exercise: "Squat",
      metric: "sets",
      target_sets: 5,
      target_reps: 5,
      target_weight_kg: 100,
    });
    expect(goalTargetText(g, "kg")).toBe("Squat 5×5 @ 100 kg");
  });

  it("renders a hold goal as m:ss", () => {
    const g = makeGoal({
      exercise: "Plank",
      metric: "hold",
      target_duration_sec: 120,
    });
    expect(goalTargetText(g, "kg")).toBe("Plank 2:00");
  });

  it("returns null for freeform goals (no exercise or metric)", () => {
    expect(goalTargetText(makeGoal(), "kg")).toBeNull();
    expect(goalTargetText(makeGoal({ exercise: "Squat" }), "kg")).toBeNull();
  });
});

describe("goalPct", () => {
  const prog = (pct: number): GoalProgress => ({
    current: pct,
    target: 100,
    pct,
    done: pct >= 100,
  });

  it("uses derived progress for exercise-linked goals (0 when uncomputed)", () => {
    const g = makeGoal({ exercise: "Bench", metric: "weight" });
    expect(goalPct(g, prog(80))).toBe(80);
    expect(goalPct(g, undefined)).toBe(0);
  });

  it("uses derived progress for body-metric goals", () => {
    const g = makeGoal({ body_metric: "weight" });
    expect(goalPct(g, prog(42))).toBe(42);
    expect(goalPct(g, undefined)).toBe(0);
  });

  it("uses current/target for manual numeric goals, capped at 100", () => {
    expect(goalPct(makeGoal({ target_value: 200, current_value: 50 }))).toBe(
      25
    );
    expect(goalPct(makeGoal({ target_value: 100, current_value: 250 }))).toBe(
      100
    );
  });

  it("returns null for a goal with no numeric basis", () => {
    expect(goalPct(makeGoal())).toBeNull();
  });

  // Issue #307: a `metric` WITHOUT an `exercise` is not a well-formed exercise
  // goal (getGoalProgressMap builds no progress entry for it), so it is manual
  // freeform — it must read current/target, NOT a bogus derived 0%. This is the
  // branch the household/dashboard copies got wrong (they tested `metric ||
  // body_metric`).
  it("treats a metric-without-exercise goal as manual, not derived", () => {
    const g = makeGoal({
      metric: "weight",
      exercise: null,
      target_value: 200,
      current_value: 100,
    });
    // No progress entry exists for such a goal; freeform basis applies.
    expect(goalPct(g, undefined)).toBe(50);
    // Not the derived-0% the old `metric || body_metric` test would have given.
    expect(goalPct(g, undefined)).not.toBe(0);
  });
});

// One question, one computation (issue #307): the household card, the dashboard
// ActiveGoalsWidget, and the training GoalsManager all render a goal percentage
// by calling goalPct. This pins that they resolve the SAME number for the same
// fixture — replicating each surface's exact call expression, including the
// GoalsManager quirk of only passing progress for `auto` (derived) goals.
describe("goalPct cross-surface parity", () => {
  const fixtures: { name: string; goal: Goal; prog?: GoalProgress }[] = [
    {
      name: "exercise-linked (derived)",
      goal: makeGoal({ id: 1, exercise: "Bench", metric: "weight" }),
      prog: { current: 80, target: 100, pct: 80, done: false },
    },
    {
      name: "body-metric (derived)",
      goal: makeGoal({ id: 2, body_metric: "weight" }),
      prog: { current: 42, target: 100, pct: 42, done: false },
    },
    {
      name: "freeform numeric (manual)",
      goal: makeGoal({ id: 3, target_value: 200, current_value: 50 }),
    },
    {
      name: "metric-without-exercise (manual)",
      goal: makeGoal({
        id: 4,
        metric: "weight",
        exercise: null,
        target_value: 200,
        current_value: 100,
      }),
    },
    {
      name: "no numeric basis (null)",
      goal: makeGoal({ id: 5 }),
    },
  ];

  for (const f of fixtures) {
    it(`agrees across surfaces: ${f.name}`, () => {
      const progressMap = new Map<number, GoalProgress>();
      if (f.prog) progressMap.set(f.goal.id, f.prog);
      const progressRecord: Record<number, GoalProgress> = f.prog
        ? { [f.goal.id]: f.prog }
        : {};

      // Household card (goalHighlights) and ActiveGoalsWidget both pass the
      // progress-map lookup directly.
      const household = goalPct(f.goal, progressMap.get(f.goal.id));
      const widget = goalPct(f.goal, progressMap.get(f.goal.id));

      // GoalsManager only passes progress for goals it classifies as `auto`
      // (exercise-linked or body-metric); freeform goals get undefined.
      const isExercise = f.goal.metric != null && f.goal.exercise != null;
      const auto = isExercise || f.goal.body_metric != null;
      const goalsPage = goalPct(
        f.goal,
        auto ? progressRecord[f.goal.id] : undefined
      );

      expect(widget).toBe(household);
      expect(goalsPage).toBe(household);
    });
  }
});
