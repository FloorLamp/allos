import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import OverlayDestination from "@/components/OverlayDestination";
import VisualizationDetails from "@/components/VisualizationDetails";
import RecentSessions from "@/app/(app)/training/RecentSessions";
import ProtocolList from "@/app/(app)/protocols/ProtocolList";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import type { RecentSessionsView } from "@/lib/training-recent-sessions";
import type { Protocol } from "@/lib/types";

describe("OverlayDestination", () => {
  it("keeps a full-surface destination and detail control as siblings", () => {
    render(
      <OverlayDestination href="/data" label="Open data">
        <p>Last sync</p>
        <InfoTooltipIcon label="Aug 26, 2026 at 10:00 AM" />
      </OverlayDestination>
    );

    const destination = screen.getByRole("link", { name: "Open data" });
    const detail = screen.getByRole("button", {
      name: "Aug 26, 2026 at 10:00 AM",
    });
    expect(destination.contains(detail)).toBe(false);
    expect(
      destination.parentElement
        ?.querySelector("[data-overlay-destination-content]")
        ?.contains(detail)
    ).toBe(true);
  });

  it("lets a visualization disclosure intercept the overlay destination", () => {
    render(
      <OverlayDestination href="/data" label="Open protocol">
        <VisualizationDetails
          label="Protocol activity daily details"
          items={["2026-08-26 — 1 session"]}
        />
      </OverlayDestination>
    );
    const destination = screen.getByRole("link", { name: "Open protocol" });
    const summary = screen.getByText("Protocol activity daily details");
    expect(destination.contains(summary)).toBe(false);
    expect(summary.classList.contains("pointer-events-auto")).toBe(true);
    expect(
      summary.closest("details")?.classList.contains("pointer-events-none")
    ).toBe(true);
    fireEvent.click(summary);
    const details = summary.closest("details")!;
    expect(details.hasAttribute("open")).toBe(true);
    const item = within(details).getByText("2026-08-26 — 1 session");
    expect(item.closest("ul")?.classList.contains("pointer-events-auto")).toBe(
      true
    );
    fireEvent.click(item);
    expect(window.location.pathname).toBe("/");
  });

  it("keeps a recent-session zone disclosure outside its whole-header link", () => {
    const view = {
      scope: "week",
      more: 0,
      rows: [
        {
          id: 1,
          href: "/training/activity/1",
          dayLabel: "Today",
          parts: [],
          moreParts: 0,
          card: {
            activity: {
              id: 1,
              type: "cardio",
              title: "Threshold run",
              components: null,
              intensity: null,
              heart_rate_zone: 3,
            },
            timeText: null,
            durationText: "30 min",
            distanceText: null,
            speedText: null,
            heartRateText: "♥ 150 bpm",
            calorieText: null,
          },
        },
      ],
    } as unknown as RecentSessionsView;
    render(<RecentSessions view={view} />);
    const destination = screen.getByRole("link", {
      name: "Open Threshold run session",
    });
    const detail = within(screen.getByTestId("recent-session-meta")).getByRole(
      "button"
    );
    expect(destination.contains(detail)).toBe(false);
    fireEvent.click(detail);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("keeps protocol daily details outside its whole-card link", () => {
    render(
      <ProtocolList
        items={
          [
            {
              id: 1,
              name: "Sleep experiment",
              start_date: "2026-08-26",
              end_date: null,
              outcomeKeys: [],
            },
            {
              id: 2,
              name: "Hydration experiment",
              start_date: "2026-08-26",
              end_date: null,
              outcomeKeys: [],
            },
          ] as unknown as Protocol[]
        }
        heatmaps={{
          1: {
            start: "2026-08-26",
            end: "2026-08-26",
            visibleStart: "2026-08-26",
            truncated: false,
            totalSessions: 1,
            activeDays: 1,
            columns: [
              [
                {
                  date: "2026-08-26",
                  count: 1,
                  level: 1,
                  outside: false,
                },
              ],
            ],
          },
          2: {
            start: "2026-08-26",
            end: "2026-08-26",
            visibleStart: "2026-08-26",
            truncated: false,
            totalSessions: 0,
            activeDays: 0,
            columns: [
              [
                {
                  date: "2026-08-26",
                  count: 0,
                  level: 0,
                  outside: false,
                },
              ],
            ],
          },
        }}
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    );
    const destination = screen.getByRole("link", {
      name: "Open Sleep experiment protocol",
    });
    const summary = screen.getByText(
      "Sleep experiment protocol activity daily details"
    );
    expect(
      screen.getByText("Hydration experiment protocol activity daily details")
    ).toBeTruthy();
    expect(destination.contains(summary)).toBe(false);
    expect(summary.closest('[role="img"]')).toBeNull();
    fireEvent.click(summary);
    expect(summary.closest("details")?.hasAttribute("open")).toBe(true);
    expect(window.location.pathname).toBe("/");
  });
});
