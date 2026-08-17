// PURE TIER — the slot-hint reading of a `may` item's time_of_day (#1505) and the
// digest's "➕ Doses" tail built on top of it.
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
import { collapsedTuneAction } from "@/lib/notifications/digest-tune";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import type { NotificationAction } from "@/lib/notifications/types";

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
  // #2890: the label names the THING it opens — the app's own noun for what these
  // buttons write — and states how many are behind it. It replaces #1819 item 8's
  // "Log other (3 for bedtime)", whose noun was relative to a list the reader may not
  // be able to see, and whose slot word the expansion restates the moment it opens.
  it("names the doses it opens, and how many are on offer", () => {
    const a = collapsedOfferAction(7, "2026-07-29", 3);
    expect(a.label).toBe("➕ Doses (3)");
    expect(a.data).toBe(`${OFFER_EXPAND_PREFIX}:7:2026-07-29`);
  });

  it("drops the parenthetical when there is no count to state", () => {
    expect(collapsedOfferAction(7, "2026-07-29", 0).label).toBe("➕ Doses");
    // Never "(0)" — no count, rather than a count of none.
    expect(collapsedOfferAction(7, "2026-07-29", 0).label).not.toContain("0");
  });

  // The slot is still what SCOPES the offer (the caller reads the profile-local clock
  // to build `count`); it is no longer what the label spends its width on.
  it("names no slot in either state", () => {
    for (const label of [
      collapsedOfferAction(7, "2026-07-29", 3).label,
      collapsedOfferAction(7, "2026-07-29", 0).label,
    ]) {
      for (const slot of ["morning", "midday", "evening", "bedtime"]) {
        expect(label.toLowerCase()).not.toContain(slot);
      }
    }
  });

  // The label is now a function of the COUNT alone, and the count is what the
  // boundary refresh re-reads — so a boundary that moves it still re-labels.
  it("re-labels when the slot boundary changes what is on offer", () => {
    expect(collapsedOfferAction(7, "2026-07-29", 1).label).not.toBe(
      collapsedOfferAction(7, "2026-07-29", 2).label
    );
  });
});

// ---- The two collapsed controls share ONE keyboard row (#2890) ----
//
// They are always assembled adjacent (`[offerTail, tuneTail, …]` on the digest, and
// the same order in every keyboard rebuild), and two small controls had no business
// claiming a full-width row each. `messageKeyboard` already merges consecutive actions
// sharing a `row` key (#232) — these two simply never declared the same one.
describe("the collapsed tail pairs with ⚙️ Tune (#2890)", () => {
  const keyboard = (actions: NotificationAction[]) =>
    messageKeyboard({ title: "", body: "", actions });

  it("renders the pair as one row of two buttons", () => {
    const rows = keyboard([
      collapsedOfferAction(7, "2026-07-29", 3),
      collapsedTuneAction(7, "2026-07-29"),
    ]);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ["➕ Doses (3)", "⚙️ Tune"],
    ]);
  });

  // The shared key must not depend on the partner being present: grouping is by
  // ADJACENCY, so a digest carrying only one of them still renders one button.
  it("renders a single button when either control is alone", () => {
    expect(keyboard([collapsedOfferAction(7, "2026-07-29", 3)])).toEqual([
      [expect.objectContaining({ text: "➕ Doses (3)" })],
    ]);
    expect(keyboard([collapsedTuneAction(7, "2026-07-29")])).toEqual([
      [expect.objectContaining({ text: "⚙️ Tune" })],
    ]);
  });

  // The EXPANDED offer list is a different layout, and keeps its own keys: a Tune
  // button appended after its ▲ Collapse must not be dragged onto that row.
  it("does not merge the expanded list's ▲ Collapse with ⚙️ Tune", () => {
    const rows = keyboard([
      ...expandedOfferActions(
        7,
        "2026-07-29",
        [{ itemId: 11, name: "Magnesium (test)", detail: null, countToday: 0 }],
        () => "tok"
      ),
      collapsedTuneAction(7, "2026-07-29"),
    ]);
    expect(rows.map((r) => r.length)).toEqual([1, 1, 1]);
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

  it("labels a supplement by its shorter product name when it has one", () => {
    const actions = expandedOfferActions(
      7,
      "2026-07-29",
      [
        {
          itemId: 13,
          name: "Astaxanthin/Lutein/Zeaxanthin (test)",
          kind: "supplement" as const,
          product: "Eye Health+",
          detail: "1 cap",
          countToday: 0,
        },
      ],
      () => "tok"
    );
    expect(actions[0].label).toBe("💊 Eye Health+ · 1 cap");
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
