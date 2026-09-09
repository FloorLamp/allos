import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExerciseDetailPanel from "@/components/ExerciseDetailPanel";
import type { ExerciseStat, GoalProgress } from "@/lib/queries";
import type { OutcomeGoal } from "@/lib/types";

const STAT: ExerciseStat = {
  exercise: "Back Squat",
  equipmentId: null,
  equipment: null,
  sessions: 1,
  totalSets: 1,
  topWeightKg: 60,
  e1rmKg: 70,
  freeWeightE1rmKg: 70,
  bestWeightKg: 60,
  bestReps: 5,
  bestDate: "2026-08-24",
  topWeightDate: "2026-08-24",
  lastDate: "2026-08-24",
  lastSessionBest: null,
  lastSessionSets: [],
  lastActivityId: 1,
  bodyweight: false,
  volumeIsReps: false,
  volume: [],
};

const GOAL: OutcomeGoal = {
  id: 1,
  title: "Squat target",
  description: null,
  kind: "exercise",
  categoryLabel: null,
  target_value: null,
  current_value: null,
  unit: null,
  target_date: null,
  status: "active",
  created_at: "2026-08-24",
  achieved_at: null,
  exercise: STAT.exercise,
  metric: "weight",
  equipment_id: null,
  target_weight_kg: 100,
  target_reps: null,
  target_sets: null,
  target_duration_sec: null,
  body_metric: null,
  baseline_value: null,
  biomarker_name: null,
  target_direction: null,
  archived: 0,
};

describe("ExerciseDetailPanel", () => {
  it("keeps catalog tags and How to while withholding adult strength standing", () => {
    const { container } = render(
      <ExerciseDetailPanel
        stat={STAT}
        bodyweightKg={80}
        sex={null}
        units={{ weightUnit: "kg", distanceUnit: "km", temperatureUnit: "C" }}
        showTrend={false}
        showRecent={false}
      />
    );

    const tagBadges = Array.from(
      container.querySelectorAll("span.badge")
    ).filter(
      (badge) => badge.textContent === "Quads" || badge.textContent === "Legs"
    );
    expect(tagBadges.map((badge) => badge.textContent)).toEqual([
      "Quads",
      "Legs",
    ]);
    expect(
      screen.queryByRole("button", { name: /Show .* activities/ })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /strength standards/i })
    ).toBeNull();

    const disclosure = screen.getByTestId("exercise-guide-disclosure");
    expect(disclosure.querySelector("summary")?.textContent).toBe("How to");
  });

  it.each<{
    state: string;
    progress?: GoalProgress;
    measured: boolean;
  }>([
    { state: "absent", measured: false },
    {
      state: "unavailable",
      progress: {
        current: 0,
        target: 100,
        pct: 0,
        done: false,
        unavailable: "no-readings",
      },
      measured: false,
    },
    {
      state: "measured zero",
      progress: { current: 0, target: 100, pct: 0, done: false },
      measured: true,
    },
  ])("keeps the goal target with $state progress", ({ progress, measured }) => {
    render(
      <ExerciseDetailPanel
        stat={STAT}
        bodyweightKg={80}
        sex={null}
        units={{ weightUnit: "kg", distanceUnit: "km", temperatureUnit: "C" }}
        goals={[GOAL]}
        goalProgress={progress ? { [GOAL.id]: progress } : undefined}
        showTrend={false}
        showRecent={false}
      />
    );

    const tile = screen.getByText("Goal").closest("div")!;
    expect(
      within(tile).getByRole("link", { name: "100 kg" }).getAttribute("href")
    ).toBe("/training?tab=plan#goals");
    const percent = within(tile).queryByText("0% complete");
    const bar = tile.querySelector<HTMLElement>("div[style]");
    if (measured) {
      expect(percent).not.toBeNull();
      expect(bar?.style.width).toBe("0%");
    } else {
      expect(percent).toBeNull();
      expect(bar).toBeNull();
    }
  });
});
