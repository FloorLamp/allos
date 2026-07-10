import { describe, it, expect } from "vitest";
import {
  adherenceSummary,
  aggregateDoseDay,
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
  s: "skipped",
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

  // Three-way adherence (#232): a deliberate skip is excluded from the
  // denominator (it wasn't an intended dose) and is transparent to the streak,
  // yet counted on its own — distinct from a "missed" lapse.
  describe("skipped days (#232)", () => {
    it("excludes skips from the denominator but counts them separately", () => {
      // 3 taken, 1 skipped, 1 missed over the settled window (today = taken).
      const r = adherenceSummary(strip("tsmtt"));
      expect(r.skippedDays).toBe(1);
      // Denominator is 4 (3 taken + 1 missed), not 5 — 75%, not 60%.
      expect(r.applicableDays).toBe(4);
      expect(r.takenDays).toBe(3);
      expect(r.pct).toBe(75);
    });

    it("keeps a skip transparent to the streak (neither counts nor breaks it)", () => {
      // …taken, skipped, taken → the skip doesn't end the run.
      const r = adherenceSummary(strip("ttstt"));
      expect(r.streak).toBe(5 - 1); // 4 taken days, skip is invisible
      expect(r.skippedDays).toBe(1);
    });

    it("a missed day still breaks the streak even with skips present", () => {
      const r = adherenceSummary(strip("tsmtt"));
      expect(r.streak).toBe(2); // the two trailing taken days
    });

    it("reports null percentage when every settled day was skipped or na", () => {
      const r = adherenceSummary(strip("nssn"));
      expect(r.pct).toBeNull();
      expect(r.applicableDays).toBe(0);
      expect(r.skippedDays).toBe(2);
    });
  });

  it("handles an empty window", () => {
    const r = adherenceSummary([]);
    expect(r).toEqual({
      streak: 0,
      pct: null,
      takenDays: 0,
      partialDays: 0,
      skippedDays: 0,
      applicableDays: 0,
    });
  });
});

describe("indexTakenByDose", () => {
  it("groups log rows into taken/skipped date sets per dose id", () => {
    const m = indexTakenByDose([
      { dose_id: 1, date: "d0" }, // status omitted → taken (pre-#232 default)
      { dose_id: 2, date: "d0", status: "taken" },
      { dose_id: 1, date: "d1" },
      { dose_id: 1, date: "d1" }, // duplicate collapses in the set
      { dose_id: 1, date: "d2", status: "skipped" }, // #232
    ]);
    expect(m.get(1)?.taken).toEqual(new Set(["d0", "d1"]));
    expect(m.get(1)?.skipped).toEqual(new Set(["d2"]));
    expect(m.get(2)?.taken).toEqual(new Set(["d0"]));
    expect(m.get(2)?.skipped).toEqual(new Set());
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

  it("marks a deliberately skipped day as skipped, not missed (#232)", () => {
    const strip = doseStrip(
      dates,
      () => true,
      new Set(["d0"]), // taken
      new Set(["d2"]) // skipped
    );
    expect(strip).toEqual([
      { date: "d0", state: "taken" },
      { date: "d1", state: "missed" },
      { date: "d2", state: "skipped" },
      { date: "d3", state: "missed" },
    ]);
  });
});

// Roll per-dose outcomes into one supplement-day state (#232).
describe("aggregateDoseDay", () => {
  it("is taken only when every due dose was taken", () => {
    expect(aggregateDoseDay(2, 2, 0)).toBe("taken");
    expect(aggregateDoseDay(1, 1, 0)).toBe("taken");
  });

  it("is partial when some (but not all) doses were taken", () => {
    expect(aggregateDoseDay(2, 1, 0)).toBe("partial");
    expect(aggregateDoseDay(3, 1, 1)).toBe("partial"); // any take wins
  });

  it("is skipped when every due dose was deliberately skipped", () => {
    expect(aggregateDoseDay(2, 0, 2)).toBe("skipped");
    expect(aggregateDoseDay(1, 0, 1)).toBe("skipped");
  });

  it("is missed when nothing was resolved, or a skip left a real miss", () => {
    expect(aggregateDoseDay(2, 0, 0)).toBe("missed");
    // one skipped, one neither taken nor skipped → an unhandled miss remains
    expect(aggregateDoseDay(2, 0, 1)).toBe("missed");
  });
});
