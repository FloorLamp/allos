import { describe, it, expect } from "vitest";
import { shiftDateStr } from "@/lib/date";
import { lastNightSummary } from "@/lib/sleep-summary";
import type { SleepSession } from "@/lib/sleep-regularity";
import {
  movementDirection,
  pointToPointMovement,
  versusBaselineMovement,
  windowMovement,
  USUAL_BASELINE_SPEC,
  WEIGHT_TOLERANCE_KG,
} from "@/lib/movement";

// Pure-tier: THE metric-movement verdicts (#3394). Three named questions over one
// dated series — point-to-point, window, versus baseline — and the contract that they
// agree WITHIN a question and are free to disagree ACROSS questions.

describe("pointToPointMovement — the latest reading versus the one before it", () => {
  it("returns null for an empty series", () => {
    expect(pointToPointMovement([])).toBeNull();
  });

  it("a single reading has no direction (no prior to compare)", () => {
    const t = pointToPointMovement([{ date: "2026-07-20", value: 118 }])!;
    expect(t.value).toBe(118);
    expect(t.date).toBe("2026-07-20");
    expect(t.previousValue).toBeNull();
    expect(t.direction).toBeNull();
  });

  it("reports up/down/flat versus the immediately prior reading", () => {
    const asc = [
      { date: "2026-07-01", value: 120 },
      { date: "2026-07-10", value: 116 },
      { date: "2026-07-20", value: 118 },
    ];
    const t = pointToPointMovement(asc)!;
    expect(t.value).toBe(118);
    expect(t.previousValue).toBe(116);
    expect(t.direction).toBe("up");

    expect(
      pointToPointMovement([
        { date: "a", value: 60 },
        { date: "b", value: 55 },
      ])!.direction
    ).toBe("down");
    expect(
      pointToPointMovement([
        { date: "a", value: 55 },
        { date: "b", value: 55 },
      ])!.direction
    ).toBe("flat");
  });

  // #2303: two readings from ONE sitting are not a direction. Three sequential cuff
  // readings share a date, and the two-point tail then compared reading #3 to reading
  // #2 of a single measurement — "up versus previous blood pressure" for a number that
  // never moved between two days. The DATA survives (previousValue still reports the
  // other reading); only the claim is withdrawn.
  it("withholds the direction when the last two readings share a date", () => {
    const sameVisit = pointToPointMovement([
      { date: "2026-03-08", value: 120 },
      { date: "2026-03-08", value: 118 },
      { date: "2026-03-08", value: 122 },
    ])!;
    expect(sameVisit.value).toBe(122);
    expect(sameVisit.previousValue).toBe(118);
    expect(sameVisit.direction).toBeNull();
  });

  it("still reports a direction when only EARLIER readings share a date", () => {
    const t = pointToPointMovement([
      { date: "2026-03-08", value: 120 },
      { date: "2026-03-08", value: 118 },
      { date: "2026-05-02", value: 126 },
    ])!;
    expect(t.previousValue).toBe(118);
    expect(t.direction).toBe("up");
  });

  it("withholds the direction for an equal same-day pair too (not 'flat')", () => {
    // "flat" is a claim as well — that the reading held steady between two moments the
    // data never separated.
    expect(
      pointToPointMovement([
        { date: "2026-03-08", value: 118 },
        { date: "2026-03-08", value: 118 },
      ])!.direction
    ).toBeNull();
  });
});

// ── The agreement contract (#3394) ────────────────────────────────────────────
//
// The invariant is NOT "the verdicts never disagree". Across DIFFERENT questions that
// is mathematically false, and requiring it would force one of two true answers to
// lie. The invariant is that the SAME named question, over the same normalized series,
// period/basis and materiality policy, gives the same answer at every consumer.
describe("point-to-point and window are different questions and may disagree", () => {
  // The counterexample the issue pins: a step up, then a small step back down.
  const SERIES = [100, 100, 100, 110, 110, 110, 105].map((value, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, "0")}`,
    value,
  }));

  it("keeps the latest move DOWN while the window move is UP — both true", () => {
    expect(pointToPointMovement(SERIES)!.direction).toBe("down"); // 110 → 105
    const window = windowMovement(SERIES)!;
    expect(window.direction).toBe("up"); // median endpoints 100 → 110
    expect(window.first).toBe(100);
    expect(window.last).toBe(110);
    // Opposite, on purpose. Anything that makes these agree has broken one of them.
    expect(pointToPointMovement(SERIES)!.direction).not.toBe(window.direction);
  });

  it("the window verdict is the same one the digest and the recap read", () => {
    // The recap's weight trend is `absChange`; the digest tile's badge is the same
    // summary. One computation, so the two surfaces cannot print opposite arrows
    // about one window (#398, generalized).
    const w = windowMovement(SERIES.map((p) => ({ value: p.value })))!;
    expect(w.absChange).toBe(10);
    expect(w.pctChange).toBeCloseTo(0.1, 12);
    expect(w.clearsMinPct).toBe(true); // 10% clears the 5% default floor
    expect(windowMovement(SERIES, { minPctChange: 0.2 })!.clearsMinPct).toBe(
      false
    );
  });
});

describe("movementDirection — one flat rule, a per-question band", () => {
  it("calls any nonzero move a direction at the default zero band", () => {
    expect(movementDirection(0.0001)).toBe("up");
    expect(movementDirection(-0.0001)).toBe("down");
    expect(movementDirection(0)).toBe("flat");
  });

  it("spends weight's declared 0.1 kg band, half-open at the band itself", () => {
    expect(WEIGHT_TOLERANCE_KG).toBe(0.1);
    expect(movementDirection(0.09, WEIGHT_TOLERANCE_KG)).toBe("flat");
    expect(movementDirection(0.1, WEIGHT_TOLERANCE_KG)).toBe("up");
    expect(movementDirection(-0.1, WEIGHT_TOLERANCE_KG)).toBe("down");
  });

  it("refuses to call a non-numeric delta a direction", () => {
    expect(movementDirection(NaN)).toBe("flat");
    expect(movementDirection(NaN, WEIGHT_TOLERANCE_KG)).toBe("flat");
  });

  it("does NOT force one band on every question", () => {
    // A 0.09 bpm resting-HR move is a direction; the same number of kg is not. The
    // tolerance belongs to the named policy, not to the module.
    expect(movementDirection(0.09)).toBe("up");
    expect(movementDirection(0.09, WEIGHT_TOLERANCE_KG)).toBe("flat");
  });
});

describe("windowMovement — robust endpoints (#37)", () => {
  it("ignores a single spurious endpoint", () => {
    const noisy = [99, 74, 73.8, 73.4, 73.2, 73].map((value) => ({ value }));
    const m = windowMovement(noisy)!;
    expect(m.first).toBe(74); // median of 99, 74, 73.8 — the 99 spike is outvoted
    expect(m.direction).toBe("down");
    expect(m.absChange).toBeGreaterThan(-2);
  });

  it("needs two finite points and filters the rest", () => {
    expect(windowMovement([])).toBeNull();
    expect(windowMovement([{ value: 1 }])).toBeNull();
    expect(windowMovement([{ value: 1 }, { value: null }])).toBeNull();
    expect(windowMovement([{ value: NaN }, { value: 2 }])).toBeNull();
    expect(
      windowMovement([{ value: 1 }, { value: null }, { value: 3 }])!.count
    ).toBe(2);
  });

  it("admits a move off a zero start, which has no relative scale", () => {
    const m = windowMovement([{ value: 0 }, { value: 3 }], {
      minPctChange: 1,
    })!;
    expect(m.pctChange).toBeNull();
    expect(m.clearsMinPct).toBe(true);
    expect(windowMovement([{ value: 0 }, { value: 0 }])!.clearsMinPct).toBe(
      false
    );
  });
});

describe("versusBaselineMovement — one declared basis (#3394 / #5164)", () => {
  const nights = (spec: [string, number][]) =>
    spec.map(([date, value]) => ({ date, value }));

  it("answers only for a day the series actually carries", () => {
    const series = nights([
      ["2026-05-01", 400],
      ["2026-05-02", 440],
    ]);
    expect(versusBaselineMovement(series, "2026-05-03")).toBeNull();
    expect(versusBaselineMovement(series, "2026-05-02")!.value).toBe(440);
  });

  it("marks the first-ever reading as the day-one fallback, not a norm", () => {
    const only = versusBaselineMovement(
      nights([["2026-05-01", 400]]),
      "2026-05-01"
    )!;
    expect(only.dayOneFallback).toBe(true);
    expect(only.baseline).toBe(400);
    expect(only.delta).toBe(0);
    expect(only.baselineSpread).toBeUndefined();
  });

  // THE SEVEN-NIGHT GAP (#5164, folded into this issue's versus-baseline leg).
  //
  // Two baselines used to be computed for one night: the Sleep hero averaged the prior
  // 30 CALENDAR days, the coaching sleep signal the last 30 nights WITH DATA. A
  // week-long gap makes those different norms, so the hero's delta for a night and the
  // digest's verdict about the same night were measured against different things.
  it("a seven-night gap inside 30 days yields ONE baseline for one night", () => {
    // 40 consecutive wake-days of 400..439 minutes, with seven consecutive nights
    // (indices 21..27) missing entirely.
    const series: { date: string; value: number }[] = [];
    for (let i = 0; i < 40; i++) {
      if (i >= 21 && i <= 27) continue;
      series.push({ date: shiftDateStr("2026-05-01", i), value: 400 + i });
    }
    const anchor = series[series.length - 1].date;
    expect(anchor).toBe("2026-06-09");

    const movement = versusBaselineMovement(
      series,
      anchor,
      USUAL_BASELINE_SPEC
    )!;
    // The DATA-BEARING window reaches back THROUGH the gap for a full 30-night sample.
    expect(movement.baselineCount).toBe(30);
    expect(movement.dayOneFallback).toBe(false);
    expect(movement.baselineFrom).toBe("2026-05-03");
    expect(movement.baselineTo).toBe("2026-06-08");
    expect(movement.baseline).toBeCloseTo(12572 / 30, 12);
    expect(movement.direction).toBe("up"); // 439 against a ~419 norm

    // The CALENDAR window over the same series is a different norm — 23 nights, a
    // higher mean, a smaller delta. Both are defensible; holding both at once for one
    // night was the defect.
    const calendar = versusBaselineMovement(series, anchor, {
      days: 30,
      basis: "calendar",
      includeToday: false,
    })!;
    expect(calendar.baselineCount).toBe(23);
    expect(Math.round(calendar.baseline!)).toBe(423);
    expect(Math.round(movement.baseline!)).toBe(419);

    // Same question, same basis, same answer at both consumers: the Sleep hero reads
    // `lastNightSummary`, the coaching signal reads this verdict over the SAME nightly
    // series, and they now agree on the night AND on the norm.
    const sessions: SleepSession[] = series.map((n) => ({
      // value minutes of sleep ending at 07:00 on the wake day
      start: new Date(
        Date.parse(`${n.date}T07:00:00Z`) - n.value * 60_000
      ).toISOString(),
      end: `${n.date}T07:00:00Z`,
      source: "manual",
    }));
    const hero = lastNightSummary(sessions, "UTC")!;
    expect(hero.wakeDay).toBe(anchor);
    expect(hero.baselineNights).toBe(movement.baselineCount);
    expect(hero.baselineAvgMin).toBe(Math.round(movement.baseline!));
    expect(hero.deltaMin).toBe(hero.durationMin - hero.baselineAvgMin!);
  });
});
