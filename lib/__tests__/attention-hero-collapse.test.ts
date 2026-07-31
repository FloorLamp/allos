import { describe, expect, it } from "vitest";
import {
  attentionHeroState,
  attentionSafetyLocked,
  attentionTopBand,
  attentionCardItems,
} from "../attention";
import type { UpcomingItem } from "../upcoming";

// The #449 care-tier contract, as refined by #1413 section B: the "Needs attention"
// hero moves from ALWAYS-FULL to ALWAYS-PRESENT.
//
// These are the tests that make the refinement safe. The collapse is a rendering
// concession; everything below pins the parts that are NOT negotiable, so a future
// change that quietly turns "collapsed" into "hidden" fails here rather than in
// production on the day it matters.

const TODAY = "2026-07-25";

function item(over: Partial<UpcomingItem> = {}): UpcomingItem {
  return {
    key: "appointment:1",
    domain: "appointment",
    title: "Follow-up visit",
    href: "/appointments",
    dueDate: TODAY,
    ...over,
  } as UpcomingItem;
}

// A missed-dose / crisis-class signal: the items that declare "safety-ungated",
// which the dismissal bus may never hide (#942) and which must therefore never be
// visually compacted either.
function safetyItem(): UpcomingItem {
  return item({
    key: "mental-health:phq9:2026-07-25",
    domain: "mental-health",
    title: "Mental-health check-in",
    dueDate: null,
    band: "today",
    suppressible: false,
    suppressionPolicy: "safety-ungated",
  });
}

describe("attentionHeroState — the count is never hidden", () => {
  it("reports the SAME count collapsed and expanded", () => {
    const items = [
      item({ key: "a", dueDate: TODAY }),
      item({ key: "b", dueDate: "2026-07-20" }),
      item({ key: "c", dueDate: TODAY }),
    ];
    const expanded = attentionHeroState(items, TODAY, false);
    const collapsed = attentionHeroState(items, TODAY, true);
    expect(expanded.count).toBe(3);
    expect(collapsed.count).toBe(3);
    expect(collapsed.collapsed).toBe(true);
    expect(expanded.collapsed).toBe(false);
  });

  it("the count always equals the expanded card's own item subset — the two can't drift", () => {
    const items = [
      item({ key: "a", dueDate: TODAY }),
      // A far-future scheduled item the card deliberately excludes.
      item({ key: "b", dueDate: "2027-01-01" }),
    ];
    expect(attentionHeroState(items, TODAY, true).count).toBe(
      attentionCardItems(items, TODAY).length
    );
  });

  it("carries the highest-severity band so the collapsed line says how bad, not only how many", () => {
    const overdue = item({ key: "old", dueDate: "2026-07-01" });
    const dueToday = item({ key: "now", dueDate: TODAY });
    expect(attentionTopBand([dueToday], TODAY)).toBe("today");
    // Past due outranks due-today, matching the expanded card's section order.
    expect(attentionTopBand([dueToday, overdue], TODAY)).toBe("urgent");
    expect(attentionHeroState([dueToday, overdue], TODAY, true).topBand).toBe(
      "urgent"
    );
  });
});

describe("attentionHeroState — the safety carve-out outranks the preference", () => {
  it("refuses to collapse a hero carrying a safety-ungated item, even when the viewer asked", () => {
    const state = attentionHeroState(
      [item({ key: "a" }), safetyItem()],
      TODAY,
      true
    );
    expect(state.locked).toBe(true);
    expect(state.collapsed).toBe(false);
  });

  it("locks on the item's OWN declared lifecycle policy, not a domain allowlist", () => {
    // Same domain, no declared policy → ordinary, collapsible. This is the
    // property that makes a FUTURE safety signal inherit the guarantee: it opts in
    // by declaring "safety-ungated", not by being added to a second list here.
    const ordinaryMentalHealth = item({
      key: "mental-health:mild",
      domain: "mental-health",
    });
    expect(attentionSafetyLocked([ordinaryMentalHealth], TODAY)).toBe(false);
    expect(attentionSafetyLocked([safetyItem()], TODAY)).toBe(true);
  });

  it("a care-persistent (snooze-only) item is NOT safety-locked — it resists dismissal, not compaction", () => {
    const followUp = item({ key: "followup:3", carePersistent: true });
    expect(attentionSafetyLocked([followUp], TODAY)).toBe(false);
    expect(attentionHeroState([followUp], TODAY, true).collapsed).toBe(true);
  });

  it("ignores a safety item the card EXCLUDES — a far-future one isn't on the card to compact", () => {
    const futureSafety = {
      ...safetyItem(),
      band: undefined,
      dueDate: "2027-01-01",
    } as UpcomingItem;
    expect(attentionSafetyLocked([futureSafety], TODAY)).toBe(false);
  });
});

describe("attentionHeroState — degenerate cases", () => {
  it("never collapses an empty hero: a collapsed 'all clear' is a worse rendering of the same zero", () => {
    const state = attentionHeroState([], TODAY, true);
    expect(state.count).toBe(0);
    expect(state.collapsed).toBe(false);
    expect(state.topBand).toBe(null);
  });

  it("defaults to expanded for a viewer who has never chosen", () => {
    expect(
      attentionHeroState([item({ key: "a" })], TODAY, false).collapsed
    ).toBe(false);
  });

  it("collapse is a pure function of (items, today, preference) — no hidden state", () => {
    const items = [item({ key: "a" })];
    expect(attentionHeroState(items, TODAY, true)).toEqual(
      attentionHeroState(items, TODAY, true)
    );
  });
});
