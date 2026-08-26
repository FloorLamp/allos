import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExerciseGuideSection from "@/components/ExerciseGuideSection";
import StandingSparkline from "@/components/dashboard/StandingSparkline";
import SupplementWeeklyAdherence from "@/components/SupplementWeeklyAdherence";

describe("visual title parity", () => {
  it("keeps the real anatomy host list-first", () => {
    render(<ExerciseGuideSection name="Back Squat" />);
    const host = screen.getByTestId("guide-muscles");
    expect(within(host).getByText(/Primary:/)).toBeTruthy();
    expect(host.textContent).toContain("Quads");
    expect(within(host).getByText(/Secondary:/)).toBeTruthy();
    expect(host.textContent).toContain("Glutes");
    expect(
      within(host).getByTestId("muscle-anatomy").querySelectorAll("title")
        .length
    ).toBeGreaterThan(0);
  });

  it("discloses every standing history point", () => {
    render(
      <StandingSparkline
        series={{
          points: [
            { date: "2026-08-25", value: 72 },
            { date: "2026-08-26", value: 73 },
          ],
          seriesKey: "metric:weight",
          stale: false,
          name: "Weight",
          pointLabel: (point) => `${point.value} kg · ${point.date}`,
          loneCaption: "One weight reading",
        }}
      />
    );
    const summary = screen.getByText("Weight history details");
    fireEvent.click(summary);
    const details = within(summary.parentElement!);
    expect(details.getByText("72 kg · 2026-08-25")).toBeTruthy();
    expect(details.getByText("73 kg · 2026-08-26")).toBeTruthy();
  });

  it("discloses exact supplement day states outside the visual strip", () => {
    render(
      <SupplementWeeklyAdherence
        days={[
          {
            date: "2026-08-25",
            due: 2,
            taken: 1,
            skipped: 0,
            isToday: false,
          },
        ]}
        labels={{ "2026-08-25": "Tuesday, August 25" }}
      />
    );
    const summary = screen.getByText("Daily details");
    fireEvent.click(summary);
    expect(
      within(summary.parentElement!).getByText(
        "Tuesday, August 25: 1 of 2 intended doses taken"
      )
    ).toBeTruthy();
  });
});
