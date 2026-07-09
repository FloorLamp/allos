import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOW_SUPPLY_DAYS,
  daysOfSupplyLeft,
  isLowSupply,
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
