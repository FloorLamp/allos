import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import IntakeContextBar from "@/components/IntakeContextBar";
import CreateAction, { useCreateActionLabel } from "@/components/CreateAction";

const DAYS = [
  { date: "2026-08-26", label: "Today" },
  { date: "2026-08-25", label: "Yesterday" },
];

function SupplementCreateControl() {
  const label = useCreateActionLabel();
  return <button type="button">{label}</button>;
}

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
  expect(heading.contains(screen.getByTestId("food-day-menu-trigger"))).toBe(
    true
  );
  expect(heading.querySelector("span.hidden.sm\\:inline")?.textContent).toBe(
    "Today"
  );
  expect(heading.contains(screen.getByTestId("food-context-label"))).toBe(true);
  expect(heading.textContent).toContain("Workout day");
  fireEvent.click(screen.getByTestId("food-day-yesterday"));
  expect(onChange).toHaveBeenCalledWith(DAYS[1].date);
  fireEvent.click(screen.getByTestId("food-preferences-open-mobile"));
  expect(onActivate).toHaveBeenCalledOnce();
});

it("keeps the supplement create in the specialized context action cell", () => {
  render(
    <IntakeContextBar
      purpose="supplement-review"
      today={DAYS[0].date}
      days={DAYS}
      value={DAYS[0].date}
      onChange={vi.fn()}
      status={{ kind: "taken", taken: 1, total: 2 }}
      createAction={
        <CreateAction kind="supplement">
          <SupplementCreateControl />
        </CreateAction>
      }
    />
  );

  const heading = screen.getByTestId("supplement-context-heading");
  expect(
    heading.contains(screen.getByTestId("supplement-day-menu-trigger"))
  ).toBe(true);
  expect(heading.querySelector("span.hidden.sm\\:inline")?.textContent).toBe(
    "Today"
  );
  const status = screen.getByTestId("supplements-status");
  const create = screen.getByRole("button", { name: "Add supplement" });
  expect(create.parentElement).toBe(status.parentElement);
  expect(status.parentElement?.children).toHaveLength(2);
});
