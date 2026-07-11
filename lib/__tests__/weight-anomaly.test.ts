import { describe, it, expect } from "vitest";
import {
  detectWeightAnomalies,
  weightAnomalySignalKey,
  BODY_HYGIENE_PREFIX,
  KG_PER_LB,
  type DatedWeight,
} from "@/lib/weight-anomaly";

const today = "2026-03-01";
const daysAgo = (n: number) => {
  const d = new Date(Date.UTC(2026, 2, 1) - n * 86_400_000);
  return d.toISOString().slice(0, 10);
};

describe("detectWeightAnomalies", () => {
  it("flags a >3% day-over-day jump", () => {
    const weights: DatedWeight[] = [
      { id: 1, date: daysAgo(2), weightKg: 80 },
      { id: 2, date: daysAgo(1), weightKg: 82.5 }, // +3.125%
    ];
    const out = detectWeightAnomalies(weights, today);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
    expect(out[0].suspectedUnitError).toBe(false);
    expect(out[0].changeFraction).toBeCloseTo(0.03125, 5);
  });

  it("does NOT flag a change just under the 3% threshold", () => {
    const weights: DatedWeight[] = [
      { id: 1, date: daysAgo(2), weightKg: 80 },
      { id: 2, date: daysAgo(1), weightKg: 82 }, // +2.5%
    ];
    expect(detectWeightAnomalies(weights, today)).toEqual([]);
  });

  it("ignores a large change spread across more than the max gap", () => {
    // 10% apart but a week between readings → real trend, not a glitch.
    const weights: DatedWeight[] = [
      { id: 1, date: daysAgo(9), weightKg: 80 },
      { id: 2, date: daysAgo(2), weightKg: 88 },
    ];
    expect(detectWeightAnomalies(weights, today)).toEqual([]);
  });

  it("marks a kg/lb-factor jump as a suspected unit error", () => {
    const weights: DatedWeight[] = [
      { id: 1, date: daysAgo(2), weightKg: 80 },
      { id: 2, date: daysAgo(1), weightKg: 80 * KG_PER_LB },
    ];
    const out = detectWeightAnomalies(weights, today);
    expect(out).toHaveLength(1);
    expect(out[0].suspectedUnitError).toBe(true);
  });

  it("drops anomalies older than the recent lookback window", () => {
    const weights: DatedWeight[] = [
      { id: 1, date: daysAgo(91), weightKg: 80 },
      { id: 2, date: daysAgo(90), weightKg: 90 },
    ];
    expect(detectWeightAnomalies(weights, today)).toEqual([]);
  });

  it("keys each finding by the suspect row id under the body-hygiene namespace", () => {
    const key = weightAnomalySignalKey(42);
    expect(key).toBe(`${BODY_HYGIENE_PREFIX}weight-jump:42`);
  });
});
