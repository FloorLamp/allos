import { describe, it, expect } from "vitest";
import {
  practiceShortfallLine,
  type BehindPractice,
} from "@/lib/notifications/practices";
import {
  frequencyRangeState,
  shouldNudgePractice,
  practiceCadenceText,
  practiceSignalKey,
  PRACTICE_SIGNAL_PREFIX,
  PRACTICE_STARTER_LIST,
  normalizePracticeName,
  practiceIdentity,
  samePractice,
  previousPracticeDuration,
  validatePracticeCadence,
  groupPracticeSpellings,
  practiceSpellingsFor,
  practiceDisplayName,
  practiceLogOutcomeText,
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

describe("validatePracticeCadence (#1619)", () => {
  it("accepts an ordered range or a minimum without a maximum unchanged", () => {
    expect(validatePracticeCadence(3, 5)).toEqual({
      ok: true,
      floor: 3,
      ceiling: 5,
    });
    expect(validatePracticeCadence(3, null)).toEqual({
      ok: true,
      floor: 3,
      ceiling: null,
    });
  });

  it("rejects reversed, equal, and out-of-range values instead of normalizing them", () => {
    expect(validatePracticeCadence(5, 3)).toEqual({
      ok: false,
      reason: "maximum-order",
    });
    expect(validatePracticeCadence(3, 3)).toEqual({
      ok: false,
      reason: "maximum-order",
    });
    expect(validatePracticeCadence(40, null)).toEqual({
      ok: false,
      reason: "minimum-range",
    });
    expect(validatePracticeCadence(0, null)).toEqual({
      ok: false,
      reason: "minimum-range",
    });
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

  it("collapses only case/whitespace identity variants", () => {
    expect(practiceIdentity("  Red   Light Therapy ")).toBe(
      "red light therapy"
    );
    expect(samePractice("Sauna", "  SAUNA ")).toBe(true);
    expect(samePractice("Breathwork", "Breath work")).toBe(false);
    expect(samePractice("", "")).toBe(false);
  });

  it("groups each identity's exact stored spellings once with a bounded family", () => {
    const grouped = groupPracticeSpellings(
      ["Sauna", " sauna ", "SAUNA", "Meditation", "MEDITATION", "", "Sauna"],
      2
    );
    expect(grouped.get("sauna")).toEqual(["Sauna", " sauna "]);
    expect(grouped.get("meditation")).toEqual(["Meditation", "MEDITATION"]);
    expect(practiceSpellingsFor(grouped, " SAUNA ")).toEqual([
      "SAUNA",
      "Sauna",
      " sauna ",
    ]);
    expect(grouped.has("")).toBe(false);
  });

  it("prefills duration from the immediately previous session only", () => {
    expect(previousPracticeDuration([{ duration_min: 20 }])).toBe(20);
    expect(
      previousPracticeDuration([{ duration_min: null }, { duration_min: 20 }])
    ).toBeNull();
    expect(previousPracticeDuration([])).toBeNull();
  });

  it("ships the curated starter list (#1259)", () => {
    expect(PRACTICE_STARTER_LIST).toContain("Red light therapy");
    expect(PRACTICE_STARTER_LIST).toContain("Sauna");
    expect(PRACTICE_STARTER_LIST.length).toBeGreaterThanOrEqual(6);
  });
});

// The ONE display-name decision for a practice identity (#1595): the Wellness card
// and the search palette must name a practice the same way, and a practice's stored
// spellings can disagree ("Cold plunge" as the target, "cold  plunge" on the log).
describe("practiceDisplayName", () => {
  it("prefers the target's spelling — the one the user typed when setting cadence", () => {
    expect(
      practiceDisplayName({
        targetSpelling: "Cold plunge",
        latestSpelling: "cold  plunge",
        identity: practiceIdentity("Cold plunge"),
      })
    ).toBe("Cold plunge");
  });

  it("falls back to the newest session's spelling for a logs-only practice", () => {
    expect(
      practiceDisplayName({
        targetSpelling: null,
        latestSpelling: " Breathwork ",
        identity: practiceIdentity("breathwork"),
      })
    ).toBe("Breathwork");
  });

  it("falls back to the folded identity when no spelling survives", () => {
    expect(
      practiceDisplayName({
        targetSpelling: "   ",
        latestSpelling: null,
        identity: "sauna",
      })
    ).toBe("sauna");
  });
});

describe("practiceLogOutcomeText (#1633)", () => {
  it("reports the day's running count on a fresh log", () => {
    expect(
      practiceLogOutcomeText({ kind: "logged", count: 1, date: "2026-07-30" })
    ).toBe("Logged today's session");
    expect(
      practiceLogOutcomeText({ kind: "logged", count: 3, date: "2026-07-30" })
    ).toBe("Logged — 3 sessions today");
  });

  it("never confirms an outcome that wrote nothing", () => {
    // A session log is not idempotent, so silence-as-success is a lie: every non-logged
    // branch has to say so, on every surface that shares this one sentence.
    for (const outcome of [
      { kind: "invalid-date" },
      { kind: "stale-target" },
    ] as const) {
      expect(practiceLogOutcomeText(outcome)).toBe(
        "Couldn't log that session."
      );
    }
  });
});

// ---- The copy sweep's practice items (issue #1722 item 5) ----
describe("practice nudge copy (#1722)", () => {
  const behind = (over: Partial<BehindPractice> = {}): BehindPractice => ({
    targetId: 1,
    name: "Meditation",
    count: 2,
    floor: 3,
    ceiling: null,
    ...over,
  });

  it("states a verdict and the next step, not a bare ratio", () => {
    expect(practiceShortfallLine(behind())).toBe(
      "Meditation — 2 of 3 this week, one more to go"
    );
    expect(practiceShortfallLine(behind({ count: 0 }))).toBe(
      "Meditation — 0 of 3 this week, 3 more to go"
    );
  });

  it("says nothing about a next step when there is nothing true to say", () => {
    // At/over the floor the gather has already excluded the target; if one reaches
    // the formatter anyway it states the numbers and stops.
    expect(practiceShortfallLine(behind({ count: 3 }))).toBe(
      "Meditation — 3 of 3 this week"
    );
  });
});
