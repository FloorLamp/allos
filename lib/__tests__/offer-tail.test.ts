// PURE TIER — the slot-hint reading of a `may` item's time_of_day (#1505) and the
// digest's "Log other…" tail built on top of it.
//
// The load-bearing property under test is that scoping is a function of the CURRENT
// clock, not of when a message was built. Everything else here is copy and shape.

import { describe, it, expect } from "vitest";
import {
  isOfferedOn,
  slotHintBucket,
  slotHintCoversNow,
} from "@/lib/intake-schedule";
import {
  collapsedOfferAction,
  expandedOfferActions,
  offerTailNeedsRefresh,
  offerTextTail,
  OFFER_COLLAPSE_PREFIX,
  OFFER_EXPAND_PREFIX,
} from "@/lib/notifications/offer-tail";

const ctx = {
  date: "2026-03-04",
  isWorkoutDay: false,
  activeSituations: new Set<string>(),
};

describe("slotHintBucket", () => {
  it("reads a real hint, and reads none from an anytime/absent slot", () => {
    expect(slotHintBucket("Before sleep")).toBe("Before sleep");
    expect(slotHintBucket("morning")).toBe("Morning");
    expect(slotHintBucket("Anytime")).toBeNull();
    expect(slotHintBucket(null)).toBeNull();
    // Free text still maps through the shared bucketer.
    expect(slotHintBucket("with dinner")).toBe("Evening");
  });
});

describe("slotHintCoversNow", () => {
  it("offers a hinted item only inside its own slot", () => {
    expect(slotHintCoversNow("Before sleep", "22:30")).toBe(true);
    expect(slotHintCoversNow("Before sleep", "08:00")).toBe(false);
    expect(slotHintCoversNow("morning", "08:00")).toBe(true);
    expect(slotHintCoversNow("morning", "22:30")).toBe(false);
  });

  it("offers a HINT-LESS item in every slot — the aspirin case", () => {
    // No hint means no opinion. Refusing to show it anywhere would make "may with
    // no slot" unreachable, which is the opposite of the guaranteed-access rule.
    for (const t of ["06:00", "12:00", "18:00", "23:30"]) {
      expect(slotHintCoversNow(null, t)).toBe(true);
      expect(slotHintCoversNow("Anytime", t)).toBe(true);
    }
  });

  it("is a function of NOW, so one item answers differently across the day", () => {
    // This is the whole reason the expansion re-evaluates at tap: a digest is born in
    // the morning and its keyboard may be tapped at bedtime.
    expect(slotHintCoversNow("Before sleep", "09:00")).toBe(false);
    expect(slotHintCoversNow("Before sleep", "23:00")).toBe(true);
  });
});

describe("isOfferedOn", () => {
  it("offers only `may` items, and only when their day condition applies", () => {
    const may = {
      obligation: "may" as const,
      condition: "daily" as const,
      situation: null,
    };
    expect(isOfferedOn(may, ctx)).toBe(true);
    // A must/should item is DUE, not offered — it belongs to the other list.
    expect(isOfferedOn({ ...may, obligation: "should" as const }, ctx)).toBe(
      false
    );
    expect(isOfferedOn({ ...may, obligation: "must" as const }, ctx)).toBe(
      false
    );
  });

  it("respects the day condition — a rest-day item is not offered on a training day", () => {
    const restDay = {
      obligation: "may" as const,
      condition: "rest_day" as const,
      situation: null,
    };
    expect(isOfferedOn(restDay, ctx)).toBe(true);
    expect(isOfferedOn(restDay, { ...ctx, isWorkoutDay: true })).toBe(false);
  });

  it("respects a situational hold — a paused item is not one tap away either", () => {
    const held = {
      obligation: "may" as const,
      condition: "daily" as const,
      situation: null,
      pause_situation: "Pre-surgery",
    };
    expect(isOfferedOn(held, ctx)).toBe(true);
    expect(
      isOfferedOn(held, { ...ctx, activeSituations: new Set(["Pre-surgery"]) })
    ).toBe(false);
  });
});

describe("the collapsed tail", () => {
  // #1819 item 8: the label is a sentence about what tapping does, not a slot and a
  // count crammed into one bar. Same guaranteed-access semantics, same slot rule.
  it("says what tapping does, naming the slot and the count", () => {
    const a = collapsedOfferAction(7, "2026-07-29", "22:30", 3);
    expect(a.label).toBe("➕ Log other (3 for bedtime)");
    expect(a.data).toBe(`${OFFER_EXPAND_PREFIX}:7:2026-07-29`);
  });

  it("names the slot alone when there is no count to state", () => {
    expect(collapsedOfferAction(7, "2026-07-29", "12:30", 0).label).toBe(
      "➕ Log other (midday)"
    );
  });

  it("relabels with the clock, which is what the tick refresh keeps true", () => {
    const morning = collapsedOfferAction(7, "2026-07-29", "08:00", 1);
    const bedtime = collapsedOfferAction(7, "2026-07-29", "22:30", 1);
    expect(morning.label).not.toBe(bedtime.label);
  });
});

describe("the expanded tail", () => {
  const items = [
    { itemId: 11, name: "Magnesium (test)", detail: "200 mg", countToday: 0 },
    { itemId: 12, name: "Aspirin (test)", detail: null, countToday: 2 },
  ];

  it("logs through the SAME prn token the /dose command uses", () => {
    const actions = expandedOfferActions(7, "2026-07-29", items, () => "tok");
    expect(actions[0].data).toBe("prn:7:11:tok");
    expect(actions[1].data).toBe("prn:7:12:tok");
  });

  it("shows today's count so a re-tap is informed, and ends with a collapse", () => {
    const actions = expandedOfferActions(7, "2026-07-29", items, () => "tok");
    expect(actions[0].label).toContain("200 mg");
    expect(actions[0].label).not.toContain("today");
    expect(actions[1].label).toContain("(2 today)");
    expect(actions.at(-1)!.data).toBe(`${OFFER_COLLAPSE_PREFIX}:7:2026-07-29`);
  });
});

describe("offerTextTail (the channels that cannot expand)", () => {
  // #1712: "+3 available when you want them" never said available WHAT. The line
  // names the noun now, and exists only for the channels with no button to carry it.
  it("names the noun, handles singular/plural, and says nothing at zero", () => {
    expect(offerTextTail(0)).toBeNull();
    expect(offerTextTail(1)).toBe("1 more supplement you can log any time");
    expect(offerTextTail(3)).toBe("3 more supplements you can log any time");
  });
});

describe("offerTailNeedsRefresh", () => {
  it("is true only across a slot boundary, so a quiet tick makes no API call", () => {
    expect(offerTailNeedsRefresh("08:00", "09:30")).toBe(false);
    expect(offerTailNeedsRefresh("08:00", "22:30")).toBe(true);
    expect(offerTailNeedsRefresh("22:00", "23:30")).toBe(false);
  });
});
