// PURE TIER — the annual retrospective's window model (#2179) and the commemorative
// exemption it scopes into the recap line model.
//
// Three things are worth pinning here and nowhere else:
//
//   • WHICH WINDOW a year is asked over, including the two truncations a year can
//     suffer at once (data started inside it; it has not finished).
//   • THE EXEMPTION'S PRICE. A count is allowed at year scale as a RECORD, and in
//     exchange carries no comparison. The declaration is one thing; the fact that
//     `buildRecap` actually strips the comparison is another, and only the second is
//     what a reader sees.
//   • THAT THE YEAR IS NOT A CADENCE. The retrospective must never become a send.

import { describe, it, expect } from "vitest";
import {
  resolveRetrospectiveYear,
  retrospectiveCoverage,
  retrospectiveCoverageSentence,
  retrospectiveWindow,
  retrospectiveYears,
  yearEnd,
  yearStart,
} from "@/lib/retrospective";
import {
  buildRecap,
  countsAsRecordAt,
  lineSpeaksAt,
  periodFor,
  RECAP_LINE_MODEL,
  type RecapInput,
  type RecapLineKey,
} from "@/lib/recap";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";

describe("the retrospective window (#2179)", () => {
  it("bounds a calendar year", () => {
    expect(yearStart(2026)).toBe("2026-01-01");
    expect(yearEnd(2026)).toBe("2026-12-31");
    // The leap year is the one the naive `${y}-12-31` shortcut still gets right and
    // the naive "+365 days" shortcut does not.
    expect(yearEnd(2024)).toBe("2024-12-31");
  });

  it("asks a CLOSED year on the first day of the year after it", () => {
    const win = retrospectiveWindow(2025, "2026-08-13");
    expect(win).toEqual({
      year: 2025,
      asOf: "2026-01-01",
      completed: true,
      inProgress: false,
    });
    // …and that is what makes the engine resolve the whole calendar year, with the
    // whole prior calendar year as the comparison. Asked any other way it would not.
    const period = periodFor("year", win.asOf, "rolling", 0, win.completed);
    expect(period.start).toBe("2025-01-01");
    expect(period.end).toBe("2025-12-31");
    expect(period.prevStart).toBe("2024-01-01");
    expect(period.prevEnd).toBe("2024-12-31");
  });

  it("asks the year still running on today, in progress", () => {
    const win = retrospectiveWindow(2026, "2026-08-13");
    expect(win).toEqual({
      year: 2026,
      asOf: "2026-08-13",
      completed: false,
      inProgress: true,
    });
    const period = periodFor("year", win.asOf, "rolling", 0, win.completed);
    expect(period.start).toBe("2026-01-01");
    expect(period.end).toBe("2026-08-13");
    // The comparison is the whole year before, not a year-to-date slice of it. That is
    // the engine's own calendar rule and the retrospective inherits it unchanged.
    expect(period.prevStart).toBe("2025-01-01");
    expect(period.prevEnd).toBe("2025-12-31");
  });

  it("clamps a future year to the current one", () => {
    // Only reachable by a hand-edited URL, and an empty page for 2099 would be a lie
    // about a year that has not happened.
    expect(retrospectiveWindow(2099, "2026-08-13").year).toBe(2026);
  });
});

describe("which years the picker offers", () => {
  it("runs from the first logged day to the current year, newest first", () => {
    expect(retrospectiveYears("2023-04-02", "2026-08-13")).toEqual([
      2026, 2025, 2024, 2023,
    ]);
  });

  it("offers the current year even for a profile that has logged nothing", () => {
    // An empty retrospective is a legitimate answer; a picker with no options is a
    // broken page.
    expect(retrospectiveYears(null, "2026-08-13")).toEqual([2026]);
  });

  it("never offers a year after the current one, whatever the data says", () => {
    // A future-dated row (an import with a bad date, a planned entry) must not open a
    // retrospective for a year that has not happened.
    expect(retrospectiveYears("2031-01-01", "2026-08-13")).toEqual([2026]);
  });

  it("falls back to the newest offered year for anything unusable", () => {
    const years = [2026, 2025, 2024];
    expect(resolveRetrospectiveYear("2024", years)).toBe(2024);
    expect(resolveRetrospectiveYear("2019", years)).toBe(2026);
    expect(resolveRetrospectiveYear("banana", years)).toBe(2026);
    expect(resolveRetrospectiveYear(undefined, years)).toBe(2026);
    expect(resolveRetrospectiveYear("2025.5", years)).toBe(2026);
  });
});

describe("the honest partial window", () => {
  const prefs = DEFAULT_FORMAT_PREFS;

  it("says nothing about a whole, closed year", () => {
    const cov = retrospectiveCoverage(2025, "2019-01-01", "2026-08-13");
    expect(cov.partialStart).toBe(false);
    expect(cov.inProgress).toBe(false);
    expect(cov.from).toBe("2025-01-01");
    expect(cov.through).toBe("2025-12-31");
    expect(retrospectiveCoverageSentence(cov, prefs)).toBeNull();
  });

  it("names the day the data begins when it begins inside the year", () => {
    const cov = retrospectiveCoverage(2025, "2025-03-03", "2026-08-13");
    expect(cov.partialStart).toBe(true);
    expect(cov.from).toBe("2025-03-03");
    expect(retrospectiveCoverageSentence(cov, prefs)).toContain(
      "when your data begins"
    );
  });

  it("says the year is still running", () => {
    const cov = retrospectiveCoverage(2026, "2019-01-01", "2026-08-13");
    expect(cov.inProgress).toBe(true);
    expect(cov.through).toBe("2026-08-13");
    expect(retrospectiveCoverageSentence(cov, prefs)).toContain(
      "still running"
    );
  });

  it("states BOTH truncations when a first year is also the current one", () => {
    // The case a two-branch implementation silently drops half of: a profile that
    // started in March of the year it is still living in.
    const cov = retrospectiveCoverage(2026, "2026-03-03", "2026-08-13");
    expect(cov.partialStart).toBe(true);
    expect(cov.inProgress).toBe(true);
    const sentence = retrospectiveCoverageSentence(cov, prefs);
    expect(sentence).toContain("when your data begins");
    expect(sentence).toContain("still running");
  });
});

// ── The commemorative exemption ─────────────────────────────────────────────────

function yearInput(over: Partial<RecapInput> = {}): RecapInput {
  return {
    today: "2026-01-01",
    weightUnit: "kg",
    scale: "year",
    completed: true,
    workouts: [],
    prevWorkouts: [],
    prLabels: [],
    adherence: null,
    weights: [],
    goalsCompleted: [],
    ...over,
  };
}

const workoutsOn = (dates: string[]) =>
  dates.map((date) => ({ date, type: "strength" as const }));

describe("the commemorative exemption (#2179)", () => {
  it("admits the workout COUNT at year scale, which no other non-week scale gets", () => {
    expect(lineSpeaksAt("workouts", "year")).toBe(true);
    expect(lineSpeaksAt("workouts", "month")).toBe(false);
    expect(lineSpeaksAt("workouts", "quarter")).toBe(false);
  });

  it("strips the comparison off a count kept as a record", () => {
    // 5 workouts this year, 3 last year. A weekly recap would say "3 last week"; the
    // retrospective states the record and attaches nothing — "214 workouts, down from
    // 231" is exactly the verdict the exemption was scoped against.
    const recap = buildRecap(
      yearInput({
        workouts: workoutsOn([
          "2025-02-03",
          "2025-04-07",
          "2025-06-09",
          "2025-08-11",
          "2025-10-13",
        ]),
        prevWorkouts: workoutsOn(["2024-03-04", "2024-05-06", "2024-07-08"]),
      })
    );
    const line = recap.lines.find((l) => l.key === "workouts");
    expect(line?.value).toBe("5");
    expect(line?.comparison).toEqual({ kind: "none" });
    // Belt and braces: the comparison must not reappear anywhere the reader can see.
    expect(JSON.stringify(recap.lines)).not.toContain("last year");
  });

  it("keeps the comparison on a TRAJECTORY, which is what carries one", () => {
    // The exemption removes comparisons from COUNTS only. A composition share is a
    // direction, and a retrospective that could not say how the balance moved would
    // have lost the half of the year that is actually a trend.
    const recap = buildRecap(
      yearInput({
        workouts: [
          ...workoutsOn(["2025-02-03", "2025-04-07", "2025-06-09"]),
          { date: "2025-08-11", type: "cardio" as const },
        ],
        prevWorkouts: [
          ...workoutsOn(["2024-03-04", "2024-05-06"]),
          { date: "2024-07-08", type: "cardio" as const },
          { date: "2024-09-09", type: "cardio" as const },
        ],
      })
    );
    const mix = recap.lines.find((l) => l.key === "training-mix");
    expect(mix?.comparison.kind).toBe("prior");
    expect(countsAsRecordAt("training-mix", "year")).toBe(false);
  });

  it("gives every exempt line a comparison-free result at year scale", () => {
    // The declaration and the behaviour, checked against each other over the whole
    // registry rather than for the one line the author happened to think of.
    const exempt = (Object.keys(RECAP_LINE_MODEL) as RecapLineKey[]).filter(
      (k) => countsAsRecordAt(k, "year")
    );
    expect(exempt.length).toBeGreaterThan(0);
    for (const key of exempt) {
      // An exempt line must speak at the scale it is exempt for — otherwise the
      // declaration is dead text nothing enforces.
      expect(lineSpeaksAt(key, "year"), key).toBe(true);
    }
    const recap = buildRecap(
      yearInput({
        workouts: workoutsOn([
          "2025-02-03",
          "2025-04-07",
          "2025-06-09",
          "2025-08-11",
        ]),
        prevWorkouts: workoutsOn(["2024-03-04"]),
        prLabels: ["Bench press", "Back squat"],
        goalsCompleted: ["Run a half marathon"],
        goalsMissed: ["Sleep 8 hours"],
      })
    );
    for (const line of recap.lines)
      if (countsAsRecordAt(line.key, "year"))
        expect(line.comparison, line.key).toEqual({ kind: "none" });
  });

  it("leads the headline with the year's counts", () => {
    // The genre's point: "214 workouts, 12 PRs". The headline already obeys the scale
    // declaration, so admitting the count line is what puts it there.
    const recap = buildRecap(
      yearInput({
        workouts: workoutsOn([
          "2025-02-03",
          "2025-04-07",
          "2025-06-09",
          "2025-08-11",
        ]),
        prLabels: ["Bench press"],
      })
    );
    expect(recap.headline).toContain("4 workouts");
    expect(recap.headline).toContain("1 PR");
  });
});

describe("the year is a scale and not a review", () => {
  it("withholds the lines a year would misreport", () => {
    // Two lines speak at quarter and are deliberately silent at year, each for its own
    // stated reason: an annual adherence shape averages away the drift it exists to
    // show, and the SRI is a trailing 28-night index — LAST MONTH's fact, which must
    // not be printed as twelve months of regularity.
    expect(lineSpeaksAt("adherence-pattern", "quarter")).toBe(true);
    expect(lineSpeaksAt("adherence-pattern", "year")).toBe(false);
    expect(lineSpeaksAt("sleepRegularity", "quarter")).toBe(true);
    expect(lineSpeaksAt("sleepRegularity", "year")).toBe(false);
  });

  it("pins the year's line set, so widening it stays a decision", () => {
    // What a retrospective is MADE OF is the owner-visible half of #2179, not an
    // implementation detail: the commemorative counts, the long arcs, and the recovery
    // context they are read against. A new line reaching year scale should fail here
    // and be argued for, exactly as #1935's coverage rule is argued for at week scale.
    const speaking = (Object.keys(RECAP_LINE_MODEL) as RecapLineKey[])
      .filter((k) => lineSpeaksAt(k, "year"))
      .sort();
    expect(speaking).toEqual([
      "fitness-check",
      "goals",
      "goals-missed",
      "prs",
      "recovery",
      "sleep-duration",
      "training-mix",
      "weight-trajectory",
      "workouts",
    ]);
    // And each of them says why it is there — the house rule for every registry.
    for (const key of speaking)
      expect(RECAP_LINE_MODEL[key].why.trim().length, key).toBeGreaterThan(40);
  });
});
