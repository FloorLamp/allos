import { describe, it, expect } from "vitest";
import {
  frequencyRangeState,
  shouldNudgePractice,
  practiceCadenceText,
  practiceSignalKey,
  PRACTICE_SIGNAL_PREFIX,
  PRACTICE_STARTER_LIST,
  normalizePracticeName,
} from "@/lib/practice";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import { resolveSuppressedKeyDisplay } from "@/lib/suppression-display";

describe("frequencyRangeState (#1259 range semantics)", () => {
  it("a single-floor target is unchanged: met at the floor, no ceiling", () => {
    // Mid-week (day 4), floor 3, no ceiling.
    expect(frequencyRangeState(3, 3, null, 4)).toEqual({
      met: true,
      atCeiling: false,
      pace: "met",
    });
    expect(frequencyRangeState(2, 3, null, 4)).toMatchObject({
      met: false,
      atCeiling: false,
    });
  });

  it("a range target reaches the ceiling (calm 'that's plenty', never a red state)", () => {
    // floor 3, ceiling 5. At 5 the week is DONE (atCeiling), at 3–4 it's met but not
    // at ceiling, below 3 it's behind.
    expect(frequencyRangeState(5, 3, 5, 7)).toMatchObject({
      met: true,
      atCeiling: true,
    });
    expect(frequencyRangeState(6, 3, 5, 7)).toMatchObject({
      met: true,
      atCeiling: true,
    });
    expect(frequencyRangeState(4, 3, 5, 7)).toMatchObject({
      met: true,
      atCeiling: false,
    });
    expect(frequencyRangeState(1, 3, 5, 7)).toMatchObject({
      met: false,
      atCeiling: false,
    });
  });
});

describe("shouldNudgePractice (#1259 pace-aware nudge)", () => {
  it("nags when behind the floor's pace and quiet otherwise", () => {
    // Late in the week (day 7), floor 3, count 1 → behind → nudge.
    expect(shouldNudgePractice(1, 3, 5, 7)).toBe(true);
    // On pace (count keeps up with elapsed share) → quiet.
    expect(shouldNudgePractice(3, 3, 5, 7)).toBe(false);
    // Early week grace: day 1, floor 3, count 0 → owed floor(3*1/7)=0 → on-pace → quiet.
    expect(shouldNudgePractice(0, 3, 5, 1)).toBe(false);
  });

  it("is SILENT at/above the ceiling even if pace math would flag it", () => {
    // A dose-limited practice at its ceiling is never pushed toward more.
    expect(shouldNudgePractice(5, 3, 5, 7)).toBe(false);
    expect(shouldNudgePractice(6, 3, 5, 7)).toBe(false);
  });

  it("is quiet once the floor is met", () => {
    expect(shouldNudgePractice(4, 3, 5, 7)).toBe(false);
  });
});

describe("practiceCadenceText", () => {
  it("renders a bare floor and a range", () => {
    expect(practiceCadenceText(3, null)).toBe("3×/week");
    expect(practiceCadenceText(3, 5)).toBe("3–5×/week");
    // A max equal to the floor is not a range.
    expect(practiceCadenceText(3, 3)).toBe("3×/week");
  });
});

describe("practice identity + dedupeKey namespace (#1259)", () => {
  it("keys signals under the practice namespace", () => {
    expect(practiceSignalKey(42)).toBe("practice:42");
    expect(practiceSignalKey(42).startsWith(PRACTICE_SIGNAL_PREFIX)).toBe(true);
  });

  it("the practice: signal key resolves against the suppression-display registry", () => {
    // The Upcoming twin's dedupeKey must be a KNOWN namespace so the page dismiss
    // guard matches it (the #227 bus pattern). It is NOT a rule-findings builder
    // namespace (that registry is for collectCoachingFindings builders).
    expect(resolveSuppressedKeyDisplay(practiceSignalKey(7))?.domain).toBe(
      "Due & scheduled"
    );
    expect(dedupeKeyHasKnownPrefix(practiceSignalKey(7))).toBe(false);
  });

  it("normalizes practice names (collapse whitespace, trim)", () => {
    expect(normalizePracticeName("  Red   light  therapy ")).toBe(
      "Red light therapy"
    );
    expect(normalizePracticeName("")).toBe("");
    expect(normalizePracticeName(null)).toBe("");
  });

  it("ships the curated starter list (#1259)", () => {
    expect(PRACTICE_STARTER_LIST).toContain("Red light therapy");
    expect(PRACTICE_STARTER_LIST).toContain("Sauna");
    expect(PRACTICE_STARTER_LIST.length).toBeGreaterThanOrEqual(6);
  });
});
