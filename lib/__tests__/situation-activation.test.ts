// Situation-activation visibility (issue #662 item 1): the pure count + the one-line
// acknowledgment formatter. The count reuses isDueOn's situational branch — the SAME
// dueness computation the dose list / Upcoming use — so the acknowledgment can never
// disagree with the list it's acknowledging (a formatter, not a second count).

import { describe, it, expect } from "vitest";
import { countSituationalDue } from "@/lib/supplement-schedule";
import { situationActivationLine } from "@/lib/situations";

type Supp = Parameters<typeof countSituationalDue>[0][number];

function ctx(active: string[]) {
  return { isWorkoutDay: false, activeSituations: new Set(active) };
}

const supps: Supp[] = [
  { active: 1, condition: "situational", situation: "Illness" },
  { active: 1, condition: "situational", situation: "Illness" },
  { active: 1, condition: "situational", situation: "Travel" },
  { active: 1, condition: "daily", situation: null }, // not situational
  { active: 0, condition: "situational", situation: "Illness" }, // paused
  { active: 1, condition: "situational", situation: "Illness", as_needed: 1 }, // PRN
];

describe("countSituationalDue — the shared situational dueness count (#662)", () => {
  it("counts only active, non-PRN situational items whose situation is active", () => {
    // Two active "Illness" situational items are due; the paused one, the PRN one,
    // the daily one, and the (inactive) Travel one are all excluded.
    expect(countSituationalDue(supps, ctx(["Illness"]))).toBe(2);
  });

  it("tracks the active set — a second active situation adds its items", () => {
    expect(countSituationalDue(supps, ctx(["Illness", "Travel"]))).toBe(3);
  });

  it("is zero when no situation is active (the dose list is its normal shape)", () => {
    expect(countSituationalDue(supps, ctx([]))).toBe(0);
  });
});

describe("situationActivationLine — the one-line acknowledgment (#662)", () => {
  it("pluralizes the count and returns null when nothing is active", () => {
    expect(situationActivationLine(0)).toBeNull();
    expect(situationActivationLine(-1)).toBeNull();
    expect(situationActivationLine(1)).toBe("1 situational item now active");
    expect(situationActivationLine(3)).toBe("3 situational items now active");
  });
});
