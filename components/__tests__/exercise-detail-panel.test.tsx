import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExerciseDetailPanel from "@/components/ExerciseDetailPanel";
import type { ExerciseStat } from "@/lib/queries";

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
});
