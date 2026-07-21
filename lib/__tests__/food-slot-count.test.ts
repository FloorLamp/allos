// PURE TIER — the shared slot-derivation (issues #950, #1016). The SAME code path decides
// the window for the ranking's slot signal (foodEventsInWindow) and the nudge's slot-scoped
// button counts (slotServingCounts), so a morning tap is excluded from the midday count and
// a boundary-time tap buckets consistently for BOTH — one shared fixture pins them (#221).

import { describe, it, expect } from "vitest";
import {
  foodEventWindow,
  foodEventsInWindow,
  slotServingCounts,
  type FoodLedgerEvent,
} from "@/lib/food-slot-count";
import { foodSlotBoundaries } from "@/lib/food-slot";

const TZ = "UTC";
// Default 11:00 / 15:00 splits: <11:00 Morning, 11:00–15:00 Midday, ≥15:00 Evening.
const BOUNDS = foodSlotBoundaries({
  morning: null,
  midday: null,
  evening: null,
});
const DAY = "2026-07-13";

// One shared fixture: a morning tap, a midday tap, a boundary-time tap at exactly 11:00
// (Midday), and an evening tap — all on the same day.
const EVENTS: FoodLedgerEvent[] = [
  { name: "whole_grains", date: DAY, logged_at: `${DAY}T08:00:00Z` }, // Morning
  { name: "fatty_fish", date: DAY, logged_at: `${DAY}T12:30:00Z` }, // Midday
  { name: "leafy_greens", date: DAY, logged_at: `${DAY}T11:00:00Z` }, // Midday (boundary)
  { name: "berries", date: DAY, logged_at: `${DAY}T19:00:00Z` }, // Evening
];

describe("foodEventWindow", () => {
  it("buckets a tap by its logged_at instant in the profile's tz + boundaries", () => {
    expect(foodEventWindow(`${DAY}T08:00:00Z`, TZ, BOUNDS)).toBe("Morning");
    expect(foodEventWindow(`${DAY}T12:30:00Z`, TZ, BOUNDS)).toBe("Midday");
    expect(foodEventWindow(`${DAY}T19:00:00Z`, TZ, BOUNDS)).toBe("Evening");
  });

  it("puts a boundary-time (11:00) tap in Midday, consistently for ranking and count", () => {
    expect(foodEventWindow(`${DAY}T11:00:00Z`, TZ, BOUNDS)).toBe("Midday");
  });
});

describe("slotServingCounts (#1016)", () => {
  it("counts only the taps whose derived window matches — morning excluded from midday", () => {
    const midday = slotServingCounts(EVENTS, TZ, BOUNDS, "Midday", DAY);
    // fatty_fish (12:30) + leafy_greens (11:00 boundary) count; whole_grains (08:00) does not.
    expect(midday.get("fatty_fish")).toBe(1);
    expect(midday.get("leafy_greens")).toBe(1);
    expect(midday.get("whole_grains")).toBeUndefined();
    expect(midday.get("berries")).toBeUndefined();
  });

  it("the midday slot count agrees with the ranking's midday slot events (#221)", () => {
    // Both surfaces read the SAME derivation: the set of names in Midday must match.
    const inWindow = foodEventsInWindow(EVENTS, TZ, BOUNDS, "Midday").map(
      (e) => e.name
    );
    const counted = [
      ...slotServingCounts(EVENTS, TZ, BOUNDS, "Midday", DAY).keys(),
    ];
    expect(inWindow.sort()).toEqual(counted.sort());
  });

  it("excludes events from a different DAY (a backfilled-yesterday tap)", () => {
    const evs: FoodLedgerEvent[] = [
      ...EVENTS,
      // A tap whose window is Midday but logged to YESTERDAY — not today's slot count.
      { name: "fatty_fish", date: "2026-07-12", logged_at: `${DAY}T12:00:00Z` },
    ];
    expect(
      slotServingCounts(evs, TZ, BOUNDS, "Midday", DAY).get("fatty_fish")
    ).toBe(1);
  });

  it("tallies multiple taps of the same group in one slot", () => {
    const evs: FoodLedgerEvent[] = [
      { name: "fatty_fish", date: DAY, logged_at: `${DAY}T12:00:00Z` },
      { name: "fatty_fish", date: DAY, logged_at: `${DAY}T13:00:00Z` },
    ];
    expect(
      slotServingCounts(evs, TZ, BOUNDS, "Midday", DAY).get("fatty_fish")
    ).toBe(2);
  });
});
