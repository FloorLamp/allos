import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { isRealIsoDate } from "@/lib/date";
import type { LocalDay } from "@/lib/temporal-types";
import type { TimeFormat } from "@/lib/format-date";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";

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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

// A DAY LITERAL IS NOT A `LocalDay` (#5105's cast ban, reached by #5489's branding of
// `WhenValue.date`): the fixture mints one through the validating minter, exactly as
// lib/__tests__/clock-seam.test.ts does.
const day = (value: string): LocalDay => {
  if (!isRealIsoDate(value)) throw new Error(`not a day: ${value}`);
  return value;
};

const DAY = day("2026-08-29");
/** 19:30 in UTC on DAY — the zone every case below runs in. */
const AT = "2026-08-29T19:30:00.000Z";

function mount(
  props: Partial<Parameters<typeof WhenControl>[0]>,
  initial: WhenValue = { date: DAY, statedAt: AT },
  timeFormat: TimeFormat = "24h"
) {
  const seen: WhenValue[] = [];
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <TimezoneProvider tz="UTC">
        <WeekStartProvider weekStart={0}>
          <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat }}>
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

describe("opening proposals in both time-picker hosts", () => {
  it.each([
    [true, "24h", "14"],
    [true, "12h", "02"],
    [false, "24h", "14"],
    [false, "12h", "02"],
  ] as const)(
    "required=%s, %s uses the explicit subject zone and retains the chosen day",
    (timeRequired, timeFormat, hour) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-09T00:37:00Z"));
      const { seen } = mount(
        { timeRequired, tz: "Pacific/Honolulu", maxDate: "2026-12-31" },
        { date: DAY, statedAt: null },
        timeFormat
      );
      fireEvent.click(
        timeRequired
          ? door()!
          : screen.getByRole("button", { name: "Open time picker" })
      );
      const hours = screen.getByRole("listbox", { name: "Hour" });
      const minutes = screen.getByRole("listbox", { name: "Minute" });
      expect(
        document.getElementById(hours.getAttribute("aria-activedescendant")!)
          ?.textContent
      ).toBe(hour);
      expect(
        document.getElementById(minutes.getAttribute("aria-activedescendant")!)
          ?.textContent
      ).toBe("37");
      for (const column of screen.getAllByRole("listbox", {
        name: /^(Hour|Minute|AM or PM)$/,
      })) {
        expect(
          within(column).queryAllByRole("option", { selected: true })
        ).toHaveLength(0);
      }
      expect(seen).toEqual([]);
      fireEvent.click(within(hours).getByRole("option", { name: hour }));
      expect(seen.at(-1)).toEqual({
        date: DAY,
        statedAt: "2026-08-30T00:37:00.000Z",
      });
    }
  );
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

  // THE CLOCK MUST NOT WRITE OVER THE DAY PICK (#4940). The wheel does not commit
  // on the gesture — `WheelColumn` reads a flick's resting place on a ~120ms
  // settle timer (components/TimeField.tsx) — so a column scrolled before the
  // calendar is touched fires its commit AFTER the day pick. Both halves are in
  // the same panel and picking a day deliberately keeps it open, so this ordering
  // is one ordinary gesture apart, and the commit rebuilds the whole pair.
  //
  // THE FIXTURE REACHES THE FORBIDDEN STATE ON PURPOSE: the scroll is fired first
  // so a settle is genuinely pending, and the day is picked inside its window.
  // Against a handler closed over the render's `value` this reads 2026-08-29 —
  // the day the wheel was scrolled on, put back over the one just chosen.
  it("a wheel commit that lands after a day pick carries the picked day", async () => {
    const { seen } = mount({ timeRequired: true, maxDate: "2026-12-31" });
    fireEvent.click(door()!);
    const panel = screen.getByTestId("w-when-panel");

    // A flick still in the air: the column rests fifteen rows from its value and
    // its settle has not fired.
    const minutes = within(panel).getByRole("listbox", { name: "Minute" });
    const row = within(minutes).getByRole("option", { name: "45" });
    fireEvent.wheel(minutes, { deltaY: 44 });
    minutes.scrollTop = (Array.from(minutes.children).indexOf(row) - 1) * 44;
    fireEvent.scroll(minutes);

    // ...and inside that window the user picks a day.
    fireEvent.click(
      within(panel).getByRole("button", { name: "August 20, 2026" })
    );
    expect(seen.at(-1)!.date).toBe("2026-08-20");

    // Now the settle lands. It owns the MINUTE and nothing else.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(seen.at(-1)!.date).toBe("2026-08-20");
    expect(seen.at(-1)!.statedAt).toBe("2026-08-20T19:45:00.000Z");
  });
});

// ── WHAT A FIXED DAY SAYS (#5489 fix 3) ──────────────────────────────────────
//
// A fixed day renders as TEXT, and the text used to be `value.date === today ?
// "Today" : value.date` — the clock asked, and a storage day printed whenever the
// answer was no. One card then showed `Yesterday` on its toggle and `2026-09-06` in
// the temperature fold 130px below it.
//
// FOUR HOSTS MOUNT THIS ARM, NOT ONE, and they mount it four different ways — that is
// the whole shape of the defect (#5105's ruling reached five sites and this arm was
// outside them; four sites flattened the same way is what lets three get fixed and one
// get missed). So the claim is made once per host CONFIGURATION rather than once for a
// representative: the cockpit's fold and the collapsed statement stand inside a day
// context and must speak the card's own words, while the two nutrition hosts stand on
// their surface's single day and must speak the login's date shape. None may print a
// storage day.
const STORAGE_DAY = /^\d{4}-\d{2}-\d{2}$/;

function fixedDayText(
  props: Partial<Parameters<typeof WhenControl>[0]>,
  on: LocalDay,
  card?: { date: LocalDay; altDate?: LocalDay; label?: string }
): string {
  const seen: WhenValue[] = [];
  function Host() {
    const [value, setValue] = useState<WhenValue>({ date: on, statedAt: null });
    const control = (
      <WhenControl
        mode="state"
        grain="minute"
        tz="UTC"
        value={value}
        onChange={(next) => {
          seen.push(next);
          setValue(next);
        }}
        minDate={on}
        maxDate={on}
        testId="w"
        {...props}
      />
    );
    return (
      <TimezoneProvider tz="UTC">
        <WeekStartProvider weekStart={0}>
          <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
            {card ? (
              <CockpitDayProvider
                date={card.date}
                altDate={card.altDate}
                dateLabel={card.label}
                tz="UTC"
              >
                {control}
              </CockpitDayProvider>
            ) : (
              control
            )}
          </FormatPrefsProvider>
        </WeekStartProvider>
      </TimezoneProvider>
    );
  }
  render(<Host />);
  return screen.getByTestId("w-date").textContent ?? "";
}

describe("the fixed-day arm speaks the surface's words, never a storage day (#5489)", () => {
  const TODAY = day(new Date().toISOString().slice(0, 10));
  const YESTERDAY = day(
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  );

  // components/illness/SymptomLogBar.tsx — the temperature fold. Minute grain, and the
  // minute is REQUIRED on a day that has ended (#4685), which is the arm that survived
  // the composed-door split. Inside the cockpit's day context, standing on the alt day:
  // it must say what the toggle beside it says.
  it("the illness temperature fold says the card's alt-day words", () => {
    expect(
      fixedDayText({ timeRequired: true }, YESTERDAY, {
        date: TODAY,
        altDate: YESTERDAY,
      })
    ).toBe("Yesterday");
  });

  // components/TimeStatement.tsx — the collapsed statement every dose row opens. Same
  // day context, standing on the card's primary day.
  it("the collapsed time statement says the card's primary-day words", () => {
    expect(fixedDayText({}, TODAY, { date: TODAY, altDate: YESTERDAY })).toBe(
      "Today"
    );
  });

  // app/(app)/nutrition/DayLedger.tsx — the batch "Set time…" sheet. Minute grain with
  // a required time, and NO day context: the ledger is a single-day surface, so the day
  // renders through the login's own date shape rather than through a card's words.
  it("the day ledger's batch sheet renders the login's date shape", () => {
    const text = fixedDayText({ timeRequired: true }, YESTERDAY);
    expect(text).not.toMatch(STORAGE_DAY);
    expect(text).toContain(YESTERDAY);
  });

  // app/(app)/nutrition/FoodLogBar.tsx — the eating-time fold. The HOUR grain, which is
  // a different branch of this control entirely, and the one a fix aimed at the minute
  // grain would miss.
  it("the food bar's eating-time fold renders the login's date shape", () => {
    const text = fixedDayText({ grain: "hour" }, YESTERDAY);
    expect(text).not.toMatch(STORAGE_DAY);
    expect(text).toContain(YESTERDAY);
  });

  // AND TODAY IS STILL "Today" OUTSIDE A CARD — the one word the old expression got
  // right, kept, so this is a fix to the fallback rather than a replacement of the copy.
  it("says Today on today with no day context", () => {
    expect(fixedDayText({}, TODAY)).toBe("Today");
  });

  // ONE DECLARED WIDTH ACROSS BOTH ARMS (#5490 site 1). The picker arm declared `w-36`
  // and this one declared nothing, so the slot was content-sized in one arm and fixed
  // in the other — and switching a card's day changed this control's width by ~35px,
  // which `flex-1` then spent on whatever sat beside it.
  it("declares the same slot width as the picker arm", () => {
    const fixed = fixedDayText({}, TODAY);
    expect(fixed).toBe("Today");
    const text = screen.getByTestId("w-date").className;
    cleanup();
    mount({ maxDate: "2026-12-31" }, { date: DAY, statedAt: null });
    const picker = screen.getByTestId("w-date").className;
    for (const declared of ["h-8", "w-36", "text-sm"]) {
      expect(text, `fixed-day arm: ${text}`).toContain(declared);
      expect(picker, `picker arm: ${picker}`).toContain(declared);
    }
  });
});

// MANUAL ISO ENTRY STILL WORKS ON A MOVABLE DAY (#3376's invariant, kept while
// `WhenValue.date` became `LocalDay`). `DateField` is a TEXT input by design, so it
// emits every keystroke — and a half-typed "2026-09-0" is not a day. A control that
// simply refused those emits would leave the parent's value unchanged and React would
// restore the box to the old date after each character, so the field could only ever
// be changed by the calendar. The draft is held beside the pair instead.
describe("a movable day can still be typed (#3376)", () => {
  it("renders what was typed, states nothing until it is a day, then emits the pair", () => {
    const { seen } = mount(
      { maxDate: "2026-12-31" },
      { date: DAY, statedAt: null }
    );
    const field = screen.getByTestId("w-date") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "2026-09-0" } });
    // The box shows the half-typed text…
    expect(field.value).toBe("2026-09-0");
    // …and the PAIR has not moved: a draft is not a stated day.
    expect(seen).toEqual([]);

    fireEvent.change(field, { target: { value: "2026-09-04" } });
    expect(field.value).toBe("2026-09-04");
    expect(seen.at(-1)!.date).toBe("2026-09-04");
  });
});
