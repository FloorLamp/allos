import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import OverlayDestination from "@/components/OverlayDestination";
import RecentSessions from "@/app/(app)/training/RecentSessions";
import type { RecentSessionsView } from "@/lib/training-recent-sessions";

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
});
