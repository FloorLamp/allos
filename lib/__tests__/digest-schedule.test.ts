// PURE TIER — the morning digest's own scheduling decisions (#2102).
//
// The numbers below are the issue's MEASURED ones, not invented: a real Health
// Connect profile, 11 nights, typical wake 05:40 (340 minutes), sleep rows arriving
// 22–129 minutes after the wake instant. They are what makes "the digest fired
// before the data arrived" a fact rather than a theory, so they are the fixture.

import { describe, it, expect, vi } from "vitest";
import {
  ARRIVAL_LAG_PERCENTILE,
  LAST_DEFERRABLE_MINUTE,
  MAX_ARRIVAL_LAG_MIN,
  MIN_ARRIVAL_SAMPLE,
  arrivalLagAllowance,
  digestAutoMinute,
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

describe("digestAutoMinute — strictly past the arrivals, at minute grain (#2121)", () => {
  it("the measured profile resolves past every arrival, not to the wake hour", () => {
    // THE OLD DEFECT: round(340/60) = 6, before ALL eleven measured arrivals. At
    // minute grain the answer is wake + p90 lag + 1 = 05:40 + 122 + 1 = 07:43 —
    // no longer rounded up to the whole hour 8, and still past the arrivals.
    expect(Math.round(MEASURED_WAKE_MIN / 60)).toBe(6); // the old answer's input
    const minute = digestAutoMinute(
      MEASURED_WAKE_MIN,
      arrivalLagAllowance(MEASURED_LAGS)
    );
    expect(minute).toBe(MEASURED_WAKE_MIN + 122 + 1); // 07:43
    // The p90 share of measured arrivals is in hand by then; the remaining tail
    // (129 min, 1 of 11 nights) is exactly what the one-hour deferral is for —
    // the old whole-hour round-up to 08:00 only covered it by accident.
    const inHand = MEASURED_LAGS.filter(
      (lag) => MEASURED_WAKE_MIN + lag < minute!
    );
    expect(inHand.length / MEASURED_LAGS.length).toBeGreaterThanOrEqual(0.9);
    expect(minute).toBeLessThan(8 * 60); // strictly earlier than the old answer
  });

  it("a 05:40 wake never resolves into the 6 o'clock hour once a real lag is known", () => {
    for (const lag of MEASURED_LAGS) {
      expect(digestAutoMinute(MEASURED_WAKE_MIN, lag)).toBeGreaterThan(
        MEASURED_WAKE_MIN + lag
      );
    }
  });

  it("lands strictly after the allowance, never on the same minute", () => {
    // Scheduling the digest for the minute the data typically lands is a race it
    // loses half the time — the +1 is the whole guarantee.
    expect(digestAutoMinute(300, 60)).toBe(361);
    expect(digestAutoMinute(359, 0)).toBe(360);
  });

  it("returns null — the caller's fallback signal — without both inputs", () => {
    expect(digestAutoMinute(null, 122)).toBeNull();
    expect(digestAutoMinute(MEASURED_WAKE_MIN, null)).toBeNull();
    expect(digestAutoMinute(null, null)).toBeNull();
  });

  it("clamps inside the deferrable range rather than wrapping into the next day", () => {
    expect(digestAutoMinute(23 * 60 + 30, 120)).toBe(LAST_DEFERRABLE_MINUTE);
  });
});

describe("shouldDeferDigest — once, and only into an attempt that exists", () => {
  const pending = () => true;
  const arrived = () => false;
  const at = (slotMinute: number, currentMinute: number, tickMinutes = 60) => ({
    slotMinute,
    currentMinute,
    tickMinutes,
    auto: true,
  });

  it("defers on the first attempt band when sleep is pending", () => {
    expect(shouldDeferDigest(at(7 * 60, 7 * 60), pending)).toBe(true);
    // A sub-hourly auto slot under 15-minute ticks: the first tick at/after it.
    expect(shouldDeferDigest(at(7 * 60 + 43, 7 * 60 + 45, 15), pending)).toBe(
      true
    );
  });

  it("never defers on the retry attempt — that attempt is the bound", () => {
    expect(shouldDeferDigest(at(7 * 60, 8 * 60), pending)).toBe(false);
    expect(shouldDeferDigest(at(7 * 60 + 43, 8 * 60 + 45, 15), pending)).toBe(
      false
    );
  });

  it("does not defer when last night is already in hand", () => {
    expect(shouldDeferDigest(at(7 * 60, 7 * 60), arrived)).toBe(false);
  });

  it("leaves a manually set time alone, and does not even ask", () => {
    // A manual time is user-owned timing: silently sliding someone's 07:00 to 08:00
    // makes their own setting untrue. The thunk going uncalled also proves the
    // sleep read is not paid for on a profile that can never defer.
    const ask = vi.fn(() => true);
    expect(
      shouldDeferDigest(
        { slotMinute: 7 * 60, currentMinute: 7 * 60, tickMinutes: 60, auto: false },
        ask
      )
    ).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask on the retry attempt either", () => {
    const ask = vi.fn(() => true);
    shouldDeferDigest(at(7 * 60, 8 * 60), ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses to defer out of the last slot that has a retry attempt", () => {
    // slotAttempt does not wrap past midnight, so a slot past 22:59 has no
    // same-day retry: declining there would DROP the digest for the day rather
    // than delay it.
    expect(
      shouldDeferDigest(at(LAST_DEFERRABLE_MINUTE, LAST_DEFERRABLE_MINUTE), pending)
    ).toBe(true);
    expect(shouldDeferDigest(at(23 * 60, 23 * 60), pending)).toBe(false);
  });

  it("is bounded across a whole day of ticks: at most one tick is ever declined", () => {
    // Sleep never arrives; the digest still has exactly one attempt on which the
    // gate is open and nothing is declining it — at hourly AND 15-minute ticks.
    for (const tick of [60, 15]) {
      const slotMinute = 7 * 60 + (tick === 15 ? 43 : 0);
      const declined: number[] = [];
      const eligible: number[] = [];
      for (let now = 0; now < 1440; now += tick) {
        const attempt = shouldDeferDigest(at(slotMinute, now, tick), pending);
        if (attempt) declined.push(now);
        else if (
          // slotDue's bands, inlined: due and not declined ⇒ it sends.
          now - slotMinute >= 0 &&
          (now - slotMinute < tick ||
            (now - slotMinute >= 60 && now - slotMinute < 60 + tick))
        )
          eligible.push(now);
      }
      expect(declined, `tick=${tick}`).toHaveLength(1);
      expect(eligible, `tick=${tick}`).toHaveLength(1);
      expect(eligible[0] - declined[0]).toBe(60);
    }
  });
});
