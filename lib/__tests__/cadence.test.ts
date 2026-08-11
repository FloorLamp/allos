import { describe, expect, it } from "vitest";
import {
  CADENCE_SCOPES,
  CADENCE_VERDICT_LABEL,
  CAP_VERDICTS,
  FLOOR_VERDICTS,
  cadenceDirection,
  cadenceToGo,
  cadenceVerdict,
  cadenceWeekMet,
  isCadenceScopeKind,
  verdictDirection,
  type CadenceVerdict,
} from "../cadence";
import { FREQUENCY_SCOPE_KINDS } from "../frequency-targets";
import { frequencyRangeState } from "../practice";
import { substanceCapStatus } from "../substance-use";
import { practiceWeekVerdict } from "../trends-practices";

// The declared axes under the one cadence ledger (#2034): the scope registry, the
// direction parameter that replaced a fourth module, and the anti-nudge guarantee
// that direction had to keep alive when it stopped being a module boundary.

describe("the scope registry", () => {
  it("is TOTAL over FrequencyScopeKind — no kind can be forgotten", () => {
    for (const kind of FREQUENCY_SCOPE_KINDS) {
      const spec = CADENCE_SCOPES[kind];
      expect(spec, kind).toBeDefined();
      expect(spec.note.length, kind).toBeGreaterThan(0);
    }
    expect(Object.keys(CADENCE_SCOPES).sort()).toEqual(
      [...FREQUENCY_SCOPE_KINDS].sort()
    );
  });

  it("declares each scope's source and grain rather than branching on it", () => {
    expect(CADENCE_SCOPES.region).toMatchObject({
      source: "exercise-sets",
      grain: "distinct-days",
      direction: "floor",
    });
    expect(CADENCE_SCOPES.group.source).toBe("exercise-sets");
    expect(CADENCE_SCOPES.type.source).toBe("activity-type");
    expect(CADENCE_SCOPES.mobility_region.source).toBe("mobility-moves");
    expect(CADENCE_SCOPES.practice.source).toBe("practice-logs");
    // The two SUM scopes are the ones whose week is an amount, not a day count.
    expect(CADENCE_SCOPES.food_group.grain).toBe("sum");
    expect(CADENCE_SCOPES.substance.grain).toBe("sum");
  });

  it("names substance as the ONE inverted scope", () => {
    const caps = FREQUENCY_SCOPE_KINDS.filter(
      (k) => CADENCE_SCOPES[k].direction === "cap"
    );
    expect(caps).toEqual(["substance"]);
    expect(cadenceDirection("substance")).toBe("cap");
    expect(cadenceDirection("practice")).toBe("floor");
    // An unregistered kind is not a cadence scope at all — it does not silently
    // default into either direction's readers.
    expect(cadenceDirection("not_a_scope")).toBeNull();
    expect(isCadenceScopeKind("not_a_scope")).toBe(false);
    expect(isCadenceScopeKind("food_group")).toBe(true);
  });
});

describe("the direction axis", () => {
  // ONE fixture series read both ways. The counts are identical; the verdicts are
  // opposites, which is the whole content of the axis.
  const series = [0, 2, 3, 5];
  const target = 3;

  it("reads the same series as a floor and as a cap, with opposite verdicts", () => {
    const asFloor = series.map((count) =>
      cadenceVerdict({ direction: "floor", count, target })
    );
    const asCap = series.map((count) =>
      cadenceVerdict({ direction: "cap", count, target })
    );
    expect(asFloor).toEqual(["under", "under", "met", "met"]);
    expect(asCap).toEqual(["under-cap", "under-cap", "at-cap", "over-cap"]);
    // A week that is a FAILURE under a floor is a SUCCESS under a cap, and vice
    // versa. That inversion is why #998 kept the readers apart; it is now a value.
    expect(asFloor.map(cadenceWeekMet)).toEqual([false, false, true, true]);
    expect(asCap.map(cadenceWeekMet)).toEqual([true, true, true, false]);
  });

  it("delegates to the computations the surfaces already render", () => {
    for (const count of series) {
      const range = frequencyRangeState(count, target, 5, 7);
      const expected = range.atCeiling
        ? "at-ceiling"
        : range.met
          ? "met"
          : "under";
      expect(
        cadenceVerdict({
          direction: "floor",
          count,
          target,
          ceiling: 5,
          elapsedDays: 7,
        })
      ).toBe(expected);

      const cap = substanceCapStatus(count, target);
      expect(cadenceVerdict({ direction: "cap", count, target })).toBe(
        cap.over ? "over-cap" : cap.atCap ? "at-cap" : "under-cap"
      );
    }
  });

  it("carries the range ceiling and the elapsed-week pacing on the floor side", () => {
    expect(
      cadenceVerdict({
        direction: "floor",
        count: 5,
        target: 3,
        ceiling: 5,
        elapsedDays: 7,
      })
    ).toBe("at-ceiling");
    // A cap has no ceiling and no pace — a partly-elapsed week cannot make an
    // under-cap week read as anything else.
    expect(
      cadenceVerdict({ direction: "cap", count: 1, target: 7, elapsedDays: 1 })
    ).toBe("under-cap");
  });

  it("treats a zero cap with nothing logged as the quiet substance-free state", () => {
    expect(cadenceVerdict({ direction: "cap", count: 0, target: 0 })).toBe(
      "under-cap"
    );
    expect(cadenceVerdict({ direction: "cap", count: 1, target: 0 })).toBe(
      "over-cap"
    );
  });

  it("IS the practice lens's verdict, not a parallel vocabulary", () => {
    for (const count of [0, 2, 3, 5, 9]) {
      expect(practiceWeekVerdict(count, 3, 5)).toBe(
        cadenceVerdict({
          direction: "floor",
          count,
          target: 3,
          ceiling: 5,
          elapsedDays: 7,
        })
      );
    }
  });
});

// The safety property #998/#1259 kept by keeping the modules apart. It is now
// structural: a cap direction has no state and no number that could nudge toward
// MORE consumption, and this pin fails if one is ever added.
describe("the anti-nudge pin", () => {
  const all: CadenceVerdict[] = [...FLOOR_VERDICTS, ...CAP_VERDICTS];

  it("keeps the two verdict sets disjoint and correctly attributed", () => {
    expect(new Set(all).size).toBe(all.length);
    for (const v of FLOOR_VERDICTS) expect(verdictDirection(v)).toBe("floor");
    for (const v of CAP_VERDICTS) expect(verdictDirection(v)).toBe("cap");
  });

  it("gives a cap NO to-go / pace state at all", () => {
    // The floor vocabulary's incomplete states have no cap counterpart: there is
    // nothing to be "on pace" toward and nothing "to go" under a limit.
    expect(CAP_VERDICTS).not.toContain("under" as never);
    for (const v of CAP_VERDICTS) {
      expect(FLOOR_VERDICTS).not.toContain(v as never);
    }
  });

  it("never returns a remaining count for the cap direction", () => {
    for (const count of [0, 1, 5, 20]) {
      expect(cadenceToGo("cap", count, 7)).toBeNull();
      expect(cadenceToGo("floor", count, 7)).toBe(Math.max(0, 7 - count));
    }
  });

  it("renders no cap label that reads as room left to fill", () => {
    const nudging = /to go|left|remaining|behind|on pace|more|keep going/i;
    for (const v of CAP_VERDICTS) {
      expect(CADENCE_VERDICT_LABEL[v], v).not.toMatch(nudging);
    }
    for (const v of all) {
      expect(CADENCE_VERDICT_LABEL[v], v).toBeTruthy();
    }
  });

  it("makes UNDER-cap a success state, the way #1670 ruled", () => {
    expect(cadenceWeekMet("under-cap")).toBe(true);
    expect(cadenceWeekMet("at-cap")).toBe(true);
    expect(cadenceWeekMet("over-cap")).toBe(false);
  });
});
