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
import ActivityPartRows from "@/components/activity/ActivityPartRows";
import { buildBristolPanel } from "@/lib/bristol-stool";
import { buildFiberSymptomPanel } from "@/lib/fiber-symptom-panel";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import { metricDetailHref, strengthAnalyzeHref } from "@/lib/hrefs";

describe("visual title parity", () => {
  it("combines a strength row's explanations behind one disclosure", () => {
    render(
      <ActivityPartRows
        parts={[
          {
            kind: "strength",
            name: "Bench Press",
            muscle: "Chest",
            text: "3 × 5 at 60 kg",
            status: "met",
          },
        ]}
        partDeltas={[
          {
            direction: "up",
            label: "+5 kg",
            title: "Top set up 5 kg vs last time",
          },
        ]}
        partRecords={[
          {
            e1rm: "all-time",
            weight: null,
            href: strengthAnalyzeHref("Bench Press"),
          },
        ]}
      />
    );

    expect(screen.getByText(/\+5 kg/)).toBeTruthy();
    expect(screen.getByText("All-time PR")).toBeTruthy();
    expect(screen.getByText("Target met")).toBeTruthy();
    const disclosure = screen.getByTestId("exercise-row-info");
    expect(screen.getAllByTestId("exercise-row-info")).toHaveLength(1);
    expect(disclosure.getAttribute("aria-label")).toBe(
      "Top set up 5 kg vs last time · Still your all-time estimated 1RM record. · All sets hit their target reps"
    );
    fireEvent.click(disclosure);
    expect(screen.getByRole("tooltip").textContent).toBe(
      disclosure.getAttribute("aria-label")
    );
  });

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
    const values = [
      { date: "2026-08-26", group: "strength", value: 1 },
      { date: "2026-08-26", group: "cardio", value: 1 },
    ];
    const groups = [
      { key: "strength", label: "Strength" },
      { key: "cardio", label: "Cardio" },
    ];
    const { rerender } = render(
      <DayHistory
        domain="workout"
        values={values}
        groups={groups}
        end="2026-08-26"
        weeks={1}
        weekStart={0}
        today="2026-08-26"
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    );
    const aggregate = screen.getByRole("button", {
      name: /August 26, 2026 — 2 sessions.*today/,
    });
    const detail = aggregate.getAttribute("aria-label")!;
    fireEvent.focus(aggregate);
    fireEvent.blur(aggregate);

    const disclosure = within(
      screen.getByTestId("day-history-matrix-header")
    ).getByRole("button", { name: detail });
    fireEvent.click(disclosure);
    expect(screen.getByRole("tooltip").textContent).toBe(detail);

    // The same semantic owner re-derives its current format/today wording.
    rerender(
      <DayHistory
        domain="workout"
        values={values}
        groups={groups}
        end="2026-08-26"
        weeks={1}
        weekStart={0}
        today="2026-08-27"
        formatPrefs={{ ...DEFAULT_FORMAT_PREFS, dateFormat: "dmy" }}
      />
    );
    const updatedDetail = "Wednesday, 26 August 2026 — 2 sessions";
    const header = within(screen.getByTestId("day-history-matrix-header"));
    expect(header.queryByRole("button", { name: detail })).toBeNull();
    expect(header.getByRole("button", { name: updatedDetail })).toBeTruthy();

    const currentCell = screen
      .getAllByRole("gridcell")
      .find((candidate) =>
        candidate.getAttribute("aria-label")?.includes("Strength")
      );
    expect(currentCell).toBeTruthy();
    const currentDetail = currentCell!.getAttribute("aria-label")!;
    fireEvent.focus(currentCell!);
    fireEvent.blur(currentCell!);
    expect(header.getByRole("button", { name: currentDetail })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Strength" }));
    expect(header.queryByRole("button", { name: currentDetail })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Strength" }));
    expect(header.queryByRole("button", { name: currentDetail })).toBeNull();

    const restoredCell = screen
      .getAllByRole("gridcell")
      .find((candidate) =>
        candidate.getAttribute("aria-label")?.includes("Strength")
      );
    expect(restoredCell).toBeTruthy();
    const restoredDetail = restoredCell!.getAttribute("aria-label")!;
    fireEvent.focus(restoredCell!);
    fireEvent.blur(restoredCell!);
    expect(header.getByRole("button", { name: restoredDetail })).toBeTruthy();

    // Moving the window beyond the owner removes it rather than resurrecting it
    // if the old window later returns.
    rerender(
      <DayHistory
        domain="workout"
        values={values}
        groups={groups}
        end="2026-09-10"
        weeks={1}
        weekStart={0}
        today="2026-09-10"
        formatPrefs={{ ...DEFAULT_FORMAT_PREFS, dateFormat: "dmy" }}
      />
    );
    expect(screen.queryByRole("button", { name: restoredDetail })).toBeNull();
  });

  it("does not retarget day-cell disclosures to a week with the same date", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const props = {
      domain: "workout" as const,
      values: [{ date: "2026-08-23", group: "strength", value: 1 }],
      groups: [{ key: "strength", label: "Strength" }],
      end: "2026-08-23",
      weeks: 1,
      weekStart: 0,
      today: "2026-08-23",
      formatPrefs: DEFAULT_FORMAT_PREFS,
    };
    const { rerender } = render(<DayHistory {...props} grain="day" />);
    const header = () =>
      within(screen.getByTestId("day-history-matrix-header"));

    const aggregate = screen.getByRole("button", {
      name: /Sunday, August 23, 2026 — 1 session.*today/,
    });
    fireEvent.focus(aggregate);
    fireEvent.blur(aggregate);
    expect(header().getByRole("button")).toBeTruthy();

    rerender(<DayHistory {...props} grain="week" />);
    expect(header().queryByRole("button")).toBeNull();
    rerender(<DayHistory {...props} grain="day" />);
    expect(header().queryByRole("button")).toBeNull();

    const matrixCell = screen.getByRole("gridcell", {
      name: /Strength · Sunday, August 23, 2026 — 1 session/,
    });
    fireEvent.focus(matrixCell);
    fireEvent.blur(matrixCell);
    expect(header().getByRole("button")).toBeTruthy();

    rerender(<DayHistory {...props} grain="week" />);
    expect(header().queryByRole("button")).toBeNull();
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
