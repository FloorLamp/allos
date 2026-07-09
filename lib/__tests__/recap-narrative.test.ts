import { describe, it, expect } from "vitest";
import {
  buildRecapNarrativePrompt,
  composeRecapNarrativeOffline,
  periodDaysFor,
  periodLabel,
  periodAdjective,
  RECAP_NARRATIVE_SYSTEM,
} from "../recap-narrative";
import { recapWindow, periodNounFor } from "../weekly-recap";
import type { WeeklyRecap } from "../weekly-recap";

function recap(over: Partial<WeeklyRecap> = {}): WeeklyRecap {
  return {
    start: "2026-07-03",
    end: "2026-07-09",
    headline: "4 workouts, 2 PRs",
    lines: [
      { key: "workouts", label: "Workouts", value: "4", delta: "3 last week" },
      { key: "prs", label: "PRs", value: "2", delta: "Bench press, Squat" },
      {
        key: "adherence",
        label: "Adherence",
        value: "90%",
        delta: "9/10 doses",
      },
    ],
    isEmpty: false,
    ...over,
  };
}

describe("period helpers", () => {
  it("maps periods to window lengths", () => {
    expect(periodDaysFor("week")).toBe(7);
    expect(periodDaysFor("month")).toBe(30);
  });

  it("labels and adjectives per period", () => {
    expect(periodLabel("week")).toBe("This week");
    expect(periodLabel("month")).toBe("This month");
    expect(periodAdjective("week")).toBe("weekly");
    expect(periodAdjective("month")).toBe("monthly");
  });
});

describe("recapWindow generalization (issue #20)", () => {
  it("defaults to a trailing 7-day window (unchanged)", () => {
    expect(recapWindow("2026-07-09")).toEqual({
      start: "2026-07-03",
      end: "2026-07-09",
      prevStart: "2026-06-26",
      prevEnd: "2026-07-02",
    });
  });

  it("spans an arbitrary period length with a matching prior window", () => {
    const w = recapWindow("2026-07-31", 30);
    expect(w.end).toBe("2026-07-31");
    expect(w.start).toBe("2026-07-02"); // 31 - 29
    expect(w.prevEnd).toBe("2026-07-01"); // 31 - 30
    expect(w.prevStart).toBe("2026-06-02"); // 31 - 59
  });

  it("names the period noun (7 -> week, 30 -> month, else period)", () => {
    expect(periodNounFor(7)).toBe("week");
    expect(periodNounFor(30)).toBe("month");
    expect(periodNounFor(31)).toBe("month");
    expect(periodNounFor(14)).toBe("period");
  });
});

describe("buildRecapNarrativePrompt", () => {
  it("frames the ask with the period, window, and profile name", () => {
    const p = buildRecapNarrativePrompt(recap(), "week", "Ada");
    expect(p).toContain("weekly recap for Ada");
    expect(p).toContain("2026-07-03 to 2026-07-09");
    expect(p).toContain("Headline: 4 workouts, 2 PRs");
  });

  it("fences the recap lines as data, one clause each", () => {
    const p = buildRecapNarrativePrompt(recap(), "month");
    expect(p).toContain("<<<BEGIN RECAP FACTS>>>");
    expect(p).toContain("<<<END RECAP FACTS>>>");
    expect(p).toContain("- Workouts: 4 (3 last week)");
    expect(p).toContain("- PRs: 2 (Bench press, Squat)");
    expect(p).toContain("monthly");
  });

  it("handles an empty recap without throwing", () => {
    const p = buildRecapNarrativePrompt(
      recap({ headline: "", lines: [], isEmpty: true }),
      "week"
    );
    expect(p).toContain("a quiet period");
    expect(p).toContain("No workouts, adherence, or body-weight readings");
  });

  it("does not name a model or leak instructions in the system prompt", () => {
    expect(RECAP_NARRATIVE_SYSTEM).not.toMatch(/claude|gpt|sonnet|opus/i);
    expect(RECAP_NARRATIVE_SYSTEM).toContain("clinician");
  });
});

describe("composeRecapNarrativeOffline", () => {
  it("renders a prose paragraph from the recap lines", () => {
    const out = composeRecapNarrativeOffline(recap(), "week");
    expect(out).toContain("2026-07-03 – 2026-07-09");
    expect(out).toContain("4 workouts, 2 PRs");
    expect(out).toContain("4 (3 last week) workouts");
    expect(out).toContain("Next week");
  });

  it("uses the month wording for a monthly recap", () => {
    const out = composeRecapNarrativeOffline(recap(), "month");
    expect(out).toContain("monthly recap");
    expect(out).toContain("Next month");
  });

  it("degrades to a single nudge line for an empty recap", () => {
    const out = composeRecapNarrativeOffline(
      recap({ headline: "", lines: [], isEmpty: true }),
      "week"
    );
    expect(out).toContain("is quiet");
    expect(out).toContain("next week");
    // No dangling "you logged" clause when there's nothing logged.
    expect(out).not.toContain("you logged");
  });
});
