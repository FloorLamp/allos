// PURE TIER — the digest delta classifier (#1505 part 3): which pushed obligations
// changed state, and the one line every digest channel formats from the result.
// All fixture values synthetic — no real PHI.

import { describe, it, expect } from "vitest";
import type { AdherenceDot, AdherenceState } from "@/lib/intake-adherence";
import {
  classifyIntakeDelta,
  classifyIntakeDeltas,
  hasIntakeDeltas,
  intakeDeltaLine,
  intakeGapExplainedBy,
  INTAKE_DELTA_MAX_NAMED,
  NOTABLE_MISS_MIN_STREAK,
  RESUMED_MIN_MISS_RUN,
} from "@/lib/intake-deltas";

function strip(states: AdherenceState[]): AdherenceDot[] {
  return states.map((state, i) => ({
    date: `1990-02-${String(i + 1).padStart(2, "0")}`,
    state,
  }));
}

const T: AdherenceState = "taken";
const M: AdherenceState = "missed";
const NA: AdherenceState = "na";
const SK: AdherenceState = "skipped";

function one(states: AdherenceState[], name = "Magnesium (test)") {
  return classifyIntakeDelta({ itemId: 1, name, strip: strip(states) });
}

describe("classifyIntakeDelta — notably missed", () => {
  it("a broken taken-streak is news, reported with the miss-run length", () => {
    expect(one([T, T, T, T, M, M, M])).toEqual({
      kind: "missed",
      itemId: 1,
      name: "Magnesium (test)",
      days: 3,
      // The run's most recent missed occurrence (#3033).
      date: "1990-02-07",
    });
  });

  it("a single miss after a qualifying streak still counts (day one of a lapse)", () => {
    expect(one([T, T, T, M])?.days).toBe(1);
  });

  it("holds fire when there was no streak to break", () => {
    const tooShort = Array<AdherenceState>(NOTABLE_MISS_MIN_STREAK - 1).fill(T);
    expect(one([...tooShort, M, M])).toBeNull();
  });

  it("a chronically-erratic item produces nothing — there is no habit to break", () => {
    expect(one([T, M, T, M, T, M, M])).toBeNull();
  });
});

describe("classifyIntakeDelta — resumed", () => {
  it("taken again after a real lapse is news, reported with the lapse length", () => {
    expect(one([T, T, M, M, M, T])).toEqual({
      kind: "resumed",
      itemId: 1,
      name: "Magnesium (test)",
      days: 3,
      // The last miss of the lapse the trailing take ended (#3033).
      date: "1990-02-05",
    });
  });

  it("a one-day gap is not a comeback", () => {
    expect(RESUMED_MIN_MISS_RUN).toBe(2);
    expect(one([T, T, T, M, T])).toBeNull();
  });

  it("an unbroken run of takes says nothing — silence is the quiet-day answer", () => {
    expect(one([T, T, T, T, T, T])).toBeNull();
  });

  it("counts the lapse behind a multi-day resumption, not only the last day", () => {
    expect(one([T, M, M, M, T, T])?.days).toBe(3);
  });
});

describe("classifyIntakeDelta — transparent days", () => {
  it("'na' (not due) and deliberate 'skipped' days never break or make a run", () => {
    // The same sequence as the notable-miss case, padded with not-due and skipped
    // days: the run lengths count SCHEDULED occurrences, not calendar days.
    expect(one([T, NA, T, SK, T, NA, M, SK, M])).toEqual({
      kind: "missed",
      itemId: 1,
      name: "Magnesium (test)",
      days: 2,
      date: "1990-02-09",
    });
  });

  it("an all-'na' window (nothing was ever due) produces nothing", () => {
    expect(one([NA, NA, NA, NA])).toBeNull();
  });

  it("an empty strip produces nothing", () => {
    expect(
      classifyIntakeDelta({ itemId: 1, name: "X (test)", strip: [] })
    ).toBeNull();
  });
});

describe("classifyIntakeDeltas", () => {
  it("splits by kind and orders deterministically by name, then id", () => {
    const deltas = classifyIntakeDeltas([
      { itemId: 3, name: "Zinc (test)", strip: strip([T, T, M, M, T]) },
      { itemId: 1, name: "Magnesium (test)", strip: strip([T, T, T, M, M]) },
      { itemId: 2, name: "Creatine (test)", strip: strip([T, T, T, T, M]) },
      { itemId: 4, name: "Quiet (test)", strip: strip([T, T, T, T, T]) },
    ]);
    expect(deltas.missed.map((d) => d.name)).toEqual([
      "Creatine (test)",
      "Magnesium (test)",
    ]);
    expect(deltas.resumed.map((d) => d.name)).toEqual(["Zinc (test)"]);
    expect(hasIntakeDeltas(deltas)).toBe(true);
  });

  it("a quiet window classifies to nothing at all", () => {
    const deltas = classifyIntakeDeltas([
      { itemId: 1, name: "Steady (test)", strip: strip([T, T, T, T, T]) },
    ]);
    expect(hasIntakeDeltas(deltas)).toBe(false);
    expect(intakeDeltaLine(deltas)).toBeNull();
  });
});

describe("intakeDeltaLine — the one formatter", () => {
  it("renders both halves in one line", () => {
    const deltas = classifyIntakeDeltas([
      { itemId: 1, name: "Magnesium (test)", strip: strip([T, T, T, M, M, M]) },
      { itemId: 2, name: "Vitamin D (test)", strip: strip([T, M, M, T]) },
    ]);
    expect(intakeDeltaLine(deltas)).toBe(
      "Missed: Magnesium (test) for 3 days · Resumed: Vitamin D (test) after 2 days missed"
    );
  });

  it("singularizes a one-day run", () => {
    const deltas = classifyIntakeDeltas([
      { itemId: 1, name: "Magnesium (test)", strip: strip([T, T, T, M]) },
    ]);
    expect(intakeDeltaLine(deltas)).toBe("Missed: Magnesium (test) for 1 day");
  });

  it("aggregates past the naming cap so the line stays a line (#4228 C)", () => {
    const many = Array.from({ length: INTAKE_DELTA_MAX_NAMED + 2 }, (_, i) => ({
      itemId: i + 1,
      name: `Item ${String.fromCharCode(65 + i)} (test)`,
      strip: strip([T, T, T, M]),
    }));
    // Five items past a cap of three: a count plus the one shared run, never "+2
    // more" — which chose the named three alphabetically and reported one event
    // five times.
    expect(intakeDeltaLine(classifyIntakeDeltas(many))).toBe(
      "Missed: 5 supplements for 1 day"
    );
  });
});

// ---- Past the name cap, a half aggregates (#4228 C) -------------------------
//
// At or below INTAKE_DELTA_MAX_NAMED the per-item form and the #3487 hoist are
// byte-identical to before (pinned above); the boundary itself is pinned here.
describe("intakeDeltaLine — a half with more than INTAKE_DELTA_MAX_NAMED items aggregates (#4228 C)", () => {
  // `runs[i]` misses (or, for a resume, the lapse length) per item, names A, B, C…
  const items = (runs: number[], resumed = false) =>
    classifyIntakeDeltas(
      runs.map((n, i) => ({
        itemId: i + 1,
        name: `Item ${String.fromCharCode(65 + i)} (test)`,
        strip: strip(
          resumed
            ? [T, ...Array<AdherenceState>(n).fill(M), T]
            : [T, T, T, ...Array<AdherenceState>(n).fill(M)]
        ),
      }))
    );

  it.each([
    // [runs, resumed, expected]
    [
      [1, 2, 3],
      false,
      "Missed: Item A (test) for 1 day, Item B (test) for 2 days, Item C (test) for 3 days",
    ],
    [
      [2, 2, 2],
      false,
      "Missed for 2 days: Item A (test), Item B (test), Item C (test)",
    ],
    [[1, 2, 3, 4], false, "Missed: 4 supplements for 1–4 days"],
    [[3, 3, 3, 3, 3], false, "Missed: 5 supplements for 3 days"],
    [
      [4, 8, 7, 2, 5, 6, 3, 4, 8, 7, 5],
      true,
      "Resumed: 11 supplements after 2–8 days missed",
    ],
    [[2, 2, 2, 2], true, "Resumed: 4 supplements after 2 days missed"],
  ] as const)("%j resumed=%s → %s", (runs, resumed, expected) => {
    expect(intakeDeltaLine(items([...runs], resumed))).toBe(expected);
  });

  it("a uniform aggregate keeps the window's day name — the run, not the count, is what #3033 named", () => {
    const week = { start: "1990-02-01", end: "1990-02-07" };
    // Four items all missed 1990-02-04 (a Sunday) once.
    expect(intakeDeltaLine(items([1, 1, 1, 1]), week)).toBe(
      "Missed: 4 supplements on Sunday"
    );
  });
});

// ---- Uniform runs are stated once (#3487 item 3) ---------------------------
//
// The formatter is SHARED — the Telegram morning digest, the weekly recap and the
// household card all render it — so the grouping lands on all three at once, which
// is why it belongs here and not on a surface.
describe("intakeDeltaLine — a uniform run is hoisted into the label (#3487)", () => {
  const missedFor = (days: number, names: string[]) =>
    classifyIntakeDeltas(
      names.map((name, i) => ({
        itemId: i + 1,
        name,
        // Three taken occurrences (the notable-miss floor) then `days` misses.
        strip: strip([T, T, T, ...Array<AdherenceState>(days).fill(M)]),
      }))
    );

  it("names the shared duration once and then only the items", () => {
    expect(intakeDeltaLine(missedFor(1, ["Zinc (test)", "Iron (test)"]))).toBe(
      "Missed for 1 day: Iron (test), Zinc (test)"
    );
  });

  it("pluralizes the hoisted run the same way the per-item form does", () => {
    expect(intakeDeltaLine(missedFor(3, ["Zinc (test)", "Iron (test)"]))).toBe(
      "Missed for 3 days: Iron (test), Zinc (test)"
    );
  });

  it("keeps the per-item form when the runs differ", () => {
    const mixed = classifyIntakeDeltas([
      { itemId: 1, name: "Iron (test)", strip: strip([T, T, T, M]) },
      { itemId: 2, name: "Zinc (test)", strip: strip([T, T, T, M, M]) },
    ]);
    expect(intakeDeltaLine(mixed)).toBe(
      "Missed: Iron (test) for 1 day, Zinc (test) for 2 days"
    );
  });

  it("judges uniformity over ALL items, not a named sample", () => {
    // Four items: three missed one day, the fourth missed two. Past the cap the half
    // aggregates (#4228 C), and the range has to reach the fourth item — a hoisted
    // "for 1 day" judged off three would state a duration the fourth contradicts.
    const items = [
      { itemId: 1, name: "Item A (test)", strip: strip([T, T, T, M]) },
      { itemId: 2, name: "Item B (test)", strip: strip([T, T, T, M]) },
      { itemId: 3, name: "Item C (test)", strip: strip([T, T, T, M]) },
      { itemId: 4, name: "Item D (test)", strip: strip([T, T, T, M, M]) },
    ];
    expect(intakeDeltaLine(classifyIntakeDeltas(items))).toBe(
      "Missed: 4 supplements for 1–2 days"
    );
  });

  it("leaves a ONE-item half alone — nothing is repeated, and #1819's merge clause quotes it", () => {
    const one = classifyIntakeDeltas([
      { itemId: 1, name: "Glycine (test)", strip: strip([T, T, T, M]) },
    ]);
    expect(intakeDeltaLine(one)).toBe("Missed: Glycine (test) for 1 day");
  });

  it("groups each half independently", () => {
    const both = classifyIntakeDeltas([
      { itemId: 1, name: "Iron (test)", strip: strip([T, T, T, M]) },
      { itemId: 2, name: "Zinc (test)", strip: strip([T, T, T, M]) },
      { itemId: 3, name: "Vitamin D (test)", strip: strip([T, M, M, T]) },
    ]);
    expect(intakeDeltaLine(both)).toBe(
      "Missed for 1 day: Iron (test), Zinc (test) · Resumed: Vitamin D (test) after 2 days missed"
    );
  });

  it("hoists a shared lapse on the resumed half in the lapse direction too (#4228 B)", () => {
    const both = classifyIntakeDeltas([
      { itemId: 1, name: "Iron (test)", strip: strip([T, M, M, T]) },
      { itemId: 2, name: "Zinc (test)", strip: strip([T, M, M, T]) },
    ]);
    expect(intakeDeltaLine(both)).toBe(
      "Resumed after 2 days missed: Iron (test), Zinc (test)"
    );
  });

  it("hoists a shared DAY name too, when the window resolves the run to one (#3033)", () => {
    // Both missed 1990-02-04 only, inside a week-scale window: the run phrase is the
    // weekday, and it is the same phrase for both, so it hoists exactly as a duration
    // does. The grouping is over the RENDERED run, not over `days`.
    const week = { start: "1990-02-01", end: "1990-02-07" };
    const sunday = classifyIntakeDeltas([
      { itemId: 1, name: "Iron (test)", strip: strip([T, T, T, M]) },
      { itemId: 2, name: "Zinc (test)", strip: strip([T, T, T, M]) },
    ]);
    expect(intakeDeltaLine(sunday, week)).toBe(
      "Missed on Sunday: Iron (test), Zinc (test)"
    );
  });
});

// ---- The reporting window (#3033) -----------------------------------------
//
// A single-occurrence miss inside a MULTI-DAY report window names its day; the
// day-scale callers (the digest, the household card) pass no window and their
// copy is byte-identical to before. Resolved inside the formatter as a function
// of the window — not a per-caller flag, not a second phrasing.
describe("intakeDeltaLine — the reporting window names a one-occurrence miss's day (#3033)", () => {
  const week = { start: "1990-02-01", end: "1990-02-07" };
  const missSunday = classifyIntakeDeltas([
    // Miss on 1990-02-04, a Sunday.
    { itemId: 1, name: "Coenzyme Q10 (test)", strip: strip([T, T, T, M]) },
  ]);

  it("names the weekday for a miss inside the window", () => {
    expect(intakeDeltaLine(missSunday, week)).toBe(
      "Missed: Coenzyme Q10 (test) on Sunday"
    );
  });

  it("dates a miss BEYOND the window — the classifier looks back further than a week", () => {
    const laterWeek = { start: "1990-02-05", end: "1990-02-11" };
    expect(intakeDeltaLine(missSunday, laterWeek)).toBe(
      "Missed: Coenzyme Q10 (test) on Sun, Feb 4, 1990"
    );
  });

  it("keeps 'for N days' for a multi-occurrence run", () => {
    const deltas = classifyIntakeDeltas([
      { itemId: 1, name: "Magnesium (test)", strip: strip([T, T, T, M, M, M]) },
    ]);
    expect(intakeDeltaLine(deltas, week)).toBe(
      "Missed: Magnesium (test) for 3 days"
    );
  });

  it("day-scale callers are unchanged — no window, no day name", () => {
    expect(intakeDeltaLine(missSunday)).toBe(
      "Missed: Coenzyme Q10 (test) for 1 day"
    );
  });

  it("a cadenced item's one missed occurrence names its actual day", () => {
    // Due every other day: 'na' days are transparent, so the run is ONE scheduled
    // occurrence — and the day named is the miss's own calendar day (1990-02-07,
    // a Wednesday), which "for 1 day" could never say.
    const deltas = classifyIntakeDeltas([
      {
        itemId: 1,
        name: "Weekly (test)",
        strip: strip([T, NA, T, NA, T, NA, M]),
      },
    ]);
    expect(intakeDeltaLine(deltas, week)).toBe(
      "Missed: Weekly (test) on Wednesday"
    );
  });

  it("a resumed run states its lapse — only a one-occurrence miss names a day", () => {
    const deltas = classifyIntakeDeltas([
      { itemId: 2, name: "Vitamin D (test)", strip: strip([T, M, M, T]) },
    ]);
    expect(intakeDeltaLine(deltas, week)).toBe(
      "Resumed: Vitamin D (test) after 2 days missed"
    );
  });

  it("a lapse longer than the report window is coherent: it began before the window (#4228 B)", () => {
    // Eight misses then a take, reported over a seven-day window. "for 8 days" fit
    // neither reading of a week; "after 8 days missed" says which way the number
    // points, and a lapse that outruns the window is then simply an older lapse.
    const deltas = classifyIntakeDeltas([
      {
        itemId: 1,
        name: "Beta-Glucan (test)",
        strip: strip([T, ...Array<AdherenceState>(8).fill(M), T]),
      },
    ]);
    expect(intakeDeltaLine(deltas, week)).toBe(
      "Resumed: Beta-Glucan (test) after 8 days missed"
    );
  });
});

// ---- The merge test (#1819 item 6) ---------------------------------------

describe("intakeGapExplainedBy — when the delta and the fraction say one thing", () => {
  const missedOne = classifyIntakeDeltas([
    { itemId: 1, name: "Glycine (test)", strip: strip([T, T, T, M]) },
  ]);

  it("returns the clause the fraction absorbs when one miss explains a gap of one", () => {
    expect(intakeGapExplainedBy(missedOne, 1)).toBe(
      "missed Glycine (test) for 1 day"
    );
  });

  it("declines when the gap is bigger than the one item that changed state", () => {
    expect(intakeGapExplainedBy(missedOne, 2)).toBeNull();
    expect(intakeGapExplainedBy(missedOne, 0)).toBeNull();
  });

  it("declines on several misses — two names cannot ride one fraction", () => {
    const two = classifyIntakeDeltas([
      { itemId: 1, name: "Glycine (test)", strip: strip([T, T, T, M]) },
      { itemId: 2, name: "Magnesium (test)", strip: strip([T, T, T, M]) },
    ]);
    expect(intakeGapExplainedBy(two, 1)).toBeNull();
  });

  it("declines on a RESUME — a resumption is not the reason a dose is missing", () => {
    const mixed = classifyIntakeDeltas([
      { itemId: 1, name: "Glycine (test)", strip: strip([T, T, T, M]) },
      { itemId: 2, name: "Vitamin D (test)", strip: strip([T, M, M, T]) },
    ]);
    expect(intakeGapExplainedBy(mixed, 1)).toBeNull();
  });

  it("declines on a quiet window — there is no delta to merge", () => {
    expect(intakeGapExplainedBy({ missed: [], resumed: [] }, 1)).toBeNull();
  });

  it("words the clause exactly as the shared delta formatter words its half", () => {
    const clause = intakeGapExplainedBy(missedOne, 1)!;
    expect(intakeDeltaLine(missedOne)).toBe(
      `Missed: ${clause.replace("missed ", "")}`
    );
  });
});
