import { describe, expect, it } from "vitest";
import {
  rateSummary,
  contextGroup,
  contextGroupHasChips,
  contextSummary,
  reportSummary,
  actSummary,
  type ContextGroup,
} from "@/lib/checkin-sections";

// Pure coverage for the recomposed check-in card's section model (issue #1314): the
// collapsed one-liner formatters (each a formatter over the SAME data its expansion
// edits — #221) and the merged Context chip-group partition (#1311: sticky situations
// vs today-only day factors).

describe("rateSummary", () => {
  it("invites a tap when unlogged", () => {
    expect(
      rateSummary({ valence: null, energy: null, calmDisplay: null })
    ).toBe("Tap to log your day.");
  });

  it("names the rating and any filled expansion detail when logged", () => {
    expect(rateSummary({ valence: 4, energy: null, calmDisplay: null })).toBe(
      "Good"
    );
    expect(rateSummary({ valence: 2, energy: 3, calmDisplay: null })).toBe(
      "Low · energy 3"
    );
    expect(rateSummary({ valence: 5, energy: 4, calmDisplay: 5 })).toBe(
      "Great · energy 4 · calm 5"
    );
  });
});

describe("contextGroup partition (#1311)", () => {
  it("tags situations sticky and day factors day, preserving order", () => {
    const g = contextGroup({
      situations: [
        { name: "Travel", active: true },
        { name: "High stress", active: false },
      ],
      dayFactors: [
        { slug: "work", label: "Work", active: false },
        { slug: "social", label: "Social", active: true },
      ],
    });
    expect(g.sticky.map((c) => [c.key, c.variant, c.active])).toEqual([
      ["Travel", "sticky", true],
      ["High stress", "sticky", false],
    ]);
    expect(g.day.map((c) => [c.key, c.variant, c.active])).toEqual([
      ["work", "day", false],
      ["social", "day", true],
    ]);
  });

  it("reports emptiness and only counts chips that exist", () => {
    const empty = contextGroup({ situations: [], dayFactors: [] });
    expect(contextGroupHasChips(empty)).toBe(false);
    const someDay = contextGroup({
      situations: [],
      dayFactors: [{ slug: "work", label: "Work", active: false }],
    });
    expect(contextGroupHasChips(someDay)).toBe(true);
  });
});

describe("contextSummary", () => {
  const group: ContextGroup = contextGroup({
    situations: [
      { name: "Travel", active: true },
      { name: "High stress", active: false },
    ],
    dayFactors: [
      { slug: "work", label: "Work", active: true },
      { slug: "social", label: "Social", active: false },
    ],
  });

  it("lists the active context, situations before today-factors", () => {
    expect(contextSummary(group)).toBe("Travel · Work");
  });

  it("falls back to the calm empty state when nothing is active", () => {
    const none = contextGroup({
      situations: [{ name: "Travel", active: false }],
      dayFactors: [{ slug: "work", label: "Work", active: false }],
    });
    expect(contextSummary(none)).toBe("Nothing noted.");
  });
});

describe("reportSummary / actSummary", () => {
  it("reports the illness state", () => {
    expect(reportSummary(false)).toBe("Feeling well.");
    expect(reportSummary(true)).toBe("Illness tracked above.");
  });

  it("pluralizes the PRN meds count", () => {
    expect(actSummary(0)).toBe("No PRN meds.");
    expect(actSummary(1)).toBe("1 PRN med");
    expect(actSummary(3)).toBe("3 PRN meds");
  });
});
