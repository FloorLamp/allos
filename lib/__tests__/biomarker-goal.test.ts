import { describe, it, expect } from "vitest";
import {
  biomarkerGoalCheckIn,
  biomarkerGoalCheckInText,
  biomarkerGoalCurrentText,
  biomarkerGoalTargetText,
  biomarkerTargetOf,
  computeBiomarkerGoalProgress,
  directionMet,
  isBiomarkerGoal,
  labGoalHasCheckedIn,
  type BiomarkerGoalTarget,
} from "../biomarker-goal";
import { goalPaceTone, isOutcomeGoalDirection } from "../outcome-goals";
import { OUTCOME_GOAL_DIRECTIONS, type OutcomeGoal } from "../types";

// PURE TIER — biomarker goals (#1853). No DB: every input here is a series the
// query layer already gathered.

function target(over: Partial<BiomarkerGoalTarget> = {}): BiomarkerGoalTarget {
  return {
    name: "LDL Cholesterol",
    value: 100,
    unit: "mg/dL",
    direction: "below",
    baselineValue: 160,
    ...over,
  };
}

function goal(over: Partial<OutcomeGoal> = {}): OutcomeGoal {
  return {
    id: 1,
    title: "LDL under 100",
    description: null,
    kind: "biomarker",
    categoryLabel: null,
    target_value: 100,
    current_value: null,
    unit: "mg/dL",
    target_date: "2026-06-01",
    status: "active",
    created_at: "2026-01-01 08:00:00",
    exercise: null,
    metric: null,
    equipment_id: null,
    target_weight_kg: null,
    target_reps: null,
    target_sets: null,
    target_duration_sec: null,
    body_metric: null,
    baseline_value: 160,
    biomarker_name: "LDL Cholesterol",
    target_direction: "below",
    archived: 0,
    ...over,
  };
}

describe("isBiomarkerGoal — both halves or neither", () => {
  it("needs an analyte AND a direction", () => {
    expect(isBiomarkerGoal(goal())).toBe(true);
    expect(isBiomarkerGoal(goal({ target_direction: null }))).toBe(false);
    expect(isBiomarkerGoal(goal({ biomarker_name: null }))).toBe(false);
    // A whitespace-only name names nothing.
    expect(isBiomarkerGoal(goal({ biomarker_name: "   " }))).toBe(false);
  });

  it("leaves the three existing goal shapes alone", () => {
    expect(
      isBiomarkerGoal(goal({ biomarker_name: null, target_direction: null }))
    ).toBe(false);
  });
});

describe("directionMet — the declared side of the number", () => {
  it("is inclusive at the target on both sides", () => {
    expect(directionMet("below", 100, 100)).toBe(true);
    expect(directionMet("above", 100, 100)).toBe(true);
  });

  it("reads opposite ways for the same numbers", () => {
    expect(directionMet("below", 92, 100)).toBe(true);
    expect(directionMet("above", 92, 100)).toBe(false);
    expect(directionMet("below", 128, 100)).toBe(false);
    expect(directionMet("above", 128, 100)).toBe(true);
  });
});

describe("isOutcomeGoalDirection — single-sourced from OUTCOME_GOAL_DIRECTIONS", () => {
  it("accepts exactly the declared vocabulary", () => {
    for (const d of OUTCOME_GOAL_DIRECTIONS)
      expect(isOutcomeGoalDirection(d)).toBe(true);
    expect(OUTCOME_GOAL_DIRECTIONS).toEqual(["below", "above"]);
    expect(isOutcomeGoalDirection("under")).toBe(false);
    expect(isOutcomeGoalDirection(null)).toBe(false);
  });
});

describe("computeBiomarkerGoalProgress — the latest result, not the best one", () => {
  const series = [
    { date: "2026-01-05", value: 160 },
    { date: "2026-03-05", value: 118 },
    { date: "2026-05-05", value: 130 },
  ];

  it("measures the LATEST reading — a lab value is a state, not a PR", () => {
    const p = computeBiomarkerGoalProgress(target(), series, "mg/dL");
    expect(p.current).toBe(130);
    expect(p.asOf).toBe("2026-05-05");
    // 160 → 100 is the span; 130 is halfway.
    expect(p.pct).toBe(50);
    expect(p.done).toBe(false);
    expect(p.unavailable).toBeNull();
  });

  it("completes on the DECLARED direction, not on pct", () => {
    const p = computeBiomarkerGoalProgress(
      target({ baselineValue: null }),
      [{ date: "2026-05-05", value: 92 }],
      "mg/dL"
    );
    // No baseline, so there is no meaningful bar — but "under 100" is satisfied.
    expect(p.done).toBe(true);
    expect(p.current).toBe(92);
  });

  it("an ABOVE goal completes going up", () => {
    const p = computeBiomarkerGoalProgress(
      target({
        name: "Vitamin D, 25-Hydroxy",
        value: 40,
        unit: "ng/mL",
        direction: "above",
        baselineValue: 18,
      }),
      [{ date: "2026-05-05", value: 44 }],
      "ng/mL"
    );
    expect(p.done).toBe(true);
    expect(p.pct).toBe(100);
  });

  it("says so rather than guessing when nothing has been measured", () => {
    const p = computeBiomarkerGoalProgress(target(), [], "mg/dL");
    expect(p.unavailable).toBe("no-readings");
    expect(p.asOf).toBeNull();
    expect(p.done).toBe(false);
    expect(p.pct).toBe(0);
  });

  it("refuses to compare across units instead of rendering a confident lie", () => {
    // 2.6 mmol/L IS about 100 mg/dL, but nothing here knows that — comparing the
    // numbers would report a wildly-met goal.
    const p = computeBiomarkerGoalProgress(
      target(),
      [{ date: "2026-05-05", value: 2.6 }],
      "mmol/L"
    );
    expect(p.unavailable).toBe("unit-mismatch");
    expect(p.done).toBe(false);
    expect(p.unit).toBe("mg/dL");
  });

  it("a unitless series is not a mismatch (sameUnit's permissive null)", () => {
    const p = computeBiomarkerGoalProgress(
      target({ unit: null }),
      [{ date: "2026-05-05", value: 92 }],
      null
    );
    expect(p.unavailable).toBeNull();
    expect(p.done).toBe(true);
  });
});

describe("biomarkerTargetOf — one place the column tuple is read", () => {
  it("reads a well-formed row", () => {
    expect(biomarkerTargetOf(goal())).toEqual({
      name: "LDL Cholesterol",
      value: 100,
      unit: "mg/dL",
      direction: "below",
      baselineValue: 160,
    });
  });

  it("is null for every non-biomarker goal shape", () => {
    expect(biomarkerTargetOf(goal({ target_direction: null }))).toBeNull();
    expect(biomarkerTargetOf(goal({ target_value: null }))).toBeNull();
    expect(
      biomarkerTargetOf(
        goal({
          biomarker_name: null,
          target_direction: null,
          body_metric: "weight",
        })
      )
    ).toBeNull();
  });
});

describe("the check-in rhythm — a lab goal advances per RESULT", () => {
  it("takes the analyte's curated cadence through the shared selector", () => {
    // HbA1c's 90-day cadence: the next draw is 90 days after the last result.
    const c = biomarkerGoalCheckIn("2026-03-01", 90, "2026-04-01");
    expect(c.cadenceDays).toBe(90);
    expect(c.dueDate).toBe("2026-05-30");
    expect(c.due).toBe(false);
    expect(c.daysSinceResult).toBe(31);
  });

  it("falls back to the flat default for an uncurated analyte", () => {
    expect(
      biomarkerGoalCheckIn("2026-03-01", null, "2026-04-01").cadenceDays
    ).toBe(365);
    // A nonsense cadence falls back rather than producing a same-day clock.
    expect(
      biomarkerGoalCheckIn("2026-03-01", 0, "2026-04-01").cadenceDays
    ).toBe(365);
  });

  it("is due once the cadence has elapsed", () => {
    expect(biomarkerGoalCheckIn("2026-01-01", 90, "2026-04-01").due).toBe(true);
  });

  it("has no due DATE at all before the first result", () => {
    // Inventing "today + cadence" would put a goal set years ago permanently one
    // cadence in the future.
    const c = biomarkerGoalCheckIn(null, 90, "2026-04-01");
    expect(c.dueDate).toBeNull();
    expect(c.due).toBe(true);
    expect(c.daysSinceResult).toBeNull();
  });
});

describe("labGoalHasCheckedIn — the evidence gate on the verdict", () => {
  it("needs a result AT OR AFTER the goal was created", () => {
    expect(labGoalHasCheckedIn("2026-01-01 08:00:00", "2026-03-05")).toBe(true);
    expect(labGoalHasCheckedIn("2026-01-01 08:00:00", "2026-01-01")).toBe(true);
    // The pre-existing result the user set the goal against is not a check-IN.
    expect(labGoalHasCheckedIn("2026-01-01 08:00:00", "2025-11-20")).toBe(
      false
    );
    expect(labGoalHasCheckedIn("2026-01-01 08:00:00", null)).toBe(false);
  });
});

describe("goalPaceTone — per-result pacing vs the daily model (#1853)", () => {
  // One goal, one progress figure, one calendar. The ONLY difference is whether the
  // quantity advances daily or per result.
  const opts = {
    createdAt: "2026-01-01",
    targetDate: "2026-07-01",
    today: "2026-04-01",
  };

  it("the DAILY model calls this behind — 50% of the window, 10% of the way", () => {
    expect(goalPaceTone(10, opts)).toBe("behind");
  });

  it("the PER-RESULT model does not, because nothing has been measured since", () => {
    // Same day, same 10%. The last result landed on Jan 15, two weeks in, so the
    // owed line is frozen there: 8% owed, 10% delivered.
    expect(goalPaceTone(10, { ...opts, evidenceDate: "2026-01-15" })).toBe(
      "on-pace"
    );
  });

  it("a fresh result CAN move it to behind — the verdict advances on evidence", () => {
    expect(goalPaceTone(10, { ...opts, evidenceDate: "2026-04-01" })).toBe(
      "behind"
    );
  });

  it("no result yet is never behind", () => {
    expect(goalPaceTone(0, { ...opts, evidenceDate: null })).toBe("on-pace");
  });

  it("a passed deadline still fails — that is a fact about the calendar", () => {
    expect(
      goalPaceTone(40, {
        createdAt: "2026-01-01",
        targetDate: "2026-03-01",
        today: "2026-04-01",
        evidenceDate: "2026-01-15",
      })
    ).toBe("failed");
  });

  it("a met goal is met in both models", () => {
    expect(goalPaceTone(100, opts)).toBe("met");
    expect(goalPaceTone(100, { ...opts, evidenceDate: null })).toBe("met");
  });

  it("omitting evidenceDate leaves every existing caller byte-identical", () => {
    // The daily verdicts the body/exercise goals already render.
    expect(goalPaceTone(60, opts)).toBe("on-pace");
    expect(goalPaceTone(10, { ...opts, targetDate: null })).toBe("on-pace");
  });
});

describe("formatters — one phrase per state", () => {
  it("states the target with its direction word and unit", () => {
    expect(biomarkerGoalTargetText(goal())).toBe(
      "LDL Cholesterol under 100 mg/dL"
    );
    expect(
      biomarkerGoalTargetText(
        goal({
          biomarker_name: "Vitamin D, 25-Hydroxy",
          target_direction: "above",
          target_value: 40,
          unit: "ng/mL",
        })
      )
    ).toBe("Vitamin D, 25-Hydroxy over 40 ng/mL");
  });

  it("is null for a goal that is not a biomarker goal", () => {
    expect(
      biomarkerGoalTargetText(goal({ target_direction: null }))
    ).toBeNull();
  });

  it("names the unavailable states instead of printing a bare 0", () => {
    expect(
      biomarkerGoalCurrentText({
        current: 0,
        target: 100,
        pct: 0,
        done: false,
        unavailable: "no-readings",
      })
    ).toBe("No result yet");
    expect(
      biomarkerGoalCurrentText({
        current: 0,
        target: 100,
        pct: 0,
        done: false,
        unavailable: "unit-mismatch",
      })
    ).toBe("Units changed — re-set this target");
    expect(biomarkerGoalCurrentText(undefined)).toBe("—");
    expect(
      biomarkerGoalCurrentText({
        current: 118,
        target: 100,
        pct: 70,
        done: false,
        unit: "mg/dL",
        unavailable: null,
      })
    ).toBe("118 mg/dL now");
  });

  it("says when the next result is expected, not a recomputed verdict", () => {
    const iso = (d: string) => d;
    expect(
      biomarkerGoalCheckInText(
        biomarkerGoalCheckIn("2026-03-01", 90, "2026-04-01"),
        iso
      )
    ).toBe("Next result due 2026-05-30");
    expect(
      biomarkerGoalCheckInText(
        biomarkerGoalCheckIn("2026-01-01", 90, "2026-06-01"),
        iso
      )
    ).toBe("Next result due now — retested every 90 days");
    expect(
      biomarkerGoalCheckInText(
        biomarkerGoalCheckIn(null, 90, "2026-06-01"),
        iso
      )
    ).toBe("Awaiting a first result — retested every 90 days");
  });
});
