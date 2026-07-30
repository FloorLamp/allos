// PURE TIER — the digest delta classifier (#1505 part 3): which pushed obligations
// changed state, and the one line every digest channel formats from the result.
// All fixture values synthetic — no real PHI.

import { describe, it, expect } from "vitest";
import type { AdherenceDot, AdherenceState } from "@/lib/supplement-adherence";
import {
  classifyIntakeDelta,
  classifyIntakeDeltas,
  hasIntakeDeltas,
  intakeDeltaLine,
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
      "Missed: Magnesium (test) (3 days) · Resumed: Vitamin D (test) (2 days)"
    );
  });

  it("singularizes a one-day run", () => {
    const deltas = classifyIntakeDeltas([
      { itemId: 1, name: "Magnesium (test)", strip: strip([T, T, T, M]) },
    ]);
    expect(intakeDeltaLine(deltas)).toBe("Missed: Magnesium (test) (1 day)");
  });

  it("collapses past the naming cap so the line stays a line", () => {
    const many = Array.from({ length: INTAKE_DELTA_MAX_NAMED + 2 }, (_, i) => ({
      itemId: i + 1,
      name: `Item ${String.fromCharCode(65 + i)} (test)`,
      strip: strip([T, T, T, M]),
    }));
    const line = intakeDeltaLine(classifyIntakeDeltas(many))!;
    expect(line).toContain("+2 more");
    expect(line.startsWith("Missed: Item A (test) (1 day)")).toBe(true);
  });
});
