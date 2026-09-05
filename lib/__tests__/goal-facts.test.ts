import { describe, it, expect } from "vitest";
import {
  bodyTargetUnit,
  deadlineFactLabel,
  firstGoalProblem,
  goalFactSummary,
  goalProgressStatement,
  goalStartingFrom,
  moreGoalFactsLabel,
  startingFromFactLabel,
  targetFactLabel,
  type GoalFactInput,
  type GoalFactKey,
  type GoalProblemInput,
  type GoalProgressGoal,
  type GoalProgressReading,
  type GoalStartingFromInput,
} from "../goal-facts";
import type { WeightUnit } from "../settings";

// #3220: what the goal form's chip row states. The chip KEYS, their states and their
// suggestion marking are the contract; the wording is not (see the module header).

const BLANK: GoalFactInput = {
  kind: "exercise",
  kindDerived: false,
  subject: "",
  target: {
    kind: "exercise",
    metric: "weight",
    weight: "",
    reps: "",
    sets: "",
    duration: "",
    weightUnit: "kg",
  },
  targetDate: "",
  startingFrom: null,
  startingFromSuggested: true,
  equipment: null,
  title: "",
  category: "",
  notes: "",
};

function summary(input: Partial<GoalFactInput>) {
  return goalFactSummary({ ...BLANK, ...input });
}
function keys(input: Partial<GoalFactInput>): GoalFactKey[] {
  return summary(input).chips.map((c) => c.key);
}
function chip(input: Partial<GoalFactInput>, key: GoalFactKey) {
  return summary(input).chips.find((c) => c.key === key);
}

describe("the goal chip row states the sentence it will write (#3220)", () => {
  it("states nothing at all before a subject, because there is no goal yet to be missing anything", () => {
    const s = summary({});
    expect(s.subjectAbsent).toBe(true);
    expect(s.chips).toEqual([]);
    expect(s.more).toEqual([]);
  });

  it("a strength goal reads as its sentence: subject, kind, target, deadline", () => {
    const s = summary({
      subject: "Bench Press",
      target: {
        kind: "exercise",
        metric: "weight",
        weight: "100",
        reps: "5",
        sets: "",
        duration: "",
        weightUnit: "kg",
      },
      targetDate: "2026-12-31",
    });
    expect(s.chips.map((c) => c.label)).toEqual([
      "Bench Press",
      "Exercise goal",
      "100 kg × 5",
      "by Dec 31, 2026",
    ]);
  });

  it("marks a DERIVED kind as a suggestion and a chosen one as tracked-and-false", () => {
    expect(
      chip({ subject: "Bench Press", kindDerived: true }, "kind")?.suggested
    ).toBe(true);
    expect(
      chip({ subject: "Bench Press", kindDerived: false }, "kind")?.suggested
    ).toBe(false);
  });

  it("prompts, dashed, for the two facts a goal needs and cannot invent", () => {
    const s = summary({ subject: "Bench Press" });
    expect(chip({ subject: "Bench Press" }, "target")?.state).toBe("missing");
    expect(chip({ subject: "Bench Press" }, "deadline")?.state).toBe("missing");
    // …and only those two. A goal with no title, category or description is
    // complete and common, so none of them may accuse the person of anything.
    expect(
      s.chips.filter((c) => c.state === "missing").map((c) => c.key)
    ).toEqual(["target", "deadline"]);
  });

  it("holds the starting point back when history has nothing to say, and marks it as borrowed when it does", () => {
    expect(summary({ subject: "Bench Press" }).more).toContain("startingFrom");
    const stated = chip(
      { subject: "Bench Press", startingFrom: "from 92.5 kg" },
      "startingFrom"
    );
    expect(stated?.label).toBe("from 92.5 kg");
    expect(stated?.suggested).toBe(true);
    // A freeform goal's starting point is typed, not borrowed — tracked and false.
    expect(
      chip(
        {
          kind: "freeform",
          subject: "Run a half marathon",
          startingFrom: "from 5 km",
          startingFromSuggested: false,
        },
        "startingFrom"
      )?.suggested
    ).toBe(false);
  });

  it("states the machine when the movement offers one, and prompts when #1610 requires a choice", () => {
    expect(
      chip(
        { subject: "Chest Press", equipment: { label: "Home rack" } },
        "equipment"
      )
    ).toMatchObject({ label: "Home rack", state: "stated" });
    // "Any machine" is an ANSWER, not an absence — silently folding every lane is
    // the bug #1610 exists for, so the row says which answer was given.
    expect(
      chip(
        { subject: "Chest Press", equipment: { label: "any machine" } },
        "equipment"
      )
    ).toMatchObject({ state: "stated" });
    expect(
      chip({ subject: "Chest Press", equipment: { label: null } }, "equipment")
    ).toMatchObject({ state: "missing" });
    // No context to choose from → no chip at all, not an empty one.
    expect(keys({ subject: "Chest Press" })).not.toContain("equipment");
  });

  it("gives the freeform kind category and description, and every other kind a title override", () => {
    const free = summary({ kind: "freeform", subject: "Run a half marathon" });
    expect(free.more).toEqual(["startingFrom", "category", "notes"]);
    expect(free.more).not.toContain("title");
    const lab = summary({ kind: "biomarker", subject: "LDL Cholesterol" });
    expect(lab.more).toContain("title");
    expect(lab.more).not.toContain("category");
  });

  it("names the facts the trailing affordance holds", () => {
    expect(moreGoalFactsLabel(["startingFrom", "title"])).toBe(
      "starting point, title…"
    );
    expect(moreGoalFactsLabel([])).toBe("");
  });
});

describe("what each target reads (#3220)", () => {
  const ex = (
    over: Partial<Extract<GoalFactInput["target"], { kind: "exercise" }>>
  ) =>
    targetFactLabel({
      kind: "exercise",
      metric: "weight",
      weight: "",
      reps: "",
      sets: "",
      duration: "",
      weightUnit: "kg",
      ...over,
    });

  it("states the optional companion only when it changes what the goal means", () => {
    expect(ex({ weight: "100" })).toBe("100 kg");
    expect(ex({ weight: "100", reps: "5" })).toBe("100 kg × 5");
    expect(ex({ metric: "reps", reps: "12" })).toBe("12 reps");
    expect(ex({ metric: "reps", reps: "12", weight: "60" })).toBe(
      "12 reps @ 60 kg"
    );
    expect(ex({ metric: "sets", sets: "3", reps: "8" })).toBe("3 × 8");
    expect(ex({ metric: "hold", duration: "2:00" })).toBe("2:00 hold");
  });

  it("has nothing to state until the metric's own primary target is there", () => {
    expect(ex({})).toBeNull();
    expect(ex({ metric: "sets", sets: "3" })).toBeNull();
    expect(ex({ metric: "reps", weight: "60" })).toBeNull();
  });

  it("reads a body target in the metric's own unit and a lab target with its direction", () => {
    expect(
      targetFactLabel({
        kind: "body",
        metric: "weight",
        value: "72",
        weightUnit: "lb",
      })
    ).toBe("72 lb");
    expect(
      targetFactLabel({
        kind: "body",
        metric: "body_fat",
        value: "18",
        weightUnit: "kg",
      })
    ).toBe("18%");
    expect(
      targetFactLabel({
        kind: "biomarker",
        direction: "below",
        value: "100",
        unit: "mg/dL",
      })
    ).toBe("under 100 mg/dL");
    expect(
      targetFactLabel({
        kind: "biomarker",
        direction: "above",
        value: "45",
        unit: "ug / L",
      })
    ).toBe("over 45 µg / L");
    expect(
      targetFactLabel({
        kind: "biomarker",
        direction: "above",
        value: "30",
        unit: null,
      })
    ).toBe("over 30");
    expect(targetFactLabel({ kind: "freeform", value: "21", unit: "km" })).toBe(
      "21 km"
    );
    expect(targetFactLabel({ kind: "freeform", value: "21", unit: "" })).toBe(
      "21"
    );
  });

  it("labels the unit a body target is entered in", () => {
    expect(bodyTargetUnit("weight", "lb")).toBe("lb");
    expect(bodyTargetUnit("body_fat", "kg")).toBe("%");
    expect(bodyTargetUnit("resting_hr", "kg")).toBe("bpm");
  });

  it("reads a deadline as a date and nothing as nothing", () => {
    expect(deadlineFactLabel("2026-12-31")).toBe("by Dec 31, 2026");
    expect(deadlineFactLabel("")).toBeNull();
  });

  it("reads a hold's starting point as m:ss, because nobody says 120 s", () => {
    expect(
      startingFromFactLabel({ value: 120, unit: null, asDuration: true })
    ).toBe("from 2:00");
    expect(startingFromFactLabel({ value: 18, unit: "%" })).toBe("from 18%");
    expect(startingFromFactLabel({ value: null, unit: "kg" })).toBeNull();
  });
});

describe("where the goal is starting from (#3220)", () => {
  const BASE: GoalStartingFromInput = {
    kind: "exercise",
    exerciseBest: { weightKg: 92.5, reps: 12, durationSec: 90 },
    metric: "weight",
    bodyLatest: null,
    bodyMetric: "weight",
    biomarkerLatest: null,
    biomarkerUnit: null,
    currentValue: "",
    freeformUnit: "",
    toDisplayWeight: (kg) => kg,
    weightUnit: "kg",
  };
  const from = (over: Partial<GoalStartingFromInput>) =>
    goalStartingFrom({ ...BASE, ...over });

  it("reads the movement's best for the metric the goal is on", () => {
    expect(from({})).toBe("from 92.5 kg");
    expect(from({ metric: "reps" })).toBe("from 12 reps");
    expect(from({ metric: "hold" })).toBe("from 1:30");
  });

  it("has nothing to say about a sets target, which is a property of the target", () => {
    expect(from({ metric: "sets" })).toBeNull();
  });

  it("converts a canonical kg through the form's own display boundary", () => {
    expect(
      from({ toDisplayWeight: (kg) => Math.round(kg * 2.2), weightUnit: "lb" })
    ).toBe("from 204 lb");
  });

  it("reads a body metric and a lab result from their own stores", () => {
    expect(from({ kind: "body", bodyLatest: 80, bodyMetric: "weight" })).toBe(
      "from 80 kg"
    );
    expect(from({ kind: "body", bodyLatest: 21, bodyMetric: "body_fat" })).toBe(
      "from 21%"
    );
    expect(
      from({
        kind: "biomarker",
        biomarkerLatest: 45,
        biomarkerUnit: "ug / L",
      })
    ).toBe("from 45 µg / L");
  });

  it("takes a freeform goal's starting point from the field, not from history", () => {
    expect(
      from({ kind: "freeform", currentValue: "5", freeformUnit: "km" })
    ).toBe("from 5 km");
    expect(from({ kind: "freeform", currentValue: "" })).toBeNull();
    expect(from({ kind: "freeform", currentValue: "abc" })).toBeNull();
  });

  it("says nothing when the store is empty, rather than claiming a zero", () => {
    expect(from({ exerciseBest: null })).toBeNull();
    expect(
      from({ exerciseBest: { weightKg: null, reps: 3, durationSec: null } })
    ).toBeNull();
    expect(from({ kind: "body", bodyLatest: null })).toBeNull();
    expect(from({ kind: "biomarker", biomarkerLatest: null })).toBeNull();
  });
});

describe("which fact the form must open before it can save (#3220)", () => {
  const BASE: GoalProblemInput = {
    kind: "exercise",
    exercise: "Bench Press",
    metric: "weight",
    targetWeight: "100",
    targetReps: "",
    targetSets: "",
    targetDuration: "",
    machineUnchosen: false,
    bodyTarget: "",
    biomarkerPicked: false,
    biomarkerTarget: "",
    title: "",
  };
  const problem = (over: Partial<GoalProblemInput>) =>
    firstGoalProblem({ ...BASE, ...over });

  it("passes a complete goal", () => {
    expect(problem({})).toBeNull();
  });

  it("points at the subject when there is nothing to track", () => {
    expect(problem({ exercise: "  " })?.fact).toBe("subject");
    expect(problem({ kind: "biomarker" })?.fact).toBe("subject");
    expect(problem({ kind: "freeform" })?.fact).toBe("subject");
  });

  it("points at the target for the metric's own primary number", () => {
    expect(problem({ targetWeight: "" })?.fact).toBe("target");
    expect(problem({ metric: "reps" })?.fact).toBe("target");
    expect(problem({ metric: "hold" })?.fact).toBe("target");
    // A sets target needs BOTH halves — the action refuses one without the other.
    expect(problem({ metric: "sets", targetSets: "3" })?.fact).toBe("target");
    expect(
      problem({ metric: "sets", targetSets: "3", targetReps: "8" })
    ).toBeNull();
    expect(problem({ kind: "body" })?.fact).toBe("target");
    expect(problem({ kind: "biomarker", biomarkerPicked: true })?.fact).toBe(
      "target"
    );
  });

  it("points at the machine only once the target itself is answered (#1610)", () => {
    expect(problem({ machineUnchosen: true })?.fact).toBe("equipment");
    // The target comes first: a person with neither answered is asked the question
    // they opened the form for.
    expect(problem({ machineUnchosen: true, targetWeight: "" })?.fact).toBe(
      "target"
    );
  });
});

// #5198 (absorbing #4759): what a goal's PROGRESS row states. Endpoints in the
// goal's own display units, percent as the trailing annotation, and an honest
// unknown wherever nothing has been measured — a naked "27%" answers 27% of the way
// from what to what.
describe("goalProgressStatement", () => {
  const GOAL: GoalProgressGoal = {
    kind: "body",
    metric: null,
    body_metric: "resting_hr",
    target_weight_kg: null,
    target_reps: null,
    target_sets: null,
    target_duration_sec: null,
    target_value: null,
    current_value: null,
    unit: null,
  };
  const state = (
    goal: Partial<GoalProgressGoal>,
    progress: GoalProgressReading | undefined,
    weightUnit: WeightUnit = "kg"
  ) => goalProgressStatement({ ...GOAL, ...goal }, progress, weightUnit);

  it.each([
    [
      "resting HR in bpm",
      { kind: "body", body_metric: "resting_hr" },
      { current: 63, target: 58, pct: 27 },
      "kg",
      "63 → 58 bpm · 27%",
    ],
    [
      "body fat in percent",
      { kind: "body", body_metric: "body_fat" },
      { current: 22.4, target: 18, pct: 40 },
      "kg",
      "22.4 → 18% · 40%",
    ],
    [
      "a bodyweight goal in the viewer's unit",
      { kind: "body", body_metric: "weight" },
      { current: 80, target: 75, pct: 50 },
      "lb",
      "176.4 → 165.3 lb · 50%",
    ],
    [
      "a bench press in the viewer's unit",
      { kind: "exercise", metric: "weight" },
      { current: 80, target: 85, pct: 80 },
      "lb",
      "176.4 → 187.4 lb · 80%",
    ],
    [
      "a rep target as a count",
      { kind: "exercise", metric: "reps" },
      { current: 8, target: 12, pct: 66 },
      "kg",
      "8 → 12 reps · 66%",
    ],
    [
      "a hold as m:ss",
      { kind: "exercise", metric: "hold" },
      { current: 75, target: 120, pct: 62 },
      "kg",
      "1:15 → 2:00 · 62%",
    ],
    [
      "a lab value in its charted unit",
      { kind: "biomarker" },
      { current: 128, target: 100, pct: 27, unit: "mg/dL" },
      "kg",
      "128 → 100 mg/dL · 27%",
    ],
    [
      "a freeform goal from its manual pair",
      { kind: "freeform", target_value: 20, current_value: 5, unit: "books" },
      undefined,
      "kg",
      "5 → 20 books · 25%",
    ],
  ] as const)(
    "states %s with the percent trailing",
    (_name, goal, progress, weightUnit, expected) => {
      const shown = state(
        goal as Partial<GoalProgressGoal>,
        progress as GoalProgressReading | undefined,
        weightUnit as WeightUnit
      );
      expect(`${shown.value} · ${shown.percent}`).toBe(expected);
    }
  );

  // MISSING CURRENT DATA STAYS UNKNOWN. `GoalProgress` reports `current: 0` for a
  // goal nothing has measured, and printing "0 → 58 bpm · 0%" would be a confident
  // lie about the person's health. The TARGET survives — it is real either way.
  it.each([
    ["no readings", "no-readings"],
    ["a unit the target was not captured in", "unit-mismatch"],
  ] as const)("keeps the current endpoint unknown with %s", (_name, reason) => {
    expect(
      state(
        { kind: "biomarker" },
        {
          current: 0,
          target: 100,
          pct: 0,
          unit: "mg/dL",
          unavailable: reason,
        }
      )
    ).toEqual({ value: "— → 100 mg/dL", percent: null });
  });

  it("states no percent where there are no endpoints to be a percent of", () => {
    // A freeform goal before anyone gives it a number, and a measured goal whose
    // gather produced nothing at all: both keep the plain sentence the row has
    // always shown, and neither invents a bar.
    expect(state({ kind: "freeform", current_value: 3 }, undefined)).toEqual({
      value: "In progress",
      percent: null,
    });
    expect(state({ kind: "body", body_metric: "weight" }, undefined)).toEqual({
      value: "In progress",
      percent: null,
    });
  });
});
