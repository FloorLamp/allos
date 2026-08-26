import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DateTimeFields from "@/components/activity-form/DateTimeFields";

const BASE_PROPS = {
  date: "2026-08-26",
  tz: "America/New_York",
  timeError: false,
  dateError: false,
  showSessionDuration: false,
  sessionDuration: "",
  durationDerived: false,
  durationError: false,
  derivableDurationMin: 30,
  onDate: vi.fn(),
  onStartTime: vi.fn(),
  onEndTime: vi.fn(),
  onSessionDuration: vi.fn(),
};

describe("DateTimeFields shortcut names", () => {
  it("starts each enriched accessible name with its exact visible shortcut", () => {
    const { rerender } = render(
      <DateTimeFields {...BASE_PROPS} startTime="" endTime="10:00" />
    );
    const start = screen.getByTestId("start-time-shortcut");
    expect(start.textContent).toBe("−30m");
    expect(start.getAttribute("aria-label")).toMatch(/^−30m — /);

    rerender(<DateTimeFields {...BASE_PROPS} startTime="10:00" endTime="" />);
    const end = screen.getByTestId("end-time-shortcut");
    expect(end.textContent).toBe("+30m");
    expect(end.getAttribute("aria-label")).toMatch(/^\+30m — /);
  });
});
