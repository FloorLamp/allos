import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExerciseDetailPanel from "@/components/ExerciseDetailPanel";
import type { ExerciseStat } from "@/lib/queries";

const STAT: ExerciseStat = {
  exercise: "Barbell Row",
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

describe("ExerciseDetailPanel", () => {
  it("keeps catalog tags static and the How to disclosure reachable", () => {
    const { container } = render(
      <ExerciseDetailPanel
        stat={STAT}
        bodyweightKg={null}
        units={{ weightUnit: "kg", distanceUnit: "km", temperatureUnit: "C" }}
        showTrend={false}
        showRecent={false}
        showLevel={false}
        showStrengthStandard={false}
      />
    );

    const tagBadges = Array.from(
      container.querySelectorAll("span.badge")
    ).filter(
      (badge) =>
        badge.textContent === "Mid back" || badge.textContent === "Back"
    );
    expect(tagBadges.map((badge) => badge.textContent)).toEqual([
      "Mid back",
      "Back",
    ]);
    expect(
      screen.queryByRole("button", { name: /Show .* activities/ })
    ).toBeNull();

    const disclosure = screen.getByTestId("exercise-guide-disclosure");
    expect(disclosure.querySelector("summary")?.textContent).toBe("How to");
  });
});
