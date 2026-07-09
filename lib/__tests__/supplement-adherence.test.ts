import { describe, it, expect } from "vitest";
import {
  adherenceSummary,
  doseStrip,
  indexTakenByDose,
  type AdherenceState,
} from "@/lib/supplement-adherence";

// Build a strip (oldest-first) from a compact state string: each char maps to a
// state, so "mttt" is [missed, taken, taken, taken] with the last as today.
const S: Record<string, AdherenceState> = {
  t: "taken",
  p: "partial",
  m: "missed",
  n: "na",
};
const strip = (s: string) =>
  [...s].map((c, i) => ({ date: `d${i}`, state: S[c] }));

describe("adherenceSummary", () => {
  it("counts a full window as a complete streak at 100%", () => {
    const r = adherenceSummary(strip("tttttttttttttt"));
    expect(r).toMatchObject({ streak: 14, pct: 100, applicableDays: 14 });
  });

  it("treats an untaken today (trailing missed) as pending, not a break", () => {
    // 5 taken, today not logged yet.
    const r = adherenceSummary(strip("tttttm"));
    expect(r.streak).toBe(5);
  });

  it("excludes a still-pending today from the percentage, not just the streak", () => {
    // 4 taken, today not logged yet → a perfect record reads 100%, not 80%.
    const r = adherenceSummary(strip("ttttm"));
    expect(r.pct).toBe(100);
    expect(r.streak).toBe(4);
    expect(r.applicableDays).toBe(4);
  });

  it("counts today when it is already taken", () => {
    const r = adherenceSummary(strip("tttttt"));
    expect(r.streak).toBe(6);
  });

  it("ends the streak on a real missed day mid-window", () => {
    // ...taken, missed, taken, taken (today taken) → streak of 2.
    const r = adherenceSummary(strip("ttmtt"));
    expect(r.streak).toBe(2);
  });

  it("treats na days as transparent to the streak", () => {
    // taken, na, taken, na, taken(today) → streak spans the na gaps = 3.
    const r = adherenceSummary(strip("tntnt"));
    expect(r.streak).toBe(3);
  });

  it("keeps the streak alive through a partial day", () => {
    // taken, taken, partial, taken, taken(today) → partial doesn't break it = 5.
    const r = adherenceSummary(strip("ttptt"));
    expect(r.streak).toBe(5);
  });

  it("counts a partial today toward the streak and half toward the percentage", () => {
    const r = adherenceSummary(strip("ttttp"));
    expect(r.streak).toBe(5);
    expect(r.takenDays).toBe(4);
    expect(r.partialDays).toBe(1);
    expect(r.applicableDays).toBe(5);
    // (4 + 0.5) / 5 = 90%.
    expect(r.pct).toBe(90);
  });

  it("counts partial days as half toward the percentage", () => {
    // 2 taken, 2 partial → (2 + 1) / 4 = 75%.
    const r = adherenceSummary(strip("ttpp"));
    expect(r.takenDays).toBe(2);
    expect(r.partialDays).toBe(2);
    expect(r.pct).toBe(75);
  });

  it("computes percentage over due days only, excluding na", () => {
    // 6 taken, 2 missed, 2 na → 6/8 = 75%.
    const r = adherenceSummary(strip("ttttttmmnn"));
    expect(r.applicableDays).toBe(8);
    expect(r.takenDays).toBe(6);
    expect(r.pct).toBe(75);
  });

  it("returns null percentage and zero streak when nothing was due", () => {
    const r = adherenceSummary(strip("nnnnnn"));
    expect(r.pct).toBeNull();
    expect(r.streak).toBe(0);
    expect(r.applicableDays).toBe(0);
  });

  it("handles an empty window", () => {
    const r = adherenceSummary([]);
    expect(r).toEqual({
      streak: 0,
      pct: null,
      takenDays: 0,
      partialDays: 0,
      applicableDays: 0,
    });
  });
});

describe("indexTakenByDose", () => {
  it("groups log rows into a set of dates per dose id", () => {
    const m = indexTakenByDose([
      { dose_id: 1, date: "d0" },
      { dose_id: 2, date: "d0" },
      { dose_id: 1, date: "d1" },
      { dose_id: 1, date: "d1" }, // duplicate collapses in the set
    ]);
    expect(m.get(1)).toEqual(new Set(["d0", "d1"]));
    expect(m.get(2)).toEqual(new Set(["d0"]));
    expect(m.get(3)).toBeUndefined();
  });

  it("returns an empty map for no rows", () => {
    expect(indexTakenByDose([]).size).toBe(0);
  });
});

describe("doseStrip", () => {
  const dates = ["d0", "d1", "d2", "d3"];

  it("marks days not due as na, logged days taken, and the rest missed", () => {
    const strip = doseStrip(
      dates,
      (d) => d !== "d1", // not due on d1
      new Set(["d0", "d3"])
    );
    expect(strip).toEqual([
      { date: "d0", state: "taken" },
      { date: "d1", state: "na" },
      { date: "d2", state: "missed" },
      { date: "d3", state: "taken" },
    ]);
  });

  it("feeds adherenceSummary end-to-end: a due-every-day dose taken all but today", () => {
    // d3 is today and not yet logged → pending, so 3/3 = 100% and streak 3.
    const strip = doseStrip(dates, () => true, new Set(["d0", "d1", "d2"]));
    const r = adherenceSummary(strip);
    expect(r.streak).toBe(3);
    expect(r.pct).toBe(100);
  });
});
