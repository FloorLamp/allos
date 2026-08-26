import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExerciseGuideSection from "@/components/ExerciseGuideSection";
import StandingSparkline from "@/components/dashboard/StandingSparkline";
import SupplementWeeklyAdherence from "@/components/SupplementWeeklyAdherence";
import BristolStoolPanel from "@/components/BristolStoolPanel";
import FiberSymptomPanel from "@/components/FiberSymptomPanel";
import { buildBristolPanel } from "@/lib/bristol-stool";
import { buildFiberSymptomPanel } from "@/lib/fiber-symptom-panel";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

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

  it("discloses Bristol distribution and daily values", () => {
    render(
      <BristolStoolPanel
        panel={buildBristolPanel(
          ["2026-08-25"],
          [{ date: "2026-08-25", type: 1 }]
        )}
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    );
    const summary = screen.getByText("Stool-form chart details");
    fireEvent.click(summary);
    const details = within(summary.parentElement!);
    expect(details.getByText(/^Type 1,.*: 1 of 1$/)).toBeTruthy();
    expect(details.getByText(/^Aug 25 · type 1/)).toBeTruthy();
  });

  it("discloses exact fiber and symptom daily values", () => {
    render(
      <FiberSymptomPanel
        panel={buildFiberSymptomPanel({
          dates: ["2026-08-25"],
          gramsByDate: new Map([["2026-08-25", 12]]),
          symptoms: [{ date: "2026-08-25", symptom: "bloating", severity: 2 }],
        })}
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    );
    const summary = screen.getByText("Fiber and symptom daily details");
    fireEvent.click(summary);
    expect(
      within(summary.parentElement!).getByText(/^Aug 25 · 12 g · Bloating/)
    ).toBeTruthy();
  });
});
