import { describe, it, expect } from "vitest";
import {
  decideRecommendationRun,
  cadencePeriodDays,
  clampMaxRunsPerDay,
  parseCadence,
  DEFAULT_RECOMMENDATION_CADENCE,
  DEFAULT_MAX_RUNS_PER_DAY,
  MAX_RUNS_PER_DAY_CEILING,
  type RecommendationCadence,
} from "../recommendation-run";

const NOW = "2026-07-12T09:00:00.000Z";

function decide(over: Partial<Parameters<typeof decideRecommendationRun>[0]>) {
  return decideRecommendationRun({
    cadence: "daily",
    trigger: "scheduled",
    lastRunAt: null,
    now: NOW,
    inputSignature: "sig-a",
    lastSignature: null,
    ...over,
  });
}

describe("parseCadence", () => {
  it("accepts known cadences and defaults the rest", () => {
    for (const c of ["off", "on-upload-only", "daily", "weekly", "monthly"])
      expect(parseCadence(c)).toBe(c);
    expect(parseCadence("nonsense")).toBe(DEFAULT_RECOMMENDATION_CADENCE);
    expect(parseCadence(null)).toBe(DEFAULT_RECOMMENDATION_CADENCE);
    expect(parseCadence(undefined)).toBe(DEFAULT_RECOMMENDATION_CADENCE);
  });
});

describe("cadencePeriodDays", () => {
  it("maps calendar cadences to day counts, null otherwise", () => {
    expect(cadencePeriodDays("daily")).toBe(1);
    expect(cadencePeriodDays("weekly")).toBe(7);
    expect(cadencePeriodDays("monthly")).toBe(30);
    expect(cadencePeriodDays("off")).toBeNull();
    expect(cadencePeriodDays("on-upload-only")).toBeNull();
  });
});

describe("clampMaxRunsPerDay", () => {
  it("clamps to 1..ceiling and defaults non-finite", () => {
    expect(clampMaxRunsPerDay(0)).toBe(1);
    expect(clampMaxRunsPerDay(-5)).toBe(1);
    expect(clampMaxRunsPerDay(3)).toBe(3);
    expect(clampMaxRunsPerDay(3.9)).toBe(3);
    expect(clampMaxRunsPerDay(999)).toBe(MAX_RUNS_PER_DAY_CEILING);
    expect(clampMaxRunsPerDay(NaN)).toBe(DEFAULT_MAX_RUNS_PER_DAY);
  });
});

describe("decideRecommendationRun", () => {
  it("manual always runs, bypassing cadence/signature", () => {
    expect(
      decide({ trigger: "manual", cadence: "off", lastSignature: "sig-a" })
    ).toEqual({ run: true, reason: "manual" });
  });

  it("off never runs a non-manual trigger", () => {
    expect(decide({ cadence: "off", trigger: "scheduled" }).run).toBe(false);
    expect(
      decide({ cadence: "off", trigger: "document-imported" }).reason
    ).toBe("off");
  });

  it("document-imported runs on any non-off cadence with changed signature", () => {
    expect(
      decide({ cadence: "on-upload-only", trigger: "document-imported" })
    ).toEqual({ run: true, reason: "upload" });
    expect(
      decide({ cadence: "monthly", trigger: "document-imported" }).run
    ).toBe(true);
  });

  it("on-upload-only never fires a scheduled run", () => {
    expect(decide({ cadence: "on-upload-only", trigger: "scheduled" })).toEqual(
      { run: false, reason: "cadence-not-due" }
    );
  });

  it("scheduled respects the cadence period", () => {
    // daily: last run 12h ago → not due; 25h ago → due
    expect(
      decide({
        cadence: "daily",
        lastRunAt: "2026-07-11T21:00:00.000Z",
        inputSignature: "x",
      }).reason
    ).toBe("cadence-not-due");
    expect(
      decide({
        cadence: "daily",
        lastRunAt: "2026-07-11T08:00:00.000Z",
        inputSignature: "x",
      })
    ).toEqual({ run: true, reason: "due" });
  });

  it("weekly needs 7 days elapsed", () => {
    expect(
      decide({
        cadence: "weekly",
        lastRunAt: "2026-07-08T09:00:00.000Z",
        inputSignature: "x",
      }).run
    ).toBe(false);
    expect(
      decide({
        cadence: "weekly",
        lastRunAt: "2026-07-04T09:00:00.000Z",
        inputSignature: "x",
      }).run
    ).toBe(true);
  });

  it("first-ever scheduled run (no lastRunAt) is due", () => {
    expect(decide({ cadence: "daily", lastRunAt: null }).run).toBe(true);
  });

  it("skips when the input signature is unchanged", () => {
    expect(
      decide({
        cadence: "daily",
        lastRunAt: null,
        inputSignature: "same",
        lastSignature: "same",
      })
    ).toEqual({ run: false, reason: "signature-unchanged" });
  });

  it("runs when the signature changed even if a prior signature exists", () => {
    expect(
      decide({
        cadence: "daily",
        lastRunAt: null,
        inputSignature: "new",
        lastSignature: "old",
      }).run
    ).toBe(true);
  });

  it("signature gate does not block a manual run", () => {
    expect(
      decide({
        trigger: "manual",
        inputSignature: "same",
        lastSignature: "same",
      }).run
    ).toBe(true);
  });
});
