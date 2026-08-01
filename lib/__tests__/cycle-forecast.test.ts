import { describe, expect, it } from "vitest";
import {
  CYCLE_REGULARITY_VARIATION_DAYS,
  FORECAST_MAX_HALF_WIDTH_DAYS,
  FORECAST_MIN_CYCLES,
  FORECAST_MIN_HALF_WIDTH_DAYS,
  LUTEAL_PHASE_DAYS,
  forecastHalfWidthDays,
  forecastNextPeriod,
  type CyclePeriod,
} from "@/lib/cycle";
import { daysBetweenDateStr, shiftDateStr } from "@/lib/date";

// PURE TIER — the #1679 next-period forecast: the #714 non-goal reversed, with the honesty
// mechanisms that made the reversal acceptable. No DB, no clock: every case builds its own
// period history from a DEEP-PAST anchor and an explicit "today", so nothing here drifts
// with the wall clock.

// A fixed, deep-past anchor. Cycle histories are built forward from it.
const ANCHOR = "2019-03-04";

// Build a period history from consecutive cycle LENGTHS (days between starts), oldest
// first. Each period runs 5 bleeding days. Returns the rows plus the last start.
function history(lengths: number[]): { periods: CyclePeriod[]; last: string } {
  const periods: CyclePeriod[] = [];
  let start = ANCHOR;
  let id = 1;
  for (const len of [...lengths, 0]) {
    periods.push({
      id: id++,
      period_start: start,
      period_end: shiftDateStr(start, 4),
      flow: "medium",
      note: null,
    });
    start = shiftDateStr(start, len);
  }
  return { periods, last: periods[periods.length - 1].period_start };
}

// A regular history: six 28-day cycles → mean 28, spread 0.
const REGULAR = history([28, 28, 28, 28, 28, 28]);
// An irregular history: spread of 14 days.
const IRREGULAR = history([24, 38, 27, 33, 25, 31]);

describe("forecastNextPeriod — sufficiency (silence is a valid output)", () => {
  it("yields no forecast below FORECAST_MIN_CYCLES completed cycles", () => {
    // Three period rows = two completed cycles, one short of the threshold.
    const h = history([28, 28]);
    const f = forecastNextPeriod(h.periods, shiftDateStr(h.last, 10));
    expect(f.kind).toBe("insufficient");
    if (f.kind === "insufficient") expect(f.cycleCount).toBe(2);
  });

  it("yields no forecast at all from a single recorded period", () => {
    const only: CyclePeriod[] = [
      {
        id: 1,
        period_start: ANCHOR,
        period_end: shiftDateStr(ANCHOR, 4),
        flow: null,
        note: null,
      },
    ];
    const f = forecastNextPeriod(only, shiftDateStr(ANCHOR, 20));
    expect(f).toEqual({ kind: "insufficient", cycleCount: 0 });
  });

  it("starts forecasting exactly at the threshold", () => {
    const h = history([28, 28, 28]);
    const f = forecastNextPeriod(h.periods, shiftDateStr(h.last, 5));
    expect(f.kind).toBe("forecast");
    if (f.kind === "forecast")
      expect(f.evidence.cycleCount).toBe(FORECAST_MIN_CYCLES);
  });
});

describe("forecastNextPeriod — the window, and its width", () => {
  it("projects a WINDOW around last start + mean, never a bare date", () => {
    const f = forecastNextPeriod(
      REGULAR.periods,
      shiftDateStr(REGULAR.last, 5)
    );
    expect(f.kind).toBe("forecast");
    if (f.kind !== "forecast") return;
    expect(f.projectedStart).toBe(shiftDateStr(REGULAR.last, 28));
    expect(f.windowStart).toBe(
      shiftDateStr(f.projectedStart, -f.halfWidthDays)
    );
    expect(f.windowEnd).toBe(shiftDateStr(f.projectedStart, f.halfWidthDays));
    // The window is a real span, not a collapsed point.
    expect(daysBetweenDateStr(f.windowStart, f.windowEnd)).toBe(
      f.halfWidthDays * 2
    );
  });

  it("labels a regular history narrow and an irregular one wide", () => {
    const reg = forecastNextPeriod(
      REGULAR.periods,
      shiftDateStr(REGULAR.last, 5)
    );
    const irr = forecastNextPeriod(
      IRREGULAR.periods,
      shiftDateStr(IRREGULAR.last, 5)
    );
    expect(reg.kind === "forecast" && reg.confidence).toBe("narrow");
    expect(irr.kind === "forecast" && irr.confidence).toBe("wide");
    // …and the irregular window is genuinely wider, not just differently labelled.
    if (reg.kind !== "forecast" || irr.kind !== "forecast") return;
    expect(irr.halfWidthDays).toBeGreaterThan(reg.halfWidthDays);
  });

  it("width is monotonic in variation, and clamped at both ends", () => {
    let previous = 0;
    for (let variation = 0; variation <= 40; variation++) {
      const w = forecastHalfWidthDays(variation);
      expect(w).toBeGreaterThanOrEqual(previous); // never narrows as spread grows
      expect(w).toBeGreaterThanOrEqual(FORECAST_MIN_HALF_WIDTH_DAYS);
      expect(w).toBeLessThanOrEqual(FORECAST_MAX_HALF_WIDTH_DAYS);
      previous = w;
    }
    expect(forecastHalfWidthDays(0)).toBe(FORECAST_MIN_HALF_WIDTH_DAYS);
    expect(forecastHalfWidthDays(999)).toBe(FORECAST_MAX_HALF_WIDTH_DAYS);
  });

  it("crosses the regularity threshold at CYCLE_REGULARITY_VARIATION_DAYS", () => {
    // Spread exactly at the threshold is still `regular` → narrow.
    const at = history([28, 28 + CYCLE_REGULARITY_VARIATION_DAYS, 28, 28]);
    const atF = forecastNextPeriod(at.periods, shiftDateStr(at.last, 3));
    expect(atF.kind === "forecast" && atF.confidence).toBe("narrow");

    // One day more spread flips it to irregular → wide.
    const over = history([
      28,
      28 + CYCLE_REGULARITY_VARIATION_DAYS + 1,
      28,
      28,
    ]);
    const overF = forecastNextPeriod(over.periods, shiftDateStr(over.last, 3));
    expect(overF.kind === "forecast" && overF.confidence).toBe("wide");
  });
});

describe("forecastNextPeriod — an outlier current cycle widens, never shifts", () => {
  it("degrades confidence and stretches the END once the window has passed", () => {
    const onTime = forecastNextPeriod(
      REGULAR.periods,
      shiftDateStr(REGULAR.last, 28)
    );
    // 20 days past the projected start: well beyond a ±2 window.
    const late = forecastNextPeriod(
      REGULAR.periods,
      shiftDateStr(REGULAR.last, 48)
    );
    expect(onTime.kind).toBe("forecast");
    expect(late.kind).toBe("forecast");
    if (onTime.kind !== "forecast" || late.kind !== "forecast") return;

    // The projection did NOT move onto a new date.
    expect(late.projectedStart).toBe(onTime.projectedStart);
    expect(late.windowStart).toBe(onTime.windowStart);
    // It widened to cover the overrun, and said it was less certain.
    expect(late.windowEnd).toBe(shiftDateStr(REGULAR.last, 48));
    expect(late.windowEnd > onTime.windowEnd).toBe(true);
    expect(late.confidence).toBe("uncertain");
    expect(late.overdue).toBe(true);
    expect(onTime.overdue).toBe(false);
  });
});

describe("forecastNextPeriod — the ovulation estimate is the weaker claim", () => {
  it("is projected start − LUTEAL_PHASE_DAYS, with the same window width", () => {
    const f = forecastNextPeriod(
      REGULAR.periods,
      shiftDateStr(REGULAR.last, 5)
    );
    expect(f.kind).toBe("forecast");
    if (f.kind !== "forecast" || !f.ovulationEstimate) return;
    expect(f.ovulationEstimate.estimatedDate).toBe(
      shiftDateStr(f.projectedStart, -LUTEAL_PHASE_DAYS)
    );
    expect(
      daysBetweenDateStr(
        f.ovulationEstimate.windowStart,
        f.ovulationEstimate.windowEnd
      )
    ).toBe(f.halfWidthDays * 2);
  });

  it("is dropped when the subtraction would land in the previous cycle", () => {
    // Very short cycles: 28 − 14 = 14, but a 12-day cycle puts the estimate before the
    // anchoring period start, where it would describe the wrong cycle.
    const short = history([12, 12, 12, 12]);
    const f = forecastNextPeriod(short.periods, shiftDateStr(short.last, 2));
    expect(f.kind).toBe("forecast");
    if (f.kind !== "forecast") return;
    expect(f.ovulationEstimate).toBeNull();
  });
});

describe("forecastNextPeriod — suspension beats everything", () => {
  it("says nothing during a pregnancy, however good the history", () => {
    const f = forecastNextPeriod(
      REGULAR.periods,
      shiftDateStr(REGULAR.last, 5),
      "pregnancy"
    );
    expect(f).toEqual({ kind: "suspended", reason: "pregnancy" });
  });

  it("says nothing for a postmenopausal profile", () => {
    const f = forecastNextPeriod(
      REGULAR.periods,
      shiftDateStr(REGULAR.last, 5),
      "postmenopausal"
    );
    expect(f).toEqual({ kind: "suspended", reason: "postmenopausal" });
  });

  it("suspends even when the history is insufficient (no mixed message)", () => {
    const h = history([28]);
    const f = forecastNextPeriod(
      h.periods,
      shiftDateStr(h.last, 5),
      "pregnancy"
    );
    expect(f.kind).toBe("suspended");
  });
});
