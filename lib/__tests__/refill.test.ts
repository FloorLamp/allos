import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOW_SUPPLY_DAYS,
  MIN_HISTORY_DAYS,
  RATE_WINDOW_DAYS,
  consumptionRate,
  daysOfSupplyLeft,
  isLowSupply,
  refillBasisLabel,
  unitsPerDay,
} from "@/lib/refill";

describe("unitsPerDay", () => {
  it("multiplies doses/day by units/dose", () => {
    expect(unitsPerDay(2, 1)).toBe(2);
    expect(unitsPerDay(1, 0.5)).toBe(0.5);
    expect(unitsPerDay(3, 2)).toBe(6);
  });
});

describe("daysOfSupplyLeft", () => {
  it("returns null when quantity is not tracked", () => {
    expect(daysOfSupplyLeft(null, 1, 1)).toBeNull();
  });

  it("returns null when nothing is consumed (no dose/day or zero per-dose)", () => {
    expect(daysOfSupplyLeft(90, 1, 0)).toBeNull();
    expect(daysOfSupplyLeft(90, 0, 1)).toBeNull();
  });

  it("floors to whole days of supply", () => {
    // 90 pills, 1 per dose, once a day → 90 days.
    expect(daysOfSupplyLeft(90, 1, 1)).toBe(90);
    // 90 pills, twice a day → 45 days.
    expect(daysOfSupplyLeft(90, 1, 2)).toBe(45);
    // 10 units, 2 per dose, once a day → 5 days.
    expect(daysOfSupplyLeft(10, 2, 1)).toBe(5);
    // 7 units, once a day → 7; 7 units twice a day → floor(3.5) = 3.
    expect(daysOfSupplyLeft(7, 1, 1)).toBe(7);
    expect(daysOfSupplyLeft(7, 1, 2)).toBe(3);
  });

  it("handles fractional per-dose amounts", () => {
    // 30 mL, half a mL per dose, once daily → 60 days.
    expect(daysOfSupplyLeft(30, 0.5, 1)).toBe(60);
  });

  it("returns 0 when out of stock", () => {
    expect(daysOfSupplyLeft(0, 1, 1)).toBe(0);
  });
});

describe("isLowSupply", () => {
  it("is never low when days-left is null (untracked/unestimable)", () => {
    expect(isLowSupply(null)).toBe(false);
  });

  it("is low at or below the threshold, not above", () => {
    expect(isLowSupply(DEFAULT_LOW_SUPPLY_DAYS)).toBe(true);
    expect(isLowSupply(DEFAULT_LOW_SUPPLY_DAYS - 1)).toBe(true);
    expect(isLowSupply(DEFAULT_LOW_SUPPLY_DAYS + 1)).toBe(false);
    expect(isLowSupply(0)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(isLowSupply(5, 3)).toBe(false);
    expect(isLowSupply(3, 3)).toBe(true);
  });
});

describe("consumptionRate", () => {
  it("uses the actual taken-log rate for a daily item with full history", () => {
    // 30 confirmations across a 30-day window, 60 days of history → 1.0/day,
    // basis history. Matches the schedule count of 1 here (a truly daily item).
    const r = consumptionRate(30, 60, 1);
    expect(r.basis).toBe("history");
    expect(r.dosesPerDay).toBeCloseTo(1, 10);
  });

  it("reflects real (low) consumption for a workout-only item, not the schedule", () => {
    // Scheduled as if daily (count 1), but actually taken ~2×/week: 8 logs in the
    // 30-day window over 60 days of history → ~0.27/day, far below the schedule's
    // 1/day. This is the #38 fix: no longer over-estimated as daily.
    const r = consumptionRate(8, 60, 1);
    expect(r.basis).toBe("history");
    expect(r.dosesPerDay).toBeCloseTo(8 / 30, 10);
    expect(r.dosesPerDay).toBeLessThan(1);
    // A workout-only supplement therefore lasts far longer than the schedule math.
    expect(daysOfSupplyLeft(60, 1, r.dosesPerDay)).toBe(225); // vs 60 by schedule
    expect(daysOfSupplyLeft(60, 1, 1)).toBe(60);
  });

  it("estimates a PRN med from occasional logs even with no scheduled doses", () => {
    // A PRN med has zero scheduled dose rows (schedule count 0), so the old
    // approach could never estimate it. With 3 logs over 90 days of history the
    // history rate still yields a finite runway.
    const r = consumptionRate(3, 90, 0);
    expect(r.basis).toBe("history");
    expect(r.dosesPerDay).toBeCloseTo(3 / 30, 10);
    expect(daysOfSupplyLeft(30, 1, r.dosesPerDay)).toBe(300);
  });

  it("falls back to the schedule count when history is too thin (young item)", () => {
    // Only 5 days since the first log (< MIN_HISTORY_DAYS) — not enough to trust
    // an average — so use the schedule estimate regardless of the window count.
    expect(5).toBeLessThan(MIN_HISTORY_DAYS);
    const r = consumptionRate(10, 5, 2);
    expect(r.basis).toBe("schedule");
    expect(r.dosesPerDay).toBe(2);
  });

  it("falls back to the schedule count with no history at all", () => {
    // Never logged (daysSinceFirstLog null) → schedule estimate.
    expect(consumptionRate(0, null, 3)).toEqual({
      dosesPerDay: 3,
      basis: "schedule",
    });
    // Has old history but zero confirmations inside the window (e.g. paused) →
    // schedule estimate, since a 0/window rate would invent an infinite runway.
    expect(consumptionRate(0, 90, 1)).toEqual({
      dosesPerDay: 1,
      basis: "schedule",
    });
  });

  it("boundary: exactly MIN_HISTORY_DAYS of history counts as history", () => {
    // 15 daily confirmations since the first log 14 days ago (15 tracked days):
    // the divisor is the EFFECTIVE window (15 days), not the full 30 — a young
    // daily item reads ~1/day, not half that.
    const r = consumptionRate(15, MIN_HISTORY_DAYS, 1);
    expect(r.basis).toBe("history");
    expect(r.dosesPerDay).toBeCloseTo(1, 10);
  });

  it("caps the divisor at the days actually tracked (young item)", () => {
    // Started 19 days ago, taken daily (20 confirmations over 20 tracked days).
    // Dividing by the full 30-day window would report 0.67/day and overstate
    // days-left by 50%, making the low-supply nudge fire late.
    const r = consumptionRate(20, 19, 1);
    expect(r.basis).toBe("history");
    expect(r.dosesPerDay).toBeCloseTo(1, 10);
    // Long-tracked items still divide by the full window.
    const mature = consumptionRate(30, 200, 1);
    expect(mature.dosesPerDay).toBeCloseTo(1, 10);
  });

  it("honors a custom window length", () => {
    const r = consumptionRate(7, 30, 1, 7);
    expect(r.basis).toBe("history");
    expect(r.dosesPerDay).toBeCloseTo(1, 10);
  });

  it("exposes sane window/history defaults", () => {
    expect(RATE_WINDOW_DAYS).toBe(30);
    expect(MIN_HISTORY_DAYS).toBe(14);
  });
});

describe("refillBasisLabel", () => {
  it("names the basis for the days-left tooltip", () => {
    expect(refillBasisLabel("history")).toBe("based on your last 30 days");
    expect(refillBasisLabel("schedule")).toBe("based on schedule");
  });
});
