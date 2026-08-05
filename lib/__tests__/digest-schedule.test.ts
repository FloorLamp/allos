// PURE TIER — the morning digest's own scheduling decisions (#2102).
//
// The numbers below are the issue's MEASURED ones, not invented: a real Health
// Connect profile, 11 nights, typical wake 05:40 (340 minutes), sleep rows arriving
// 22–129 minutes after the wake instant. They are what makes "the digest fired
// before the data arrived" a fact rather than a theory, so they are the fixture.

import { describe, it, expect, vi } from "vitest";
import {
  ARRIVAL_LAG_PERCENTILE,
  LAST_DEFERRABLE_HOUR,
  MAX_ARRIVAL_LAG_MIN,
  MIN_ARRIVAL_SAMPLE,
  arrivalLagAllowance,
  digestAutoHour,
  shouldDeferDigest,
} from "@/lib/notifications/digest-schedule";

// The measured arrival lags behind 05:40 (340 min): 06:02, 06:06, 06:15, 06:27,
// 06:50, 07:05, 07:11, 07:26, 07:26, 07:42, 07:49.
const MEASURED_LAGS = [22, 26, 35, 47, 70, 85, 91, 106, 106, 122, 129];
const MEASURED_WAKE_MIN = 5 * 60 + 40;

describe("arrivalLagAllowance — a high percentile, never the median", () => {
  it("clears the 90th percentile of the measured sample", () => {
    // The p90 of 11 sorted samples is the 10th (index 9) — 122 minutes. The median
    // (70) would be the value that guarantees ~50% failure by definition.
    expect(arrivalLagAllowance(MEASURED_LAGS)).toBe(122);
    expect(ARRIVAL_LAG_PERCENTILE).toBeGreaterThan(0.5);
  });

  it("refuses a sample thinner than the gate", () => {
    const thin = MEASURED_LAGS.slice(0, MIN_ARRIVAL_SAMPLE - 1);
    expect(arrivalLagAllowance(thin)).toBeNull();
    expect(arrivalLagAllowance([])).toBeNull();
    // Exactly at the gate it answers.
    expect(
      arrivalLagAllowance(MEASURED_LAGS.slice(0, MIN_ARRIVAL_SAMPLE))
    ).not.toBeNull();
  });

  it("drops lags that are not morning arrivals at all", () => {
    // A negative lag is a row stamped before the session it describes ended; a
    // multi-day one is a bulk import. Neither describes "how long after waking does
    // last night normally land", and either would drag the percentile with it.
    const polluted = [...MEASURED_LAGS, -30, MAX_ARRIVAL_LAG_MIN + 1, 4000];
    expect(arrivalLagAllowance(polluted)).toBe(122);
  });

  it("falls back rather than guessing when the pollution empties the sample", () => {
    expect(arrivalLagAllowance([-5, -10, 5000, 6000, 7000, 8000])).toBeNull();
  });

  it("never exceeds the morning band it filters on", () => {
    const allSlow = Array.from({ length: 10 }, () => MAX_ARRIVAL_LAG_MIN);
    expect(arrivalLagAllowance(allSlow)).toBe(MAX_ARRIVAL_LAG_MIN);
  });
});

describe("digestAutoHour — past the arrivals, rounded UP", () => {
  it("the measured profile resolves to 8, not to the wake hour 6", () => {
    // THE DEFECT: round(340/60) = 6, which is before ALL eleven measured arrivals
    // and an hour worse than the manual 07:00 it was meant to improve on.
    expect(Math.round(MEASURED_WAKE_MIN / 60)).toBe(6); // the old answer
    const hour = digestAutoHour(
      MEASURED_WAKE_MIN,
      arrivalLagAllowance(MEASURED_LAGS)
    );
    expect(hour).toBe(8);
    // Every measured arrival is in hand by then — the whole point.
    for (const lag of MEASURED_LAGS) {
      expect(MEASURED_WAKE_MIN + lag).toBeLessThan(hour! * 60);
    }
  });

  it("a 05:40 wake never resolves to 6 once a lag is known", () => {
    for (const lag of MEASURED_LAGS) {
      expect(digestAutoHour(MEASURED_WAKE_MIN, lag)).toBeGreaterThan(6);
    }
  });

  it("lands strictly after the allowance, never on the same minute", () => {
    // 06:00 exactly: scheduling the digest for the minute the data typically lands
    // is a race it loses half the time.
    expect(digestAutoHour(300, 60)).toBe(7);
    expect(digestAutoHour(301, 60)).toBe(7);
    expect(digestAutoHour(359, 0)).toBe(6);
  });

  it("returns null — the caller's fallback signal — without both inputs", () => {
    expect(digestAutoHour(null, 122)).toBeNull();
    expect(digestAutoHour(MEASURED_WAKE_MIN, null)).toBeNull();
    expect(digestAutoHour(null, null)).toBeNull();
  });

  it("clamps to 23 rather than wrapping into the next day", () => {
    expect(digestAutoHour(23 * 60 + 30, 120)).toBe(23);
  });
});

describe("shouldDeferDigest — once, and only into an hour that exists", () => {
  const pending = () => true;
  const arrived = () => false;

  it("defers at the first eligible hour when sleep is pending", () => {
    expect(
      shouldDeferDigest({ slotHour: 7, currentHour: 7, auto: true }, pending)
    ).toBe(true);
  });

  it("never defers at the retry hour — that hour is the bound", () => {
    expect(
      shouldDeferDigest({ slotHour: 7, currentHour: 8, auto: true }, pending)
    ).toBe(false);
  });

  it("does not defer when last night is already in hand", () => {
    expect(
      shouldDeferDigest({ slotHour: 7, currentHour: 7, auto: true }, arrived)
    ).toBe(false);
  });

  it("leaves a manually set hour alone, and does not even ask", () => {
    // A manual hour is user-owned timing: silently sliding someone's 07:00 to 08:00
    // makes their own setting untrue. The thunk going uncalled also proves the
    // sleep read is not paid for on a profile that can never defer.
    const ask = vi.fn(() => true);
    expect(
      shouldDeferDigest({ slotHour: 7, currentHour: 7, auto: false }, ask)
    ).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask at the retry hour either", () => {
    const ask = vi.fn(() => true);
    shouldDeferDigest({ slotHour: 7, currentHour: 8, auto: true }, ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses to defer out of the last hour that has a retry hour", () => {
    // slotDue does not wrap past midnight, so hour 23's window is one hour wide:
    // declining there would DROP the digest for the day rather than delay it.
    expect(
      shouldDeferDigest(
        {
          slotHour: LAST_DEFERRABLE_HOUR,
          currentHour: LAST_DEFERRABLE_HOUR,
          auto: true,
        },
        pending
      )
    ).toBe(true);
    expect(
      shouldDeferDigest({ slotHour: 23, currentHour: 23, auto: true }, pending)
    ).toBe(false);
  });

  it("is bounded across a whole day of ticks: at most one hour is ever declined", () => {
    // Sleep never arrives; the digest still has exactly one hour in which the gate
    // is open and nothing is declining it.
    const slotHour = 7;
    const declined: number[] = [];
    const eligible: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const due = hour === slotHour || hour === slotHour + 1; // slotDue
      if (!due) continue;
      if (
        shouldDeferDigest({ slotHour, currentHour: hour, auto: true }, pending)
      )
        declined.push(hour);
      else eligible.push(hour);
    }
    expect(declined).toEqual([7]);
    expect(eligible).toEqual([8]);
  });
});
