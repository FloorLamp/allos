import { describe, expect, it } from "vitest";
import {
  EVENT_LEDGER_DEFAULT_DAYS,
  eventLedgerEmptyNote,
  eventLedgerWindowNote,
  foodLedgerOccurredAtPatch,
  resolveEventLedgerRange,
} from "@/lib/event-ledger";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

// The reference day every sentence below is rendered against. It is not decoration:
// `formatMonthDay` appends the year only when the date leaves this day's calendar
// year, so `today` is part of the rendered sentence.
const TODAY = "2026-08-24";
// A reference day in a LATER calendar year than the dates being rendered — and than
// this box's wall clock. That is what makes the year-carrying cases below fail if
// anyone stops threading `today` into `formatMonthDay`: against the process clock
// these same dates render bare, so the assertion pins the argument and not merely
// the year rule.
const NEXT_YEAR = "2027-01-05";

describe("event ledger range", () => {
  it("keeps explicit bounds and gives a bare mount one shared bounded default", () => {
    expect(
      resolveEventLedgerRange(
        { from: "2026-07-01", to: "2026-07-02" },
        "2026-08-24"
      )
    ).toEqual({
      from: "2026-07-01",
      to: "2026-07-02",
    });
    expect(EVENT_LEDGER_DEFAULT_DAYS).toBe(90);
    expect(resolveEventLedgerRange({}, "2026-08-24")).toEqual({
      from: "2026-05-27",
      to: "2026-08-24",
    });
    expect(resolveEventLedgerRange({}, "2026-08-24", "all")).toEqual({});
  });

  it("re-anchors a stated eating time only when its profile-local day moves", () => {
    const eaten = {
      date: "2026-08-20",
      clock: "08:17",
      clockKind: "eaten" as const,
    };
    expect(foodLedgerOccurredAtPatch(eaten, "2026-08-21")).toBe("08:17");
    expect(foodLedgerOccurredAtPatch(eaten, "2026-08-20")).toBeUndefined();
    expect(
      foodLedgerOccurredAtPatch({ ...eaten, clockKind: "logged" }, "2026-08-21")
    ).toBeUndefined();
  });
});

// The two sentences a person actually reads above the food and practice ledgers
// (#3703). Both branch four ways on the window, and the e2e spec seeds rows on both
// days of its range, so it only ever renders the from+to shape with rows present —
// the empty and half-bounded wordings ship on nobody's evidence. These assert the
// WHOLE sentence, because the bug class is a wrong preposition or a swapped noun,
// and a `toContain` on the date would pass straight through every one of them.
describe("eventLedgerWindowNote", () => {
  it("says nothing when the ledger names no window", () => {
    expect(
      eventLedgerWindowNote({}, "servings", DEFAULT_FORMAT_PREFS, TODAY)
    ).toBeUndefined();
  });

  it("names both bounds and promises the older entries are kept", () => {
    expect(
      eventLedgerWindowNote(
        { from: "2026-07-01", to: "2026-07-02" },
        "servings",
        DEFAULT_FORMAT_PREFS,
        TODAY
      )
    ).toBe(
      "Showing servings from Jul 1 to Jul 2. Older entries are still on record."
    );
  });

  it("reads a start-only window as open-ended forward", () => {
    expect(
      eventLedgerWindowNote(
        { from: "2026-07-01" },
        "sessions",
        DEFAULT_FORMAT_PREFS,
        TODAY
      )
    ).toBe(
      "Showing sessions from Jul 1 onward. Older entries are still on record."
    );
  });

  it("drops the older-entries promise on an end-only window, which already includes them", () => {
    expect(
      eventLedgerWindowNote(
        { to: "2026-07-02" },
        "sessions",
        DEFAULT_FORMAT_PREFS,
        TODAY
      )
    ).toBe("Showing sessions up to Jul 2.");
  });

  it("dates the window against the reference day, not the process clock", () => {
    expect(
      eventLedgerWindowNote(
        { from: "2026-07-01", to: "2026-07-02" },
        "servings",
        DEFAULT_FORMAT_PREFS,
        NEXT_YEAR
      )
    ).toBe(
      "Showing servings from Jul 1, 2026 to Jul 2, 2026. Older entries are still on record."
    );
  });
});

describe("eventLedgerEmptyNote", () => {
  // The exact noun and next-step copy the two live mounts pass
  // (components/food/FoodLedgerMount.tsx, components/practices/PracticeLedgerMount.tsx),
  // so a change to the joining grammar shows up here as the sentence people read.
  const FOOD_NEXT = "Change the range or log food from Nutrition.";
  const PRACTICE_NEXT = "Change the range or log a session from Wellness.";

  it("states the bare fact when there is no window to blame", () => {
    expect(
      eventLedgerEmptyNote({}, "servings", FOOD_NEXT, DEFAULT_FORMAT_PREFS, TODAY)
    ).toBe(
      "No servings were logged. Change the range or log food from Nutrition."
    );
  });

  it("names both bounds", () => {
    expect(
      eventLedgerEmptyNote(
        { from: "2026-07-01", to: "2026-07-02" },
        "servings",
        FOOD_NEXT,
        DEFAULT_FORMAT_PREFS,
        TODAY
      )
    ).toBe(
      "No servings were logged from Jul 1 to Jul 2. Change the range or log food from Nutrition."
    );
  });

  it("reads a start-only window as open-ended forward", () => {
    expect(
      eventLedgerEmptyNote(
        { from: "2026-07-01" },
        "practice sessions",
        PRACTICE_NEXT,
        DEFAULT_FORMAT_PREFS,
        TODAY
      )
    ).toBe(
      "No practice sessions were logged from Jul 1 onward. Change the range or log a session from Wellness."
    );
  });

  it("reads an end-only window as everything up to that day", () => {
    expect(
      eventLedgerEmptyNote(
        { to: "2026-07-02" },
        "practice sessions",
        PRACTICE_NEXT,
        DEFAULT_FORMAT_PREFS,
        TODAY
      )
    ).toBe(
      "No practice sessions were logged up to Jul 2. Change the range or log a session from Wellness."
    );
  });

  it("dates the window against the reference day, not the process clock", () => {
    expect(
      eventLedgerEmptyNote(
        { to: "2026-07-02" },
        "servings",
        FOOD_NEXT,
        DEFAULT_FORMAT_PREFS,
        NEXT_YEAR
      )
    ).toBe(
      "No servings were logged up to Jul 2, 2026. Change the range or log food from Nutrition."
    );
  });
});
