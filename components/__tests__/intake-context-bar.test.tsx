import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import IntakeContextBar from "@/components/IntakeContextBar";

const DAYS = [
  { date: "2026-08-26", label: "Today" },
  { date: "2026-08-25", label: "Yesterday" },
];

// ONE SURFACE, ONE SHAPE (#3987). The bar used to serve two purposes through a
// discriminated union — a supplement day it no longer has, and a preferences action
// that is a Manage card now. What is left is the Day header: which day, what it holds,
// and the day switcher.
it("states the day, its servings, and switches days", () => {
  const onChange = vi.fn();
  render(
    <IntakeContextBar
      today={DAYS[0].date}
      days={DAYS}
      value={DAYS[0].date}
      onChange={onChange}
      context={{ label: "Morning", value: "morning" }}
      servings={2}
    />
  );

  const heading = screen.getByTestId("food-context-heading");
  expect(heading.getAttribute("aria-label")).toBe("Today Morning Food Log");
  expect(heading.contains(screen.getByTestId("food-day-menu-trigger"))).toBe(
    true
  );
  expect(heading.querySelector("span.hidden.sm\\:inline")?.textContent).toBe(
    "Today"
  );
  expect(heading.contains(screen.getByTestId("food-context-label"))).toBe(true);
  expect(screen.getByTestId("food-day-total").textContent).toBe("2 servings");
  fireEvent.click(screen.getByTestId("food-day-yesterday"));
  expect(onChange).toHaveBeenCalledWith(DAYS[1].date);
  // The preferences icon left this bar with the modal behind it.
  expect(screen.queryByTestId("food-preferences-open")).toBeNull();
});
