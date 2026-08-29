import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import MonthCalendar, {
  type MonthCalendarBinding,
} from "@/components/MonthCalendar";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";

// ONE MONTH GRID, TWO BINDINGS (#3744). DateField's picker and the sidebar's event
// calendar had each carried a complete implementation; what is tested here is the
// core they now share, at the level a caller cannot reach — the week's ordering, the
// whole-week cell count, which cells are outside the month, which day is today, which
// days a binding refuses, and what a day actually IS in each binding.
//
// The clock is frozen because "today" is a rendered state here, not an input.
const TODAY = "2026-03-15";
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterAll(() => vi.useRealTimers());

function mount(binding: MonthCalendarBinding, weekStart = 0): ReactNode {
  render(
    <TimezoneProvider tz="UTC">
      <WeekStartProvider weekStart={weekStart}>
        <MonthCalendar binding={binding} />
      </WeekStartProvider>
    </TimezoneProvider>
  );
  return null;
}

const days = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-calendar-day]"));
/** The cell whose accessible date name is this one — the name a caller cannot set. */
const day = (name: string) => screen.getByLabelText(name);
const monthOf = () =>
  (screen.getByLabelText("Month") as HTMLSelectElement).value;
const yearOf = () => (screen.getByLabelText("Year") as HTMLSelectElement).value;

const selectable = (
  over: Partial<Extract<MonthCalendarBinding, { kind: "selectable" }>> = {}
): MonthCalendarBinding => ({
  kind: "selectable",
  value: "",
  onSelect: () => {},
  ...over,
});

describe("MonthCalendar", () => {
  // The profile's first day of the week reorders the heading row AND the grid; a
  // header that moved without the cells would put every date under the wrong name.
  // The grid is WHOLE WEEKS, not a fixed 42 — March 2026 opens on a Sunday, so a
  // Sunday-start month needs no leading pad and fits in five rows while a
  // Monday-start one needs six. Both the heading row and the cells move together;
  // a header that shifted alone would put every date under the wrong name.
  it.each([
    [0, ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"], 35, "March 1, 2026"],
    [1, ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"], 42, "February 23, 2026"],
    [6, ["Sa", "Su", "Mo", "Tu", "We", "Th", "Fr"], 35, "February 28, 2026"],
  ])(
    "orders the week from day %i",
    (weekStart, headings, cellCount, firstCell) => {
      mount(selectable({ value: TODAY }), weekStart);
      expect(
        Array.from(
          document.querySelectorAll(".grid.grid-cols-7")[0].children
        ).map((el) => el.textContent)
      ).toEqual(headings);
      expect(days()).toHaveLength(cellCount);
      expect(days()[0].getAttribute("aria-label")).toBe(firstCell);
      expect(days().length % 7).toBe(0);
    }
  );

  it("marks exactly one day as today and mutes the days outside the month", () => {
    mount(selectable({ value: TODAY }));
    const current = days().filter(
      (el) => el.getAttribute("aria-current") === "date"
    );
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("aria-label")).toBe("March 15, 2026");

    // March 2026 starts on a Sunday and has 31 days, so a Sunday-start grid is 31
    // in-month cells followed by 4 from April.
    const muted = days().map((el) =>
      el.querySelector("span")!.className.includes("opacity-50")
    );
    expect(muted.filter(Boolean)).toHaveLength(4);
    expect(muted.slice(0, 31).some(Boolean)).toBe(false);
    expect(days()[31].getAttribute("aria-label")).toBe("April 1, 2026");
  });

  // A refused day is refused as a BUTTON, not merely painted as one: the paint and
  // the disabled attribute are what a mouse and a keyboard respectively obey.
  it("refuses selectable days outside min/max and reports the rest", () => {
    const onSelect = vi.fn();
    mount(
      selectable({ value: "", min: "2026-03-10", max: "2026-03-20", onSelect })
    );
    const before = day("March 9, 2026") as HTMLButtonElement;
    const inside = day("March 12, 2026") as HTMLButtonElement;
    const after = day("March 21, 2026") as HTMLButtonElement;
    expect([before.disabled, inside.disabled, after.disabled]).toEqual([
      true,
      false,
      true,
    ]);

    fireEvent.click(before);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(inside);
    expect(onSelect).toHaveBeenCalledWith("2026-03-12");
  });

  // The bounds govern NAVIGATION as well as the days — one behaviour for both
  // bindings, which is the thing two implementations could not agree on.
  it("stops navigation at the bound and crosses the year when it may", () => {
    mount(selectable({ value: "2026-12-05", min: "2026-11-01" }));
    expect([monthOf(), yearOf()]).toEqual(["11", "2026"]);

    fireEvent.click(screen.getByLabelText("Next month"));
    expect([monthOf(), yearOf()]).toEqual(["0", "2027"]);

    const previous = screen.getByLabelText(
      "Previous month"
    ) as HTMLButtonElement;
    for (let back = 0; back < 3; back++) fireEvent.click(previous);
    expect([monthOf(), yearOf()]).toEqual(["10", "2026"]);
    expect(previous.disabled).toBe(true);
    fireEvent.click(previous);
    expect([monthOf(), yearOf()]).toEqual(["10", "2026"]);
  });

  // THE CLAMP, WHICH THE ARROWS CANNOT REACH. A disabled Previous button proves the
  // bound is announced, not that a month outside it is refused — the browser simply
  // never delivers that click. A value sitting outside its own field's window does
  // reach it, and it is a real state: a bound tightened around a date already saved.
  it.each([
    ["before the window", "2026-01-05", "5", "June 1, 2026"],
    ["after the window", "2026-12-05", "7", "August 31, 2026"],
  ])(
    "clamps a value %s into it",
    (_label, value, expectedMonth, mustRender) => {
      mount(selectable({ value, min: "2026-06-01", max: "2026-08-31" }));
      expect([monthOf(), yearOf()]).toEqual([expectedMonth, "2026"]);
      expect(day(mustRender)).toBeTruthy();
      expect(screen.queryByLabelText("January 5, 2026")).toBeNull();
    }
  );

  it("opens a linked day and leaves an unlinked one inert", () => {
    const onNavigate = vi.fn();
    mount({
      kind: "linked",
      dates: ["2026-03-12"],
      href: (iso) => `/timeline?from=${iso}&to=${iso}#timeline-day-${iso}`,
      onNavigate,
    });

    const linked = day("March 12, 2026");
    expect(linked.tagName).toBe("A");
    expect(linked.getAttribute("href")).toBe(
      "/timeline?from=2026-03-12&to=2026-03-12#timeline-day-2026-03-12"
    );
    expect(within(linked).getByText("12")).toBeTruthy();

    // Every OTHER day is inert — not a disabled link, not a button: nothing to
    // press. One assertion over the whole month, so a second door cannot appear
    // unnoticed.
    expect(days().filter((el) => el.tagName === "A")).toHaveLength(1);
    expect(days().filter((el) => el.tagName === "BUTTON")).toHaveLength(0);
    expect(day("March 13, 2026").tagName).toBe("DIV");

    fireEvent.click(linked);
    expect(onNavigate).toHaveBeenCalled();
  });

  // Linked bounds are the events plus today, so the current month is always
  // reachable even when every event is in the past.
  it("bounds a linked grid by its destinations and today", () => {
    mount({
      kind: "linked",
      dates: ["2025-11-04"],
      href: (iso) => `/timeline?from=${iso}&to=${iso}#timeline-day-${iso}`,
    });
    const previous = screen.getByLabelText(
      "Previous month"
    ) as HTMLButtonElement;
    const next = screen.getByLabelText("Next month") as HTMLButtonElement;
    // It opens on today, and today is the far end.
    expect([monthOf(), yearOf()]).toEqual(["2", "2026"]);
    expect(next.disabled).toBe(true);

    for (let back = 0; back < 4; back++) fireEvent.click(previous);
    expect([monthOf(), yearOf()]).toEqual(["10", "2025"]);
    expect(previous.disabled).toBe(true);
    expect(screen.getByLabelText("November 4, 2025").tagName).toBe("A");
  });
});
