import { describe, expect, it } from "vitest";
import {
  EVENT_LEDGER_DEFAULT_DAYS,
  eventLedgerEmptyNote,
  eventLedgerWindowNote,
  foodLedgerOccurredAtPatch,
  resolveEventLedgerRange,
} from "@/lib/event-ledger";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

const TODAY = "2026-08-24";

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

describe("eventLedgerWindowNote", () => {
  it.each([
    { range: {}, expected: undefined },
    {
      range: { from: "2026-07-01", to: "2026-07-02" },
      expected:
        "Showing servings from Jul 1 to Jul 2. Older entries are still on record.",
    },
    {
      range: { from: "2026-07-01" },
      expected:
        "Showing servings from Jul 1 onward. Older entries are still on record.",
    },
    {
      range: { to: "2026-07-02" },
      expected: "Showing servings up to Jul 2.",
    },
  ])("formats $range", ({ range, expected }) => {
    expect(
      eventLedgerWindowNote(range, "servings", DEFAULT_FORMAT_PREFS, TODAY)
    ).toBe(expected);
  });
});

describe("eventLedgerEmptyNote", () => {
  it.each([
    {
      range: {},
      expected:
        "No servings were logged. Change the range or log food from Nutrition.",
    },
    {
      range: { from: "2026-07-01", to: "2026-07-02" },
      expected:
        "No servings were logged from Jul 1 to Jul 2. Change the range or log food from Nutrition.",
    },
    {
      range: { from: "2026-07-01" },
      expected:
        "No servings were logged from Jul 1 onward. Change the range or log food from Nutrition.",
    },
    {
      range: { to: "2026-07-02" },
      expected:
        "No servings were logged up to Jul 2. Change the range or log food from Nutrition.",
    },
  ])("formats $range", ({ range, expected }) => {
    expect(
      eventLedgerEmptyNote(
        range,
        "servings",
        "Change the range or log food from Nutrition.",
        DEFAULT_FORMAT_PREFS,
        TODAY
      )
    ).toBe(expected);
  });
});
