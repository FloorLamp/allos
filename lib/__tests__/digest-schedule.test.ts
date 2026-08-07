// PURE TIER — the morning digest's own scheduling decisions (#2102), with the
// arrival statistic corrected in #2214.
//
// The numbers below are MEASURED, not invented. Two real samples from the same
// Health Connect profile:
//
//   • MEASURED_NIGHTS — the 13-night sample in #2214, each night carrying its own
//     wake minute, its own sync lag and therefore its own arrival clock time. It is
//     the fixture BECAUSE the three vary independently: median wake 05:43, p90 lag
//     86, and a true p90 arrival of 07:39.6 that the old composition put at 07:10.
//   • MEASURED_LAGS / MEASURED_WAKE_MIN — the older 11-night sample from #2102,
//     kept for the one case the composition got right by luck (a steady wake time),
//     which must not regress.

import { describe, it, expect, vi } from "vitest";
import {
  ARRIVAL_PERCENTILE,
  ARRIVAL_TYPICAL_PERCENTILE,
  LAST_DEFERRABLE_MINUTE,
  MAX_ARRIVAL_LAG_MIN,
  MAX_ARRIVAL_SPREAD_MIN,
  MIN_ARRIVAL_SAMPLE,
  arrivalStatistics,
  digestAutoMinute,
  interpolatedPercentile,
  shouldDeferDigest,
  type ArrivalNight,
} from "@/lib/notifications/digest-schedule";

// #2214's measured 13 nights. `arrival` is the clock time the sleep row landed at,
// `lag` how far behind the night's end that was, so `wake` = arrival − lag. Ordered
// by arrival for readability only; nothing here depends on the input order.
const MEASURED_NIGHTS: { arrival: number; lag: number }[] = [
  { arrival: 6 * 60 + 2, lag: 30 },
  { arrival: 6 * 60 + 6, lag: 35 },
  { arrival: 6 * 60 + 14, lag: 40 },
  { arrival: 6 * 60 + 26, lag: 45 },
  { arrival: 6 * 60 + 47, lag: 64 },
  { arrival: 6 * 60 + 50, lag: 55 },
  { arrival: 7 * 60 + 4, lag: 86 },
  { arrival: 7 * 60 + 11, lag: 86 },
  { arrival: 7 * 60 + 26, lag: 105 },
  { arrival: 7 * 60 + 26, lag: 80 },
  { arrival: 7 * 60 + 30, lag: 70 },
  { arrival: 7 * 60 + 42, lag: 65 },
  { arrival: 7 * 60 + 48, lag: 50 },
];

// A calendar date per night — ordinary days, no offset change. `arrivalStatistics`
// reads `date` only through `dstTransition`, which the gather resolves.
const night = (
  n: { arrival: number; lag: number },
  i: number,
  over: Partial<ArrivalNight> = {}
): ArrivalNight => ({
  date: `2026-07-${String(24 + i).padStart(2, "0")}`,
  arrivalMinute: n.arrival,
  lagMin: n.lag,
  dstTransition: false,
  ...over,
});

// The older #2102 sample: a STEADY 05:40 wake with all the variation in the lag.
const MEASURED_LAGS = [22, 26, 35, 47, 70, 85, 91, 106, 106, 122, 129];
const MEASURED_WAKE_MIN = 5 * 60 + 40;

const MEASURED = MEASURED_NIGHTS.map((n, i) => night(n, i));
const ARRIVALS = MEASURED_NIGHTS.map((n) => n.arrival).sort((a, b) => a - b);
const WAKES = MEASURED_NIGHTS.map((n) => n.arrival - n.lag).sort(
  (a, b) => a - b
);
const LAGS = MEASURED_NIGHTS.map((n) => n.lag).sort((a, b) => a - b);

// The old, wrong answer, computed here from the SAME fixture so the regression is
// pinned against arithmetic rather than against a remembered number: a CENTRAL value
// of the wake distribution plus a TAIL value of the lag distribution.
const OLD_COMPOSITION =
  Math.round(interpolatedPercentile(WAKES, 0.5)) +
  Math.round(interpolatedPercentile(LAGS, ARRIVAL_PERCENTILE)) +
  1;

const stat = (nights: readonly ArrivalNight[]) => arrivalStatistics(nights);

describe("arrivalStatistics — a percentile of ARRIVALS, not a composition (#2214)", () => {
  it("reproduces the measured p90 arrival, and the composition it replaces is ~30 min low", () => {
    // The interpolated position, unrounded — the number the issue quotes as 07:39
    // and its test spec accepts as 07:39/07:40. Rounding is the shared method's, so
    // the statistic itself lands on 07:40.
    expect(interpolatedPercentile(ARRIVALS, ARRIVAL_PERCENTILE)).toBeCloseTo(
      459.6,
      6
    );
    const s = stat(MEASURED);
    expect(s.available).toBe(true);
    if (!s.available) return;
    expect(s.p90Minute).toBe(7 * 60 + 40);
    expect(s.nights).toBe(13);

    // The inputs the old formula composed, each reproduced from this fixture:
    // median wake 05:43, p90 lag 86 → 07:10.
    expect(interpolatedPercentile(WAKES, 0.5)).toBe(5 * 60 + 43);
    expect(interpolatedPercentile(LAGS, ARRIVAL_PERCENTILE)).toBe(86);
    expect(OLD_COMPOSITION).toBe(7 * 60 + 10);
    expect(digestAutoMinute(s)! - OLD_COMPOSITION).toBeGreaterThanOrEqual(29);

    // And the cost the issue measures. A digest scheduled at minute m first attempts
    // on the first 15-minute tick at or after m, so what it carries is every night
    // that landed by then: 8 of 13 at the composed time, 12 of 13 at the corrected
    // one — most of the failure rate the p90 was chosen to avoid, handed back.
    const carriedBy = (m: number) =>
      ARRIVALS.filter((a) => a <= Math.ceil(m / 15) * 15).length;
    expect(carriedBy(OLD_COMPOSITION)).toBe(8);
    expect(carriedBy(digestAutoMinute(s)!)).toBe(12);
  });

  it("also reports the MEDIAN arrival, from the same admitted sample", () => {
    // #2217 asks "does the configured time lose more often than not", which is a
    // question about the median and nothing else. It comes out of this computation
    // rather than a second one, so the two consumers cannot describe two different
    // distributions.
    const s = stat(MEASURED);
    if (!s.available) throw new Error("expected an answer");
    expect(s.medianMinute).toBe(7 * 60 + 4);
    expect(ARRIVAL_TYPICAL_PERCENTILE).toBe(0.5);
    expect(ARRIVAL_PERCENTILE).toBeGreaterThan(ARRIVAL_TYPICAL_PERCENTILE);
    expect(s.p90Minute).toBeGreaterThan(s.medianMinute);
  });

  it("still agrees with the composition on the case it got right by luck", () => {
    // A STEADY wake time is the one shape where median-wake + p90-lag is the p90 of
    // arrivals: with wake constant the two distributions differ only by that
    // constant. #2102's 11-night sample is exactly that shape, and the corrected
    // computation must not move it.
    const steady = MEASURED_LAGS.map((lag, i) =>
      night({ arrival: MEASURED_WAKE_MIN + lag, lag }, i)
    );
    const s = stat(steady);
    if (!s.available) throw new Error("expected an answer");
    expect(s.p90Minute).toBe(MEASURED_WAKE_MIN + 122);
    expect(digestAutoMinute(s)).toBe(MEASURED_WAKE_MIN + 122 + 1); // 07:43
  });
});

describe("arrivalStatistics — admission is on the LAG, measurement on the clock", () => {
  it("drops rows that are not morning arrivals before the percentile sees them", () => {
    // A negative lag is a row stamped before the session it describes ended; a
    // multi-day one is a bulk import. Neither describes when last night lands, and
    // either would drag the percentile with it — so neither reaches it.
    const polluted = [
      ...MEASURED,
      night({ arrival: 3 * 60, lag: -30 }, 20),
      night({ arrival: 13 * 60, lag: MAX_ARRIVAL_LAG_MIN + 1 }, 21),
      night({ arrival: 19 * 60, lag: 4000 }, 22),
    ];
    const s = stat(polluted);
    if (!s.available) throw new Error("expected an answer");
    expect(s.p90Minute).toBe(7 * 60 + 40);
    expect(s.nights).toBe(13); // the count is what SURVIVED, not what was offered
  });

  it("admits a lag exactly on the boundary", () => {
    const edge = MEASURED.map((n, i) =>
      i === 0 ? { ...n, lagMin: MAX_ARRIVAL_LAG_MIN } : n
    );
    expect(stat(edge)).toMatchObject({ available: true, nights: 13 });
    const zero = MEASURED.map((n, i) => (i === 0 ? { ...n, lagMin: 0 } : n));
    expect(stat(zero)).toMatchObject({ available: true, nights: 13 });
  });
});

describe("arrivalStatistics — no answer is a first-class state", () => {
  it("names the empty case rather than returning a time", () => {
    // A profile with no syncing sleep source at all. There is no minute in this
    // result to mistake for one — the union has no p90Minute on this branch.
    expect(stat([])).toEqual({
      available: false,
      nights: 0,
      reason: "no-source",
    });
  });

  it("distinguishes 'nothing arrived' from 'nothing was offered'", () => {
    const allRejected = [-5, -10, 5000, 6000, 7000, 8000].map((lag, i) =>
      night({ arrival: 12 * 60, lag }, i)
    );
    expect(stat(allRejected)).toEqual({
      available: false,
      nights: 0,
      reason: "no-arrivals",
    });
  });

  it("refuses a sample thinner than the gate, and says how thin", () => {
    const thin = MEASURED.slice(0, MIN_ARRIVAL_SAMPLE - 1);
    expect(stat(thin)).toEqual({
      available: false,
      nights: MIN_ARRIVAL_SAMPLE - 1,
      reason: "thin-sample",
    });
    // Exactly at the gate it answers.
    expect(stat(MEASURED.slice(0, MIN_ARRIVAL_SAMPLE)).available).toBe(true);
  });

  it("never lets a caller read a minute off a no-answer result", () => {
    // The type is the guarantee; this pins the runtime shape that backs it.
    const s = stat([]);
    expect(Object.keys(s).sort()).toEqual(["available", "nights", "reason"]);
    expect(digestAutoMinute(s)).toBeNull();
    expect(digestAutoMinute(stat(MEASURED.slice(0, 2)))).toBeNull();
  });
});

describe("arrivalStatistics — midnight wrap, stated rather than assumed", () => {
  it("orders morning arrivals as plain minutes of day", () => {
    // The normal case, pinned: an all-morning sample is a contiguous run on
    // [0, 1440) and the naive percentile is the right one.
    const s = stat(MEASURED);
    if (!s.available) throw new Error("expected an answer");
    expect(ARRIVALS[ARRIVALS.length - 1] - ARRIVALS[0]).toBeLessThan(
      MAX_ARRIVAL_SPREAD_MIN
    );
    expect(s.p90Minute).toBe(7 * 60 + 40);
  });

  it("REFUSES a sample straddling midnight instead of averaging across the seam", () => {
    // 00:14 and 23:50 are 24 minutes apart on a clock and 1416 on the number line.
    // A percentile over that describes a distribution that does not exist, so the
    // statistic declines rather than inventing a midday answer.
    const wrapped = [23 * 60 + 50, 23 * 60 + 55, 5, 10, 14, 20].map(
      (arrival, i) => night({ arrival, lag: 60 }, i)
    );
    expect(stat(wrapped)).toEqual({
      available: false,
      nights: 6,
      reason: "dispersed",
    });
  });

  it("still answers a wide sample that stays inside one half-day window", () => {
    const wide = [4 * 60, 6 * 60, 8 * 60, 10 * 60, 12 * 60, 14 * 60].map(
      (arrival, i) => night({ arrival, lag: 90 }, i)
    );
    expect(stat(wide)).toMatchObject({ available: true, nights: 6 });
  });
});

describe("arrivalStatistics — a DST transition day is dropped, visibly", () => {
  it("excludes the transition day and computes over the remainder", () => {
    // The transition day mixes two UTC offsets into one clock-time sample. With ~13
    // nights available a single hour-shifted arrival moves the p90 materially, and
    // it carries no information about the sync pipeline — so it goes.
    const withShift = [
      ...MEASURED,
      night({ arrival: 8 * 60 + 48, lag: 50 }, 20, { dstTransition: true }),
    ];
    const s = stat(withShift);
    if (!s.available) throw new Error("expected an answer");
    expect(s.nights).toBe(13);
    expect(s.p90Minute).toBe(7 * 60 + 40); // unmoved by the excluded night
  });

  it("makes the exclusion visible in the count that gates MIN_ARRIVAL_SAMPLE", () => {
    const barely = MEASURED.slice(0, MIN_ARRIVAL_SAMPLE).map((n, i) =>
      i === 0 ? { ...n, dstTransition: true } : n
    );
    expect(stat(barely)).toEqual({
      available: false,
      nights: MIN_ARRIVAL_SAMPLE - 1,
      reason: "thin-sample",
    });
  });
});

describe("digestAutoMinute — strictly past the arrivals, at minute grain (#2121)", () => {
  const withP90 = (p90Minute: number) =>
    ({
      available: true,
      nights: 13,
      p90Minute,
      medianMinute: p90Minute - 30,
    }) as const;

  it("the measured profile resolves past the arrivals, not to the wake hour", () => {
    // THE OLD DEFECT, twice over: round(340/60) = 6 put the digest before ALL the
    // arrivals, and the composition that replaced it still sat half an hour low.
    expect(Math.round(MEASURED_WAKE_MIN / 60)).toBe(6); // the oldest answer's input
    const minute = digestAutoMinute(stat(MEASURED))!;
    expect(minute).toBe(7 * 60 + 41);
    // Past every arrival but the two the p90 deliberately leaves in the tail — and
    // strictly later than the composition the wake hour fed (07:10).
    expect(ARRIVALS.filter((a) => a < minute).length).toBe(11);
    expect(minute).toBeGreaterThan(OLD_COMPOSITION);
  });

  it("lands strictly after the p90, never on the same minute", () => {
    // Scheduling the digest for the minute the data typically lands is a race it
    // loses half the time — the +1 is the whole guarantee.
    expect(digestAutoMinute(withP90(360))).toBe(361);
    expect(digestAutoMinute(withP90(0))).toBe(1);
  });

  it("returns null — the caller's fallback signal — when there is no statistic", () => {
    expect(digestAutoMinute(stat([]))).toBeNull();
  });

  it("clamps inside the deferrable range rather than wrapping into the next day", () => {
    expect(digestAutoMinute(withP90(23 * 60 + 30))).toBe(
      LAST_DEFERRABLE_MINUTE
    );
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
        {
          slotMinute: 7 * 60,
          currentMinute: 7 * 60,
          tickMinutes: 60,
          auto: false,
        },
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
      shouldDeferDigest(
        at(LAST_DEFERRABLE_MINUTE, LAST_DEFERRABLE_MINUTE),
        pending
      )
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
