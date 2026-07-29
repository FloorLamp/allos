// PURE TIER — the adherence-based demotion DETECTOR (#1505 part 2).
//
// Every case here is about a boundary the product decided deliberately: the two
// thresholds, the four exclusions (medication / PRN / paused / cold-start), and the
// recovery path that makes a live suggestion disappear on its own. All fixture
// values synthetic — no real PHI.

import { describe, it, expect } from "vitest";
import type { AdherenceDot, AdherenceState } from "@/lib/supplement-adherence";
import { INTAKE_DELTA_DAYS } from "@/lib/intake-deltas";
import {
  DEMOTION_MAX_TAKEN_RATE,
  DEMOTION_MIN_OCCURRENCES,
  DEMOTION_PREFIX,
  DEMOTION_WINDOW_DAYS,
  demotionItemIdFromKey,
  demotionSignalKey,
  detectDemotionCandidate,
  detectDemotionCandidates,
  type DemotionInput,
} from "@/lib/supplement-demotion";

// A strip of `n` days built from a repeating state pattern. Dates are RELATIVE
// placeholders (the detector never parses them — it only reads `state`), kept in
// the far past so nothing here can collide with a real calendar.
function strip(states: AdherenceState[]): AdherenceDot[] {
  return states.map((state, i) => ({
    date: `1990-01-${String(i + 1).padStart(2, "0")}`,
    state,
  }));
}

// `takenN` taken days followed by `missedN` missed days.
function pattern(takenN: number, missedN: number): AdherenceDot[] {
  return strip([
    ...Array<AdherenceState>(takenN).fill("taken"),
    ...Array<AdherenceState>(missedN).fill("missed"),
  ]);
}

function input(over: Partial<DemotionInput> = {}): DemotionInput {
  return {
    itemId: 7,
    name: "Ashwagandha (test)",
    kind: "supplement",
    priority: "high",
    asNeeded: false,
    active: true,
    // 2 of 20 taken = 10%, comfortably under the threshold, comfortably over the
    // minimum occurrence count.
    strip: pattern(2, 18),
    existedWholeWindow: true,
    periodAnchor: "1990",
    ...over,
  };
}

describe("detectDemotionCandidate (#1505 part 2)", () => {
  it("flags a sustainedly-untaken high supplement, carrying the evidence as data", () => {
    const c = detectDemotionCandidate(input());
    expect(c).not.toBeNull();
    expect(c!.itemId).toBe(7);
    expect(c!.occurrences).toBe(20);
    expect(c!.takenDays).toBe(2);
    expect(c!.takenRate).toBeCloseTo(0.1);
    expect(c!.key).toBe(demotionSignalKey(7, "1990"));
    expect(c!.key.startsWith(DEMOTION_PREFIX)).toBe(true);
    // The legacy (pre-anchor) key is carried so an old dismissal keeps suppressing.
    expect(c!.legacyKey).toBe(`${DEMOTION_PREFIX}7`);
  });

  it("a MANDATORY supplement is a candidate too — both pushed priorities can fall", () => {
    expect(
      detectDemotionCandidate(input({ priority: "mandatory" }))
    ).not.toBeNull();
  });

  it("a LOW supplement is never a candidate — it is already where the suggestion leads", () => {
    expect(detectDemotionCandidate(input({ priority: "low" }))).toBeNull();
  });

  it("a MEDICATION is never a candidate, however badly it is taken (kind decides)", () => {
    expect(
      detectDemotionCandidate(
        input({ kind: "medication", strip: pattern(0, 30) })
      )
    ).toBeNull();
  });

  it("a PRN item is never a candidate — a PRN item is never scheduled-due", () => {
    expect(detectDemotionCandidate(input({ asNeeded: true }))).toBeNull();
  });

  it("a PAUSED item is never a candidate — a deliberate pause is not a lapse", () => {
    expect(detectDemotionCandidate(input({ active: false }))).toBeNull();
  });

  it("an item that started INSIDE the window is excluded (the cold-start guard)", () => {
    expect(
      detectDemotionCandidate(input({ existedWholeWindow: false }))
    ).toBeNull();
  });

  it("holds fire below the minimum occurrence count, even at zero follow-through", () => {
    const justUnder = DEMOTION_MIN_OCCURRENCES - 1;
    expect(
      detectDemotionCandidate(input({ strip: pattern(0, justUnder) }))
    ).toBeNull();
    // …and fires the moment the count is reached.
    expect(
      detectDemotionCandidate(
        input({ strip: pattern(0, DEMOTION_MIN_OCCURRENCES) })
      )
    ).not.toBeNull();
  });

  it("the taken-rate threshold is inclusive at the boundary and clears just above it", () => {
    // 5 of 20 = exactly 25% → still a candidate (at the threshold).
    expect(
      detectDemotionCandidate(input({ strip: pattern(5, 15) }))
    ).not.toBeNull();
    // 6 of 20 = 30% → recovered enough; no candidate.
    expect(
      detectDemotionCandidate(input({ strip: pattern(6, 14) }))
    ).toBeNull();
  });

  it("RECOVERY clears a live candidate — the detection is a pure function of the window", () => {
    const lapsed = input({ strip: pattern(1, 19) });
    expect(detectDemotionCandidate(lapsed)).not.toBeNull();
    // The same item after two weeks of taking it again: the trailing window now holds
    // mostly takes, so nothing is emitted and the finding simply stops rendering.
    const recovered = input({ strip: pattern(15, 5) });
    expect(detectDemotionCandidate(recovered)).toBeNull();
  });

  it("'na' and deliberate 'skipped' days are transparent, exactly as to the percentage", () => {
    // 10 real occurrences (all missed) padded with not-due and skipped days: the
    // padding must neither create occurrences nor dilute the rate.
    const padded = strip([
      ...Array<AdherenceState>(10).fill("na"),
      ...Array<AdherenceState>(5).fill("skipped"),
      ...Array<AdherenceState>(10).fill("missed"),
    ]);
    const c = detectDemotionCandidate(input({ strip: padded }));
    expect(c).not.toBeNull();
    expect(c!.occurrences).toBe(10);
    expect(c!.takenDays).toBe(0);
  });

  it("a 'partial' day counts as follow-through (some dose was taken)", () => {
    const mostlyPartial = strip([
      ...Array<AdherenceState>(10).fill("partial"),
      ...Array<AdherenceState>(10).fill("missed"),
    ]);
    // 10/20 = 50% — well clear of the threshold, so no suggestion.
    expect(detectDemotionCandidate(input({ strip: mostlyPartial }))).toBeNull();
  });
});

describe("detectDemotionCandidates", () => {
  it("is deterministic by name, then item id", () => {
    const out = detectDemotionCandidates([
      input({ itemId: 3, name: "Zinc (test)" }),
      input({ itemId: 1, name: "Ashwagandha (test)" }),
      input({ itemId: 2, name: "Ashwagandha (test)" }),
    ]);
    expect(out.map((c) => c.itemId)).toEqual([1, 2, 3]);
  });
});

describe("demotionItemIdFromKey", () => {
  it("round-trips the signal key and refuses a foreign namespace", () => {
    expect(demotionItemIdFromKey(demotionSignalKey(42, "2026"))).toBe(42);
    // The pre-anchor shape still resolves.
    expect(demotionItemIdFromKey(`${DEMOTION_PREFIX}42`)).toBe(42);
    expect(demotionItemIdFromKey("adherence:weekday:42:5")).toBeNull();
    expect(demotionItemIdFromKey(`${DEMOTION_PREFIX}nope`)).toBeNull();
    expect(demotionItemIdFromKey(`${DEMOTION_PREFIX}0`)).toBeNull();
  });
});

describe("window coherence with the digest delta classifier", () => {
  it("the demotion window is strictly WIDER than the delta window", () => {
    // The two engines must not fire off the same evidence: a broken streak is
    // today's news, a month of non-adherence is a priority question.
    expect(DEMOTION_WINDOW_DAYS).toBeGreaterThan(INTAKE_DELTA_DAYS);
  });

  it("the thresholds stay in their documented ranges", () => {
    expect(DEMOTION_MAX_TAKEN_RATE).toBeGreaterThan(0);
    expect(DEMOTION_MAX_TAKEN_RATE).toBeLessThan(0.5);
    expect(DEMOTION_MIN_OCCURRENCES).toBeGreaterThanOrEqual(10);
  });
});
