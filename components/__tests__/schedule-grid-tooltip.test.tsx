import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import ScheduleGrid from "@/app/(app)/immunizations/ScheduleGrid";

it("keeps a dismissed tip closed when scrolling changes the cell beneath the mouse", () => {
  render(
    <ScheduleGrid
      records={[]}
      birthdate={null}
      ageMonths={null}
      assessments={[]}
    />
  );
  const first = screen.getByRole("button", {
    name: "Details for Hepatitis B, Birth",
  });
  const next = screen.getByRole("button", {
    name: "Details for Polio (IPV), 2m",
  });
  fireEvent.click(first);
  expect(screen.getByRole("tooltip").getAttribute("data-pinned")).toBe("true");

  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.activeElement).toBe(first);
  expect(screen.queryByRole("tooltip")).toBeNull();
  // Focus scrolling can enter a different cell without moving the mouse.
  fireEvent.mouseEnter(next);
  expect(screen.queryByRole("tooltip")).toBeNull();

  fireEvent.mouseMove(next, { clientX: 200, clientY: 100 });
  expect(screen.getByRole("tooltip").textContent).toContain("Polio (IPV)");
  fireEvent.mouseLeave(screen.getByTestId("cdc-schedule-grid"));
  expect(screen.queryByRole("tooltip")).toBeNull();
});
