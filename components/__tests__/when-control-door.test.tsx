import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";

// WHICH SHAPE THE PAIR TAKES (#4218).
//
// `WhenControl` has always owned the pair rules; what this file pins is the one
// COMPOSITION choice it now makes on top of them. A `state` mount that REQUIRES a
// time on a day the user may still change is stating ONE value through two fields
// and two dismissals, so those mounts render a single composed field over one
// panel holding the calendar and the wheel. Every other mount keeps the split
// fields, and that is deliberate rather than incidental: an empty time field at
// rest is the honest "no time stated", which a composed button cannot say.
//
// The four rows below are the whole decision table — the same four inputs the
// control reads (`mode`, `timeRequired`, whether the day is fixed, and the grain)
// — because a rule stated for one mount and asserted for one mount is not a rule.
//
// jsdom answers false to every media query through the tier's stand-in, so the
// panel mounts in its desktop host here. The sheet is a browser claim and lives
// in e2e/anchored-panel-fork.mobile.spec.ts.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

/** The wheel's row height and the quiet time it reads as a finished flick — the
 *  two numbers the settle case below has to outlive (components/TimeField.tsx). */
const WHEEL_CELL_PX = 44;
const SETTLE_WINDOW_MS = 500;

const DAY = "2026-08-29";
/** 19:30 in UTC on DAY — the zone every case below runs in. */
const AT = "2026-08-29T19:30:00.000Z";

function mount(
  props: Partial<Parameters<typeof WhenControl>[0]>,
  initial: WhenValue = { date: DAY, statedAt: AT }
) {
  const seen: WhenValue[] = [];
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <TimezoneProvider tz="UTC">
        <WeekStartProvider weekStart={0}>
          <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
            <WhenControl
              mode="state"
              grain="minute"
              tz="UTC"
              value={value}
              onChange={(next) => {
                seen.push(next);
                setValue(next);
              }}
              testId="w"
              {...props}
            />
          </FormatPrefsProvider>
        </WeekStartProvider>
      </TimezoneProvider>
    );
  }
  render(<Host />);
  return { seen };
}

const door = () => screen.queryByTestId("w-when");
const split = () => ({
  date: screen.queryByTestId("w-date"),
  time: screen.queryByTestId("w-time"),
});

describe("WhenControl composes one door only when the pair is one required value", () => {
  it("state + timeRequired on a movable day is ONE field", () => {
    mount({ timeRequired: true, maxDate: "2026-12-31" });
    expect(door()).toBeTruthy();
    expect(split().date).toBeNull();
    expect(split().time).toBeNull();
  });

  // THE CONVERSE, three ways. Each of these still has two boxes, and each has a
  // different reason — so a change that collapsed one of them would fail here
  // rather than passing a single "the door exists" assertion.
  it("state without timeRequired keeps the split fields and an empty time at rest", () => {
    mount({ maxDate: "2026-12-31" }, { date: DAY, statedAt: null });
    expect(door()).toBeNull();
    expect(split().date).toBeTruthy();
    expect((split().time as HTMLInputElement).value).toBe("");
  });

  it("correct mode keeps the split fields even when a time is required", () => {
    mount({ mode: "correct", timeRequired: true, maxDate: "2026-12-31" });
    expect(door()).toBeNull();
    expect(split().time).toBeTruthy();
  });

  // A FIXED DAY HAS NO DAY TO PICK — the control renders it as text — so a
  // composed field would be a picker for half of itself.
  it("a fixed day keeps the time field beside the day's text", () => {
    mount({ timeRequired: true, minDate: DAY, maxDate: DAY });
    expect(door()).toBeNull();
    expect(split().time).toBeTruthy();
  });

  // The hour grain is an enumerated offer list, not a free time input, and #4218
  // leaves it exactly where #3938 has it.
  it("the hour grain is untouched by the composition", () => {
    mount({ grain: "hour", timeRequired: true, maxDate: "2026-12-31" });
    expect(door()).toBeNull();
    expect(split().time?.tagName).toBe("SELECT");
  });
});

describe("the composed door", () => {
  // BOTH HALVES, IN THE PROFILE'S OWN SHAPES. The composed value is the only
  // thing on screen saying what the field holds, so it goes through the same
  // date and clock preferences (#964) as every other rendered time in the app —
  // which was the native time input's other defect, not just its chrome.
  it("shows both halves of the value it is standing for", () => {
    mount({ timeRequired: true, maxDate: "2026-12-31" });
    expect(door()!.textContent).toBe("Sat, 2026-08-29 \u00b7 19:30");
  });

  it("says which half is still owed when the time is empty", () => {
    mount(
      { timeRequired: true, maxDate: "2026-12-31" },
      { date: DAY, statedAt: null }
    );
    expect(door()!.textContent).toContain("add a time");
  });

  // ONE OPEN AND ONE DISMISSAL is the whole point of composing them. Picking a
  // day must NOT close the panel — the split fields' calendar closes on pick, and
  // inheriting that here would put the user back through the door for the minute
  // they came in to state.
  it("holds the calendar and the wheel together and survives a day pick", () => {
    const { seen } = mount({ timeRequired: true, maxDate: "2026-12-31" });
    fireEvent.click(door()!);
    const panel = screen.getByTestId("w-when-panel");
    expect(within(panel).getByRole("listbox", { name: "Hour" })).toBeTruthy();

    fireEvent.click(
      within(panel).getByRole("button", { name: "August 20, 2026" })
    );
    expect(seen.at(-1)!.date).toBe("2026-08-20");
    expect(screen.getByTestId("w-when-panel")).toBeTruthy();

    // The minute is stated in the SAME open, and it re-anchors onto the day just
    // chosen rather than the one the door was opened on.
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Hour" })).getByRole(
        "option",
        {
          name: "07",
        }
      )
    );
    expect(seen.at(-1)!.statedAt).toBe("2026-08-20T07:30:00.000Z");

    fireEvent.click(screen.getByTestId("w-when-done"));
    expect(screen.queryByTestId("w-when-panel")).toBeNull();
  });

  // THE PAIR SURVIVES A CLOCK WRITE THAT WAS DECIDED BEFORE THE DAY WAS (#4944).
  //
  // Every wheel column writes the WHOLE `{ date, statedAt }` pair, so a column
  // that commits a choice it made a fifth of a second ago restates the day that
  // render held — and the day the user picked in between is gone, silently, with
  // the panel repainting on the old one. The wheel's settle timer is the only
  // writer in this subtree that can reach `onChange` from a past render; this is
  // the invariant in `setDate`'s comment ("the two fields cannot come apart even
  // mid-edit") asserted against it.
  //
  // jsdom has no layout, so the column's scroll offset is stood in for. What that
  // stands in for is only WHERE the column is; what is pinned here is which
  // MOMENT the settle reads the value and the callback from, which no layout
  // affects.
  it("a wheel settle that was armed before the day pick still writes the picked day", () => {
    vi.useFakeTimers();
    try {
      const { seen } = mount({ timeRequired: true, maxDate: "2026-12-31" });
      fireEvent.click(door()!);
      const panel = screen.getByTestId("w-when-panel");
      const hour = within(panel).getByRole("listbox", { name: "Hour" });
      let top = 0;
      Object.defineProperty(hour, "scrollTop", {
        get: () => top,
        set: (next: number) => {
          top = next;
        },
        configurable: true,
      });

      // A flick leaves the column on 05 and announces it; nothing is committed
      // yet, because a wheel commits when it stops moving.
      top = 5 * WHEEL_CELL_PX;
      fireEvent.scroll(hour);

      // The day is picked while that flick is still settling.
      fireEvent.click(
        within(panel).getByRole("button", { name: "August 20, 2026" })
      );
      expect(seen.at(-1)!.date).toBe("2026-08-20");

      act(() => void vi.advanceTimersByTime(SETTLE_WINDOW_MS));

      // The flick lands — on the day that is now chosen, not the one the arming
      // render was looking at.
      expect(seen.at(-1)).toEqual({
        date: "2026-08-20",
        statedAt: "2026-08-20T05:30:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
