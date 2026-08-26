import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ExerciseGuideSection from "@/components/ExerciseGuideSection";
import StandingSparkline from "@/components/dashboard/StandingSparkline";
import SupplementWeeklyAdherence from "@/components/SupplementWeeklyAdherence";
import BristolStoolPanel from "@/components/BristolStoolPanel";
import FiberSymptomPanel from "@/components/FiberSymptomPanel";
import IntensityPicker from "@/components/activity-form/IntensityPicker";
import DayHistory from "@/components/DayHistory";
import TrendMiniCard from "@/components/TrendMiniCard";
import { buildBristolPanel } from "@/lib/bristol-stool";
import { buildFiberSymptomPanel } from "@/lib/fiber-symptom-panel";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import { metricDetailHref } from "@/lib/hrefs";

describe("visual title parity", () => {
  it("keeps compact trend labels in both link presentations' names", () => {
    const props = {
      title: "Resting heart rate",
      shortTitle: "RHR",
      href: metricDetailHref("resting-heart-rate"),
      data: [],
    };
    const { rerender } = render(<TrendMiniCard {...props} />);
    expect(
      screen.getByRole("link", { name: /^RHR — Resting heart rate/ })
    ).toBeTruthy();

    rerender(<TrendMiniCard {...props} compact />);
    expect(
      screen.getByRole("link", { name: /^RHR — Resting heart rate/ })
    ).toBeTruthy();
  });

  it("keeps the last day-history detail reachable after preview leaves", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const { rerender } = render(
      <DayHistory
        domain="workout"
        values={[
          { date: "2026-08-26", group: "strength", value: 1 },
          { date: "2026-08-26", group: "cardio", value: 1 },
        ]}
        groups={[
          { key: "strength", label: "Strength" },
          { key: "cardio", label: "Cardio" },
        ]}
        end="2026-08-26"
        weeks={1}
        weekStart={0}
        today="2026-08-26"
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    );
    const cell = screen
      .getAllByRole("gridcell")
      .find((candidate) =>
        candidate.getAttribute("aria-label")?.includes("Strength")
      );
    expect(cell).toBeTruthy();
    const detail = cell!.getAttribute("aria-label")!;
    fireEvent.focus(cell!);
    fireEvent.blur(cell!);

    const disclosure = screen.getByRole("button", { name: detail });
    fireEvent.click(disclosure);
    expect(screen.getByRole("tooltip").textContent).toBe(detail);

    rerender(
      <DayHistory
        domain="workout"
        values={[
          { date: "2026-08-26", group: "strength", value: 1 },
          { date: "2026-08-26", group: "cardio", value: 1 },
        ]}
        groups={[
          { key: "strength", label: "Strength" },
          { key: "cardio", label: "Cardio" },
        ]}
        end="2026-08-27"
        weeks={1}
        weekStart={0}
        today="2026-08-27"
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    );
    expect(screen.queryByRole("button", { name: detail })).toBeNull();

    const currentCell = screen
      .getAllByRole("gridcell")
      .find((candidate) =>
        candidate.getAttribute("aria-label")?.includes("Strength")
      );
    expect(currentCell).toBeTruthy();
    const currentDetail = currentCell!.getAttribute("aria-label")!;
    fireEvent.focus(currentCell!);
    fireEvent.blur(currentCell!);
    expect(screen.getByRole("button", { name: currentDetail })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Strength" }));
    expect(screen.queryByRole("button", { name: currentDetail })).toBeNull();
  });

  it("keeps intensity choices exact and discloses every hint", () => {
    render(<IntensityPicker intensity="" onChange={() => undefined} />);

    for (const label of ["Easy", "Moderate", "Hard"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }

    const disclosure = screen.getByRole("button", {
      name: /Easy:.*Moderate:.*Hard:/,
    });
    fireEvent.click(disclosure);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("Easy:");
    expect(tooltip.textContent).toContain("Moderate:");
    expect(tooltip.textContent).toContain("Hard:");
  });

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
