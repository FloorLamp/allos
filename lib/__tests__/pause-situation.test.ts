import { describe, it, expect } from "vitest";
import {
  isDueOn,
  heldBySituation,
  heldItemsBy,
  countHeldItems,
  heldSummaryLine,
  heldResumeAcknowledgment,
  pauseLinkNeedsConfirm,
} from "@/lib/supplement-schedule";

// Pure tests for the INVERSE situational condition (#1296): pause-during-situation.
// The dueness matrix (situational-on × pause × PRN), pause-beats-due precedence, the
// held grouping/count, and the visible-state formatters.

const ctx = (active: string[] = []) => ({
  isWorkoutDay: false,
  activeSituations: new Set(active),
});

describe("heldBySituation", () => {
  it("holds when the pause situation is active", () => {
    expect(
      heldBySituation(
        { pause_situation: "Pre-surgery" },
        new Set(["Pre-surgery"])
      )
    ).toBe("Pre-surgery");
  });

  it("does not hold when inactive or unlinked", () => {
    expect(
      heldBySituation({ pause_situation: "Pre-surgery" }, new Set(["Travel"]))
    ).toBeNull();
    expect(
      heldBySituation({ pause_situation: null }, new Set(["Pre-surgery"]))
    ).toBeNull();
    expect(heldBySituation({}, new Set(["Pre-surgery"]))).toBeNull();
  });
});

describe("isDueOn — pause beats due (#1296)", () => {
  it("holds a daily item while its pause situation is active", () => {
    const item = {
      condition: "daily" as const,
      situation: null,
      pause_situation: "Pre-surgery",
    };
    expect(isDueOn(item, ctx())).toBe(true);
    expect(isDueOn(item, ctx(["Pre-surgery"]))).toBe(false);
  });

  it("held beats an on-during link too (on-during A, paused-during B, both active)", () => {
    const item = {
      condition: "situational" as const,
      situation: "Illness",
      pause_situation: "Pre-surgery",
    };
    // On-situation active → would be due…
    expect(isDueOn(item, ctx(["Illness"]))).toBe(true);
    // …but held wins when the pause situation is ALSO active.
    expect(isDueOn(item, ctx(["Illness", "Pre-surgery"]))).toBe(false);
  });

  it("a PRN item stays not-scheduled-due regardless of pause", () => {
    const item = {
      condition: "daily" as const,
      situation: null,
      pause_situation: "Pre-surgery",
      as_needed: 1,
    };
    expect(isDueOn(item, ctx())).toBe(false);
    expect(isDueOn(item, ctx(["Pre-surgery"]))).toBe(false);
  });

  it("an item with no pause link is unaffected", () => {
    const item = {
      condition: "daily" as const,
      situation: null,
      pause_situation: null,
    };
    expect(isDueOn(item, ctx(["Pre-surgery"]))).toBe(true);
  });
});

describe("heldItemsBy / countHeldItems", () => {
  const items = [
    { active: 1, pause_situation: "Pre-surgery" },
    { active: 1, pause_situation: "Pre-surgery" },
    { active: 1, pause_situation: "Travel" },
    { active: 0, pause_situation: "Pre-surgery" }, // manually paused → not "held"
    { active: 1, pause_situation: null },
  ];

  it("groups active held items with their situation", () => {
    const held = heldItemsBy(items, new Set(["Pre-surgery"]));
    expect(held.map((h) => h.situation)).toEqual([
      "Pre-surgery",
      "Pre-surgery",
    ]);
  });

  it("counts held items, excluding manually-paused (active 0)", () => {
    expect(countHeldItems(items, new Set(["Pre-surgery"]))).toBe(2);
    expect(countHeldItems(items, new Set(["Pre-surgery", "Travel"]))).toBe(3);
    expect(countHeldItems(items, new Set())).toBe(0);
  });
});

describe("held visible-state formatters", () => {
  it("heldSummaryLine pluralizes and names the situation", () => {
    expect(heldSummaryLine(0, "Pre-surgery")).toBeNull();
    expect(heldSummaryLine(1, "Pre-surgery")).toBe(
      "1 item held by Pre-surgery"
    );
    expect(heldSummaryLine(3, "Pre-surgery")).toBe(
      "3 items held by Pre-surgery"
    );
  });

  it("heldResumeAcknowledgment reads as an acknowledgment", () => {
    expect(heldResumeAcknowledgment("Pre-surgery", 0)).toBeNull();
    expect(heldResumeAcknowledgment("Pre-surgery", 1)).toBe(
      "Pre-surgery cleared — 1 item resumes today"
    );
    expect(heldResumeAcknowledgment("Pre-surgery", 3)).toBe(
      "Pre-surgery cleared — 3 items resume today"
    );
  });
});

describe("pauseLinkNeedsConfirm — consent gate (#1296/#449)", () => {
  it("confirms for a medication or a mandatory item", () => {
    expect(
      pauseLinkNeedsConfirm({ kind: "medication", priority: "high" })
    ).toBe(true);
    expect(
      pauseLinkNeedsConfirm({ kind: "supplement", priority: "mandatory" })
    ).toBe(true);
  });

  it("no confirm for an ordinary non-mandatory supplement", () => {
    expect(
      pauseLinkNeedsConfirm({ kind: "supplement", priority: "high" })
    ).toBe(false);
    expect(pauseLinkNeedsConfirm({ kind: "supplement", priority: "low" })).toBe(
      false
    );
  });
});
