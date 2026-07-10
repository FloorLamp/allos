import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_EXTRACTION_LIMIT,
  DEFAULT_DAILY_INSIGHT_LIMIT,
  dailyLimitFor,
  decideAiRefund,
  decideAiUsage,
  extractionDailyLimit,
  insightDailyLimit,
} from "@/lib/ai-usage-limits";

// Pure logic only (no DB). The DB read-increment (checkAndIncrementAiUsage) lives
// in lib/ai-usage.ts and is exercised by the DB-tier / action tests; here we pin
// the DECISION and the env-limit parsing that gate every AI call site.

describe("decideAiUsage", () => {
  it("allows while under the limit and reports the post-call count/remaining", () => {
    expect(decideAiUsage(0, 3)).toEqual({
      allowed: true,
      nextCount: 1,
      remaining: 2,
    });
    expect(decideAiUsage(2, 3)).toEqual({
      allowed: true,
      nextCount: 3,
      remaining: 0,
    });
  });

  it("denies at the limit and leaves the count unchanged", () => {
    expect(decideAiUsage(3, 3)).toEqual({
      allowed: false,
      nextCount: 3,
      remaining: 0,
    });
    expect(decideAiUsage(10, 3)).toEqual({
      allowed: false,
      nextCount: 10,
      remaining: 0,
    });
  });

  it("a limit of 0 denies the very first call (AI operation disabled)", () => {
    expect(decideAiUsage(0, 0)).toEqual({
      allowed: false,
      nextCount: 0,
      remaining: 0,
    });
  });

  it("treats a non-finite or negative current count as 0 (defensive)", () => {
    expect(decideAiUsage(-5, 2)).toMatchObject({ allowed: true, nextCount: 1 });
    expect(decideAiUsage(NaN, 2)).toMatchObject({
      allowed: true,
      nextCount: 1,
    });
    expect(decideAiUsage(Number.POSITIVE_INFINITY, 2)).toMatchObject({
      allowed: true,
      nextCount: 1,
    });
  });

  it("floors a fractional current count before comparing", () => {
    // 2.9 → floored to 2, still under 3.
    expect(decideAiUsage(2.9, 3)).toMatchObject({
      allowed: true,
      nextCount: 3,
    });
  });

  it("is monotonic: repeatedly applying it never exceeds the limit", () => {
    const limit = 4;
    let count = 0;
    let allowedCalls = 0;
    for (let i = 0; i < 20; i++) {
      const d = decideAiUsage(count, limit);
      if (d.allowed) {
        allowedCalls++;
        count = d.nextCount;
      }
    }
    expect(allowedCalls).toBe(limit);
    expect(count).toBe(limit);
  });
});

describe("decideAiRefund (issue #135 item 3)", () => {
  it("hands one unit back", () => {
    expect(decideAiRefund(3)).toBe(2);
    expect(decideAiRefund(1)).toBe(0);
  });

  it("never goes below zero (nothing to refund)", () => {
    expect(decideAiRefund(0)).toBe(0);
    expect(decideAiRefund(-5)).toBe(0);
  });

  it("treats a non-finite current as 0 (defensive)", () => {
    expect(decideAiRefund(NaN)).toBe(0);
    expect(decideAiRefund(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("floors a fractional current before decrementing", () => {
    expect(decideAiRefund(3.9)).toBe(2); // floor(3.9)=3 → 2
  });

  it("charge-then-refund round-trips: a failed attempt restores the count", () => {
    // Consume 2, refund 1 → net 1 consumed, matching one successful + one failed.
    const afterTwoCharges = decideAiUsage(
      decideAiUsage(0, 10).nextCount,
      10
    ).nextCount;
    expect(afterTwoCharges).toBe(2);
    expect(decideAiRefund(afterTwoCharges)).toBe(1);
  });
});

describe("daily limit resolution (env override with code default)", () => {
  const KEYS = ["AI_DAILY_EXTRACTION_LIMIT", "AI_DAILY_INSIGHT_LIMIT"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("uses the code defaults when the env vars are unset", () => {
    delete process.env.AI_DAILY_EXTRACTION_LIMIT;
    delete process.env.AI_DAILY_INSIGHT_LIMIT;
    expect(extractionDailyLimit()).toBe(DEFAULT_DAILY_EXTRACTION_LIMIT);
    expect(insightDailyLimit()).toBe(DEFAULT_DAILY_INSIGHT_LIMIT);
    expect(dailyLimitFor("extraction")).toBe(DEFAULT_DAILY_EXTRACTION_LIMIT);
    expect(dailyLimitFor("insight")).toBe(DEFAULT_DAILY_INSIGHT_LIMIT);
  });

  it("honors a valid non-negative integer override", () => {
    process.env.AI_DAILY_EXTRACTION_LIMIT = "7";
    process.env.AI_DAILY_INSIGHT_LIMIT = "0";
    expect(extractionDailyLimit()).toBe(7);
    expect(insightDailyLimit()).toBe(0);
  });

  it("ignores a blank/invalid/negative override and keeps the default", () => {
    for (const bad of ["", "  ", "abc", "-1", "3.5", "twelve"]) {
      process.env.AI_DAILY_EXTRACTION_LIMIT = bad;
      expect(extractionDailyLimit()).toBe(DEFAULT_DAILY_EXTRACTION_LIMIT);
    }
  });
});
