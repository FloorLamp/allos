import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import IntakeContextBar from "@/components/IntakeContextBar";

const DAYS = [
  { date: "2026-08-26", label: "Today" },
  { date: "2026-08-25", label: "Yesterday" },
];

function SupplementBar() {
  const [date, setDate] = useState(DAYS[0].date);
  return (
    <IntakeContextBar
      purpose="supplement-review"
      today={DAYS[0].date}
      days={DAYS}
      value={date}
      onChange={setDate}
      context={{ label: "Morning", value: "morning" }}
      todayContext="Workout day"
      status={{ kind: "taken", taken: 1, total: 2 }}
    />
  );
}

it("owns responsive intake context, status, and day selection", () => {
  render(<SupplementBar />);

  expect(
    screen.getByRole("heading", {
      name: "Today Morning Supplements Workout day",
    })
  ).toBeTruthy();
  fireEvent.click(screen.getByTestId("supplement-day-yesterday"));
  expect(
    screen.getByRole("heading", { name: "Yesterday Morning Supplements" })
  ).toBeTruthy();
});
