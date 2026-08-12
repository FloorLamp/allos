import { describe, it, expect } from "vitest";
import {
  detectRightSizeCandidate,
  detectRightSizeCandidates,
  rightSizeDomainFor,
  rightSizeSignalKey,
  rightSizeLegacyKey,
  rightSizeTargetIdFromKey,
  FREQUENCY_PACE_WINDOW_DAYS,
  RIGHTSIZE_MAX_ATTAINMENT,
  RIGHTSIZE_PREFIX,
  RIGHTSIZE_WEEKS,
  RIGHTSIZE_WINDOW_DAYS,
  RIGHTSIZE_OUTCOME_TEXT,
  type RightSizeInput,
} from "../target-rightsize";
import { DEMOTION_WINDOW_DAYS } from "../supplement-demotion";
import type { FrequencyScopeKind } from "../frequency-targets";

// The pure #1670 detector: chronic under-floor frequency targets across all three
// commitment domains that share the `frequency_targets` substrate. Every case here is
// a decision the engine makes without a database.

function input(over: Partial<RightSizeInput> = {}): RightSizeInput {
  return {
    targetId: 7,
    scopeKind: "practice",
    label: "Meditation",
    floor: 4,
    weeklyCounts: [1, 0, 1, 1],
    existedWholeWindow: true,
    periodAnchor: "2026",
    ...over,
  };
}

describe("rightSizeDomainFor", () => {
  it("maps every floor-carrying scope to a domain and excludes substance caps", () => {
    const kinds: FrequencyScopeKind[] = [
      "region",
      "group",
      "type",
      "food_group",
      "mobility_region",
      "substance",
      "practice",
    ];
    expect(
      Object.fromEntries(kinds.map((k) => [k, rightSizeDomainFor(k)]))
    ).toEqual({
      region: "training",
      group: "training",
      type: "training",
      mobility_region: "training",
      food_group: "food",
      practice: "practice",
      // A weekly CAP is not a floor: "chronically under it" is that scope's
      // SUCCESS state, so a right-sizing suggestion there would nudge toward more
      // consumption. Excluded at the mapping, not merely at a call site.
      substance: null,
    });
  });
});

describe("detectRightSizeCandidate", () => {
  it("fires on four completed weeks under the floor and suggests the best week", () => {
    const c = detectRightSizeCandidate(input({ weeklyCounts: [1, 0, 2, 1] }));
    expect(c).not.toBeNull();
    expect(c!.domain).toBe("practice");
    expect(c!.floor).toBe(4);
    // The BEST week, not the median: applying it makes every week in the window at
    // or above the new floor, so accepting SELF-CLEARS instead of ratcheting down.
    expect(c!.suggestedFloor).toBe(2);
    expect(c!.best).toBe(2);
    expect(c!.total).toBe(4);
    expect(c!.title).toContain("Meditation");
    expect(c!.detail).toContain("2×");
  });

  it("suggests only stopping when nothing at all was logged", () => {
    const c = detectRightSizeCandidate(input({ weeklyCounts: [0, 0, 0, 0] }));
    expect(c!.suggestedFloor).toBeNull();
    // No "lower to 0×" is ever offered — zero is not a floor.
    expect(c!.detail).not.toContain("0×");
  });

  it("never suggests a floor at or above the declared one (downward only)", () => {
    for (let best = 0; best < 10; best++) {
      const c = detectRightSizeCandidate(
        input({ floor: 10, weeklyCounts: [0, 0, 0, best] })
      );
      if (c?.suggestedFloor != null) expect(c.suggestedFloor).toBeLessThan(10);
    }
  });

  it("clears on recovery: one met week breaks the chronic condition", () => {
    expect(
      detectRightSizeCandidate(input({ weeklyCounts: [1, 0, 1, 4] }))
    ).toBeNull();
    expect(
      detectRightSizeCandidate(input({ weeklyCounts: [4, 0, 1, 1] }))
    ).toBeNull();
  });

  it("stays silent on a near miss", () => {
    // Best week above half the floor: under target, but not the "I do this about half
    // as often as I said" divergence the suggestion is about.
    expect(
      detectRightSizeCandidate(input({ floor: 7, weeklyCounts: [6, 5, 6, 4] }))
    ).toBeNull();
    // Exactly at the attainment line still fires.
    const atLine = detectRightSizeCandidate(
      input({ floor: 6, weeklyCounts: [3, 2, 3, 1] })
    );
    expect(atLine!.suggestedFloor).toBe(6 * RIGHTSIZE_MAX_ATTAINMENT);
  });

  it("needs a full window of completed weeks", () => {
    expect(
      detectRightSizeCandidate(input({ weeklyCounts: [0, 0, 0] }))
    ).toBeNull();
    // More weeks than the window: only the most recent RIGHTSIZE_WEEKS are judged, so
    // an old good week can't hold a live suggestion off.
    const c = detectRightSizeCandidate(
      input({ weeklyCounts: [4, 4, 1, 0, 1, 1] })
    );
    expect(c!.weeks).toBe(RIGHTSIZE_WEEKS);
    expect(c!.best).toBe(1);
  });

  it("excludes a target that did not exist for the whole window", () => {
    expect(
      detectRightSizeCandidate(input({ existedWholeWindow: false }))
    ).toBeNull();
  });

  it("excludes substance caps whatever their counts look like", () => {
    expect(
      detectRightSizeCandidate(
        input({
          scopeKind: "substance",
          label: "Alcohol",
          weeklyCounts: [0, 0, 0, 0],
        })
      )
    ).toBeNull();
  });

  it("words the evidence in the domain's own unit", () => {
    const practice = detectRightSizeCandidate(input())!;
    const training = detectRightSizeCandidate(
      input({ scopeKind: "type", label: "Cardio" })
    )!;
    const food = detectRightSizeCandidate(
      input({ scopeKind: "food_group", label: "Vegetables", floor: 14 })
    )!;
    expect(practice.evidence).toContain("sessions");
    expect(training.evidence).toContain("days");
    expect(food.evidence).toContain("servings");
  });

  it("names what survives stopping, per domain", () => {
    expect(detectRightSizeCandidate(input())!.detail).toContain("history");
    expect(
      detectRightSizeCandidate(input({ scopeKind: "food_group", floor: 10 }))!
        .detail
    ).toContain("food log");
  });

  it("refuses a nonsensical floor rather than inventing a suggestion", () => {
    expect(detectRightSizeCandidate(input({ floor: 0 }))).toBeNull();
  });
});

describe("detectRightSizeCandidates", () => {
  it("is deterministic by label then id, and drops non-candidates", () => {
    const out = detectRightSizeCandidates([
      input({ targetId: 3, label: "Sauna" }),
      input({ targetId: 1, label: "Breathwork" }),
      input({ targetId: 2, label: "Recovered", weeklyCounts: [4, 4, 4, 4] }),
    ]);
    expect(out.map((c) => c.label)).toEqual(["Breathwork", "Sauna"]);
  });
});

describe("the right-size signal key", () => {
  it("round-trips the target id and refuses foreign namespaces", () => {
    const key = rightSizeSignalKey(42, "2026");
    expect(key.startsWith(RIGHTSIZE_PREFIX)).toBe(true);
    expect(rightSizeTargetIdFromKey(key)).toBe(42);
    expect(rightSizeTargetIdFromKey(rightSizeLegacyKey(42))).toBe(42);
    expect(rightSizeTargetIdFromKey("demote-obligation:42")).toBeNull();
    expect(rightSizeTargetIdFromKey(`${RIGHTSIZE_PREFIX}nope`)).toBeNull();
    expect(rightSizeTargetIdFromKey(`${RIGHTSIZE_PREFIX}0:2026`)).toBeNull();
  });

  it("carries the pre-anchor twin so an old dismissal keeps suppressing", () => {
    const c = detectRightSizeCandidate(input({ targetId: 9 }))!;
    expect(c.key).toBe(rightSizeSignalKey(9, "2026"));
    expect(c.legacyKey).toBe(rightSizeLegacyKey(9));
  });
});

describe("window coherence", () => {
  it("nests the right-sizing window strictly outside the weekly pace window", () => {
    // The pace nudge answers "you're behind THIS WEEK"; this engine answers "you have
    // been under this floor for a month". The two must never fire off the same
    // evidence, which is exactly what strict nesting guarantees.
    expect(RIGHTSIZE_WINDOW_DAYS).toBe(RIGHTSIZE_WEEKS * 7);
    expect(FREQUENCY_PACE_WINDOW_DAYS).toBeLessThan(RIGHTSIZE_WINDOW_DAYS);
  });

  it("reads as one family with the intake right-sizing window", () => {
    // Not a nesting requirement — different ledgers — but the two right-sizing
    // windows should stay within a month of each other so "abandoned" means roughly
    // the same span of life in both domains.
    expect(Math.abs(RIGHTSIZE_WINDOW_DAYS - DEMOTION_WINDOW_DAYS)).toBeLessThan(
      7
    );
  });
});

describe("outcome copy", () => {
  it("states every outcome without claiming an unconditional success", () => {
    for (const [outcome, text] of Object.entries(RIGHTSIZE_OUTCOME_TEXT)) {
      expect(text.length).toBeGreaterThan(0);
      if (outcome === "lowered" || outcome === "stopped")
        expect(text).toMatch(/history|logged/);
    }
  });
});
