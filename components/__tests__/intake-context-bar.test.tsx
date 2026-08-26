import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import IntakeContextBar from "@/components/IntakeContextBar";

const DAYS = [
  { date: "2026-08-26", label: "Today" },
  { date: "2026-08-25", label: "Yesterday" },
];

it("owns intake context, status, and semantic actions", () => {
  const onChange = vi.fn();
  const onActivate = vi.fn();
  render(
    <IntakeContextBar
      purpose="food-log"
      today={DAYS[0].date}
      days={DAYS}
      value={DAYS[0].date}
      onChange={onChange}
      context={{ label: "Morning", value: "morning" }}
      todayContext="Workout day"
      status={{ kind: "servings", count: 2 }}
      action={{ kind: "food-preferences", onActivate }}
    />
  );

  const heading = screen.getByTestId("food-context-heading");
  expect(heading.getAttribute("aria-label")).toBe(
    "Today Morning Food Log Workout day"
  );
  fireEvent.click(screen.getByTestId("food-day-yesterday"));
  expect(onChange).toHaveBeenCalledWith(DAYS[1].date);
  fireEvent.click(screen.getByTestId("food-preferences-open-mobile"));
  expect(onActivate).toHaveBeenCalledOnce();
});
