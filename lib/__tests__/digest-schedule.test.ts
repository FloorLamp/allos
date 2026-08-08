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
  DEADLINE_FALLBACK_MIN,
  DEADLINE_MARGIN_MIN,
  describeDigestSchedule,
  digestDeadlineMinute,
  DIGEST_DEFAULT_MINUTE,
  formatDigestAttempt,
  interpolatedPercentile,
  MAX_DIGEST_ATTEMPTS,
  nextDigestAttempt,
  parseDigestAttempt,
  parseDigestMode,
  planDigestTick,
  type ArrivalNight,
  type ArrivalStatistics,
  type ArrivalUnavailableReason,
  type DigestTickInput,
} from "@/lib/notifications/digest-schedule";
import { SLOT_RETRY_DELAY_MIN } from "@/lib/notifications/schedule";

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
    expect(s.p90Minute - OLD_COMPOSITION).toBeGreaterThanOrEqual(29);

    // And the cost the issue measures. A digest scheduled at minute m first attempts
    // on the first 15-minute tick at or after m, so what it carries is every night
    // that landed by then: 8 of 13 at the composed time, 12 of 13 at the corrected
    // one — most of the failure rate the p90 was chosen to avoid, handed back.
    const carriedBy = (m: number) =>
      ARRIVALS.filter((a) => a <= Math.ceil(m / 15) * 15).length;
    expect(carriedBy(OLD_COMPOSITION)).toBe(8);
    expect(carriedBy(s.p90Minute)).toBe(12);
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
    expect(s.p90Minute).toBe(MEASURED_WAKE_MIN + 122); // 07:42
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
    // The consumers take the no-answer FALLBACK rather than inventing a minute.
    expect(digestDeadlineMinute(7 * 60, s, 15)).toBe(
      7 * 60 + DEADLINE_FALLBACK_MIN
    );
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

// ── The two modes (#2211) ────────────────────────────────────────────────────

const P90 = 7 * 60 + 40; // the measured fixture's arrival p90
const FLOOR = 7 * 60;

const answered = (p90Minute = P90): ArrivalStatistics => ({
  available: true,
  nights: 13,
  p90Minute,
  medianMinute: p90Minute - 36,
});
const unanswered = (
  reason: ArrivalUnavailableReason,
  nights = 0
): ArrivalStatistics => ({ available: false, nights, reason });

const ALL_REASONS: ArrivalUnavailableReason[] = [
  "no-source",
  "no-arrivals",
  "thin-sample",
  "dispersed",
];

describe("digestDeadlineMinute — derived from the distribution, not from the floor", () => {
  it("is the arrival p90 plus the declared margin", () => {
    // The whole structural point: with no `auto` left, the floor has nothing to
    // secretly anchor, so the deadline comes from #2214's statistic. On the measured
    // fixture that is 07:40 + 30 = 08:10 — and it is NOT floor + 60 (08:00), which
    // is what makes the two constants separable at all.
    expect(digestDeadlineMinute(FLOOR, answered(), 15)).toBe(P90 + 30);
    expect(DEADLINE_MARGIN_MIN).toBe(30);
    expect(digestDeadlineMinute(FLOOR, answered(), 15)).not.toBe(
      FLOOR + SLOT_RETRY_DELAY_MIN
    );
  });

  it("falls back to floor + 60 — today's behavior — for EVERY no-answer reason", () => {
    // Constraint: never extrapolate from a sample that cannot carry a percentile.
    // A profile with no history is unchanged by this issue, whichever way its
    // sample failed to qualify.
    for (const reason of ALL_REASONS) {
      expect(digestDeadlineMinute(FLOOR, unanswered(reason), 15), reason).toBe(
        FLOOR + DEADLINE_FALLBACK_MIN
      );
    }
    expect(DEADLINE_FALLBACK_MIN).toBe(SLOT_RETRY_DELAY_MIN);
  });

  it("is floored at one tick past the floor, so Dynamic never degenerates", () => {
    // A p90 at or before the floor would otherwise collapse the deadline onto the
    // floor and turn Dynamic into Static without saying so.
    expect(digestDeadlineMinute(FLOOR, answered(FLOOR - 90), 15)).toBe(
      FLOOR + 15
    );
    expect(digestDeadlineMinute(FLOOR, answered(FLOOR - 90), 60)).toBe(
      FLOOR + 60
    );
  });

  it("clamps at LAST_DEFERRABLE_MINUTE rather than wrapping into the next day", () => {
    expect(digestDeadlineMinute(21 * 60, answered(23 * 60), 15)).toBe(
      LAST_DEFERRABLE_MINUTE
    );
  });

  it("collapses onto a floor that has no room left to wait", () => {
    // Past LAST_DEFERRABLE_MINUTE there is no same-day retry band to wait into, so
    // the honest answer is "behave as Static" — not a deadline before the floor,
    // which would drop the digest for the day.
    const late = 23 * 60 + 30;
    expect(digestDeadlineMinute(late, answered(), 15)).toBe(late);
    expect(digestDeadlineMinute(late, unanswered("no-source"), 15)).toBe(late);
  });
});

describe("planDigestTick — Static is today's behavior, to the minute", () => {
  const staticAt = (
    currentMinute: number,
    tickMinutes = 60
  ): DigestTickInput => ({
    mode: "static",
    slotMinute: FLOOR,
    currentMinute,
    tickMinutes,
    deadlineMinute: () => FLOOR,
    attempt: null,
  });

  it("sends on both slot-anchored bands, sleep pending or not", () => {
    // THE regression that must never land. #2211's measured defect was that a typed
    // time never waited; the fix is not to make it wait, it is to give the person
    // who wants waiting a mode that says so.
    for (const pending of [true, false]) {
      expect(planDigestTick(staticAt(FLOOR), () => pending)).toBe("send");
      expect(planDigestTick(staticAt(FLOOR + 60), () => pending)).toBe("send");
      // Between the bands (at a tick fine enough to land there) and before the
      // slot, nothing happens — the two bands are the whole window.
      expect(planDigestTick(staticAt(FLOOR + 30, 15), () => pending)).toBe(
        "idle"
      );
      expect(planDigestTick(staticAt(FLOOR - 60), () => pending)).toBe("idle");
    }
  });

  it("never asks whether sleep is pending", () => {
    // The thunk going uncalled is what proves a Static profile pays nothing for the
    // sleep read — and that Static cannot acquire waiting behavior by accident.
    const ask = vi.fn(() => true);
    for (let now = 0; now < 1440; now += 15)
      planDigestTick(staticAt(now, 15), ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it("never returns `wait`, at any tick rate", () => {
    for (const tick of [1, 15, 60]) {
      for (let now = 0; now < 1440; now += tick) {
        expect(planDigestTick(staticAt(now, tick), () => true)).not.toBe(
          "wait"
        );
      }
    }
  });

  it("never resolves the deadline (#2249)", () => {
    // The deadline's gather is a 30-night arrival join, and Static ignores the
    // answer entirely — so the thunk going uncalled is what proves a Static profile
    // pays nothing for it, the same argument the sleep thunk makes above.
    const deadline = vi.fn(() => FLOOR);
    for (let now = 0; now < 1440; now += 15)
      planDigestTick(
        { ...staticAt(now, 15), deadlineMinute: deadline },
        () => true
      );
    expect(deadline).not.toHaveBeenCalled();
  });
});

describe("planDigestTick — Dynamic re-checks, then sends at the deadline", () => {
  const deadline = digestDeadlineMinute(FLOOR, answered(), 15); // 08:10
  const dyn = (
    currentMinute: number,
    over: Partial<DigestTickInput> = {}
  ): DigestTickInput => ({
    mode: "dynamic",
    slotMinute: FLOOR,
    currentMinute,
    tickMinutes: 15,
    deadlineMinute: () => deadline,
    attempt: null,
    ...over,
  });

  it("sends on the NEXT TICK after the data lands, not an hour later", () => {
    // The measured waste: five mornings whose sleep landed at 07:26–07:48 waited
    // until the 08:15 retry band, a mean of 33 avoidable minutes, with three ticks
    // running in between that could each have answered "has it landed?".
    const arrivals = [
      7 * 60 + 26,
      7 * 60 + 26,
      7 * 60 + 30,
      7 * 60 + 42,
      7 * 60 + 48,
    ];
    for (const arrival of arrivals) {
      const sentAt: number[] = [];
      for (let now = FLOOR; now < 1440 && sentAt.length === 0; now += 15) {
        if (planDigestTick(dyn(now), () => now < arrival) === "send")
          sentAt.push(now);
      }
      // The first tick at or after the arrival — never the old 08:15.
      expect(sentAt[0], `arrival=${arrival}`).toBe(
        Math.ceil(arrival / 15) * 15
      );
      expect(sentAt[0]).toBeLessThan(8 * 60 + 15);
    }
  });

  it("sends at the floor the moment last night is already in hand", () => {
    expect(planDigestTick(dyn(FLOOR), () => false)).toBe("send");
  });

  it("declines — and writes nothing — while the night is outstanding", () => {
    expect(planDigestTick(dyn(FLOOR), () => true)).toBe("wait");
    expect(planDigestTick(dyn(FLOOR + 45), () => true)).toBe("wait");
  });

  it("sends unconditionally at the deadline when the night never arrives", () => {
    // Constraint 2, never later than today: one pending section must never hold
    // activity, upcoming and biomarkers hostage.
    expect(planDigestTick(dyn(deadline), () => true)).toBe("send");
    expect(planDigestTick(dyn(deadline + 5), () => true)).toBe("send");
  });

  it("collapses to 'send at the floor' when there is nothing to wait for", () => {
    // The Sleep section off makes `digestSleepPending` false by construction, so
    // Dynamic is exactly Static for that profile — stated in the copy rather than
    // left to be discovered.
    expect(planDigestTick(dyn(FLOOR), () => false)).toBe("send");
  });

  it("never sends before its floor, and never wraps past midnight", () => {
    for (let now = 0; now < FLOOR; now += 15)
      expect(planDigestTick(dyn(now), () => false)).toBe("idle");
  });

  it("reproduces today's behavior bit-for-bit at hourly ticks", () => {
    // The operator on `0 * * * *` sees the digest at its floor when the data is in
    // hand, and at the fallback band when it isn't — which is where it always was.
    const hourly = (now: number, stats: ArrivalStatistics) =>
      dyn(now, {
        tickMinutes: 60,
        deadlineMinute: () => digestDeadlineMinute(FLOOR, stats, 60),
      });
    const noStats = unanswered("no-source");
    expect(planDigestTick(hourly(FLOOR, noStats), () => true)).toBe("wait");
    expect(planDigestTick(hourly(FLOOR + 60, noStats), () => true)).toBe(
      "send"
    );
  });

  it("resolves the deadline only once the tick reaches the floor (#2249)", () => {
    // Dynamic pays for the arrival gather from local midnight until the digest
    // sends — ~28 reads at a 15-minute cadence and an 07:00 floor — of which every
    // one before the floor belongs to a tick that returns `idle` without consulting
    // the deadline at all. Lazy, the pre-floor ticks cost nothing.
    const before = vi.fn(() => deadline);
    for (let now = 0; now < FLOOR; now += 15)
      planDigestTick({ ...dyn(now), deadlineMinute: before }, () => true);
    expect(before).not.toHaveBeenCalled();

    // Nor under a failed-attempt record, which short-circuits everything below it.
    const failed = vi.fn(() => deadline);
    planDigestTick(
      {
        ...dyn(FLOOR + 15, {
          attempt: { date: "2026-08-07", attempts: 1, minute: FLOOR },
        }),
        deadlineMinute: failed,
      },
      () => true
    );
    expect(failed).not.toHaveBeenCalled();

    // And exactly once on a re-check tick, which needs it to decide the window.
    const inWindow = vi.fn(() => deadline);
    expect(
      planDigestTick({ ...dyn(FLOOR), deadlineMinute: inWindow }, () => true)
    ).toBe("wait");
    expect(inWindow).toHaveBeenCalledTimes(1);
  });

  it("bounds the work after the deadline to the same two bands Static gets", () => {
    // A digest with no channel configured marks nothing, so without a bound it
    // would rebuild every tick until midnight.
    const sends: number[] = [];
    for (let now = FLOOR; now < 1440; now += 15)
      if (planDigestTick(dyn(now), () => true) === "send") sends.push(now);
    expect(sends).toHaveLength(2);
    expect(sends[1] - sends[0]).toBe(SLOT_RETRY_DELAY_MIN);
  });
});

describe("planDigestTick — a decline and a failed send are different things", () => {
  const deadline = digestDeadlineMinute(FLOOR, answered(), 15);
  const dyn = (
    currentMinute: number,
    attempt: DigestTickInput["attempt"] = null
  ): DigestTickInput => ({
    mode: "dynamic",
    slotMinute: FLOOR,
    currentMinute,
    tickMinutes: 15,
    deadlineMinute: () => deadline,
    attempt,
  });
  const failedAt = (minute: number, attempts = 1) => ({
    date: "2026-08-07",
    attempts,
    minute,
  });

  it("re-asks after a decline; backs off for an hour after a failure", () => {
    // Today both leave the same trace — none — which is exactly what let #2102 be
    // stateless. The record's PRESENCE is the distinction: a decline writes nothing
    // and the next tick asks again, a failure writes one and the next tick waits.
    expect(planDigestTick(dyn(FLOOR + 15), () => false)).toBe("send");
    expect(planDigestTick(dyn(FLOOR + 15, failedAt(FLOOR)), () => false)).toBe(
      "idle"
    );
  });

  it("anchors the retry to the ATTEMPT INSTANT, not to the floor", () => {
    // Rule 2, and the reason it is a rule: a Dynamic send fires at whatever tick the
    // data landed on. A send failing at 08:05 must retry at 09:05 — a floor-anchored
    // band would sit at 08:00, already in the past, and this send would silently get
    // no retry at all.
    const failed = failedAt(8 * 60 + 5);
    expect(planDigestTick(dyn(9 * 60 + 5, failed), () => false)).toBe("send");
    expect(planDigestTick(dyn(FLOOR + 60, failed), () => false)).toBe("idle");
    expect(planDigestTick(dyn(8 * 60 + 20, failed), () => false)).toBe("idle");
  });

  it("gives a failing send exactly two attempts an hour apart, at every tick rate", () => {
    // #2121 item 3's budget, unchanged: re-checks re-evaluate a CONDITION, they
    // never re-attempt a delivery. However many re-check ticks ran, the attempt
    // count is the same.
    for (const tick of [1, 5, 15, 60]) {
      let attempt: DigestTickInput["attempt"] = null;
      const attempts: number[] = [];
      for (let now = 0; now < 1440; now += tick) {
        const action = planDigestTick(
          {
            mode: "dynamic",
            slotMinute: FLOOR,
            currentMinute: now,
            tickMinutes: tick,
            deadlineMinute: () => digestDeadlineMinute(FLOOR, answered(), tick),
            attempt,
          },
          () => false
        );
        if (action === "send") {
          attempts.push(now);
          attempt = nextDigestAttempt(attempt, "2026-08-07", now);
        }
      }
      expect(attempts, `tick=${tick}`).toHaveLength(MAX_DIGEST_ATTEMPTS);
      expect(attempts[1] - attempts[0], `tick=${tick}`).toBe(
        SLOT_RETRY_DELAY_MIN
      );
    }
  });

  it("stops once the budget is spent, whatever the clock says", () => {
    const spent = failedAt(8 * 60, MAX_DIGEST_ATTEMPTS);
    for (let now = FLOOR; now < 1440; now += 15)
      expect(planDigestTick(dyn(now, spent), () => false)).toBe("idle");
  });
});

describe("the per-day attempt record", () => {
  it("round-trips", () => {
    const a = { date: "2026-08-07", attempts: 1, minute: 485 };
    expect(parseDigestAttempt(formatDigestAttempt(a), "2026-08-07")).toEqual(a);
  });

  it("reads as absent for any other day — the day rolling over is the re-arm", () => {
    const a = formatDigestAttempt({
      date: "2026-08-06",
      attempts: 2,
      minute: 485,
    });
    expect(parseDigestAttempt(a, "2026-08-07")).toBeNull();
  });

  it("reads as absent when missing or corrupt, never as a phantom attempt", () => {
    // A record that failed to parse must not spend someone's send budget.
    for (const raw of [
      undefined,
      "",
      "garbage",
      "2026-08-07",
      "2026-08-07|0|485",
      "2026-08-07|x|485",
      "2026-08-07|1|-1",
      "2026-08-07|1|1440",
    ]) {
      expect(parseDigestAttempt(raw, "2026-08-07"), String(raw)).toBeNull();
    }
  });

  it("counts up from nothing", () => {
    const first = nextDigestAttempt(null, "2026-08-07", 480);
    expect(first).toEqual({ date: "2026-08-07", attempts: 1, minute: 480 });
    expect(nextDigestAttempt(first, "2026-08-07", 540)).toEqual({
      date: "2026-08-07",
      attempts: 2,
      minute: 540,
    });
  });
});

describe("parseDigestMode — Static is what anything unrecognised means", () => {
  it("reads the two modes and nothing else", () => {
    expect(parseDigestMode("dynamic")).toBe("dynamic");
    expect(parseDigestMode("static")).toBe("static");
  });

  it("never turns waiting on by accident", () => {
    // A mode change that makes the digest behave differently needs the user's own
    // tap behind it (#2211 constraint 3), so absent/corrupt is Static — the mode
    // every pre-#2211 digest already had.
    for (const raw of [undefined, "", "auto", "1", "Dynamic", "smart"])
      expect(parseDigestMode(raw), String(raw)).toBe("static");
  });
});

describe("describeDigestSchedule — the four no-answer reasons stay four things", () => {
  const base = {
    floorMinute: FLOOR,
    sleepSectionEnabled: true,
    tickMinutes: 15,
  };

  it("names the send time in Static, and promises nothing about completeness", () => {
    const s = describeDigestSchedule({
      ...base,
      mode: "static",
      stats: answered(),
    });
    expect(s.headline).toContain("07:00");
    expect(s.headline).toContain("whether or not");
    expect(s.detail).toBeNull();
  });

  it("names BOTH times in Dynamic — the floor and the deadline", () => {
    const s = describeDigestSchedule({
      ...base,
      mode: "dynamic",
      stats: answered(),
    });
    expect(s.headline).toContain("07:00");
    expect(s.headline).toContain("08:10");
    expect(s.detail).toContain("07:40"); // the measured p90 it derives from
  });

  it("drops the sleep clause from the Static headline when the section is off (#2255)", () => {
    // "…whether or not last night's sleep has arrived by then" is noise for a digest
    // that carries no sleep at all: there is no arrival for the send time to beat.
    // Parallel to the Dynamic branch's own sleep-off variant below.
    const s = describeDigestSchedule({
      ...base,
      mode: "static",
      sleepSectionEnabled: false,
      stats: answered(),
    });
    expect(s.headline).toBe("Sends at 07:00 every day.");
    expect(s.detail).toBeNull();
  });

  it("renders its clock times through the login's format seam (#964/#1163)", () => {
    const twelve = describeDigestSchedule({
      ...base,
      mode: "dynamic",
      stats: answered(),
      timeFormat: "12h",
    });
    expect(twelve.headline).toContain("7:00 AM");
    expect(twelve.headline).toContain("8:10 AM");
    expect(twelve.detail).toContain("7:40 AM");
    // Absent, the fixed 24-h format a surface with no login in context documents.
    expect(
      describeDigestSchedule({ ...base, mode: "dynamic", stats: answered() })
    ).toEqual(
      describeDigestSchedule({
        ...base,
        mode: "dynamic",
        stats: answered(),
        timeFormat: "24h",
      })
    );
  });

  it("states the Sleep-section-off collapse rather than leaving it discovered", () => {
    const s = describeDigestSchedule({
      ...base,
      mode: "dynamic",
      sleepSectionEnabled: false,
      stats: answered(),
    });
    expect(s.headline).toContain("nothing to wait for");
    expect(s.headline).toContain("07:00");
    expect(s.headline).not.toContain("08:10");
  });

  it("says something DIFFERENT for each of the four reasons", () => {
    const said = ALL_REASONS.map(
      (reason) =>
        describeDigestSchedule({
          ...base,
          mode: "dynamic",
          stats: unanswered(reason, reason === "thin-sample" ? 3 : 0),
        }).detail
    );
    expect(new Set(said).size).toBe(ALL_REASONS.length);
    for (const s of said) expect(s).toBeTruthy();
  });

  it("tells the thin sample to wait, and counts what it is waiting for", () => {
    const s = describeDigestSchedule({
      ...base,
      mode: "dynamic",
      stats: unanswered("thin-sample", 3),
    });
    expect(s.detail).toContain("3 of the 5");
  });

  it("NEVER tells the dispersed sample to wait — it will never qualify", () => {
    // `dispersed` means the arrival sample spans more than half the clock, which is
    // what a shift worker's genuine rhythm looks like. Promising that person a
    // sample that will never qualify is the editorialising constraint 4 forbids —
    // and it is why these four reasons exist as four values rather than one.
    const s = describeDigestSchedule({
      ...base,
      mode: "dynamic",
      stats: unanswered("dispersed", 13),
    });
    expect(s.detail).toContain("will not");
    expect(s.detail).not.toMatch(/needed|so far|yet/);
  });

  it("never editorialises about the person, in any state", () => {
    const all = [
      describeDigestSchedule({ ...base, mode: "static", stats: answered() }),
      describeDigestSchedule({ ...base, mode: "dynamic", stats: answered() }),
      ...ALL_REASONS.map((reason) =>
        describeDigestSchedule({
          ...base,
          mode: "dynamic",
          stats: unanswered(reason, 3),
        })
      ),
    ];
    for (const s of all) {
      const text = `${s.headline} ${s.detail ?? ""}`;
      expect(text).not.toMatch(/smart|irregular|erratic|bad|poor|should/i);
    }
  });
});

describe("the declared digest pre-fill", () => {
  it("is 07:00, in one place, for the picker and onboarding alike", () => {
    expect(DIGEST_DEFAULT_MINUTE).toBe(7 * 60);
  });
});
