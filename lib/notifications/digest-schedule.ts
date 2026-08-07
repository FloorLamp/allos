// The morning digest's OWN scheduling decisions (issue #2102) — pure, no DB, no
// clock, no network.
//
// THE DEFECT, in one sentence: the digest fires at a fixed hour that lands inside
// the window where last night's sleep has not arrived yet. On a real Health
// Connect profile — typical wake 05:40, sleep row arriving a median of 69 minutes
// later (measured range 19–90) — the digest had last night in hand on 0 of 11
// mornings at hour 6 (what `auto` resolved to) and 5 of 11 at hour 7.
//
// Two separate mistakes produced that, and this module holds the fix for both:
//
//   1. `auto` SCHEDULED ITSELF INTO THE GAP. It resolved through the shared
//      wake-hour helper — the hour the person WAKES — while the data the digest
//      wants is systematically ~70 minutes behind waking. The rounding made it
//      worse: 05:40 is 340 minutes and round(340/60) is 6, so the digest fired an
//      hour EARLIER than the manual setting it was meant to improve on.
//      `digestAutoMinute` below resolves past the arrivals instead.
//   2. THE DIGEST COULD NOT WAIT for a section it was about to print. It sent on
//      the first tick where its hour was due, complete or not. `shouldDeferDigest`
//      declines ONCE, into the retry hour `slotDue` already provides.
//
// WHAT THIS MODULE IS NOT. It decides WHEN the digest sends. It never decides what
// the digest prints: #2099 owns that (a stale night is omitted rather than printed
// as last night's), and the two answers stay separate on purpose — a digest that
// sends at the end of the window with no sleep in hand simply has no Sleep section,
// which is already correct behavior.
//
// NO NEW STORED STATE, and in particular NO NEW SEND MARKER (#2036). The deferral
// is structurally bounded by machinery that already exists: `slotDue` is a
// two-hour window and `notify_last_digest` is a hard per-day marker, so declining
// at the FIRST of those two hours leaves exactly one hour in which the digest must
// send, marked or not. "Have I already deferred today?" is answered by the clock
// (this tick is not the slot's "first" attempt band), not by a stored flag —
// which is why nothing here needs to be registered in SEND_MARKER_REGISTRY.

import { slotAttempt } from "./schedule";

// ── 1. The arrival statistic ─────────────────────────────────────────────────
//
// ONE question (#2214): WHEN DOES LAST NIGHT'S SLEEP NORMALLY LAND, IN CLOCK TIME?
//
// It used to be answered by composing two independently varying quantities —
// `digestAutoMinute(typicalWakeTime(p), arrivalLagAllowance(lags))`, a CENTRAL value
// of one plus a TAIL value of the other. That is not the p90 of anything. It is
// biased low whenever wake and lag are not anti-correlated, which is the ordinary
// case: on the measured 13-night sample the true p90 of arrival clock times is
// 07:39.6 and the composition returned 07:10, half an hour early — enough to turn
// 12 complete digests out of 13 into 8.
//
// Since `arrival = wake + lag` per night, and both instants are already in hand on
// the row, the percentile is taken DIRECTLY over the arrival clock times. Nothing is
// composed, and `typicalWakeTime` is not read here at all (it stays the right answer
// for the Morning intake slot, which needs you awake rather than your tracker
// synced).
//
// THE LAG SURVIVES AS THE ADMISSION TEST, not as the quantity. "Is this a morning
// arrival at all?" is a question about the lag — a negative one is a backfill, a
// multi-hour one a Takeout-style bulk import — so nights are admitted on their lag
// and then measured on their clock time.
//
// TWO STATISTICS, ONE COMPUTATION. The p90 is what a send time or a deadline must
// clear; the MEDIAN is what "the configured time loses more often than not" means
// (#2217's trigger). They come out of the same admitted sample in one pass so the
// two consumers cannot end up describing two different distributions.
//
// NOT LIVE. The sample is thin by construction (`integration_sync_rows` retention
// reaches back ~13 days) and jumpy (leave-one-night-out moves the p90 by up to 11
// minutes). Neither consumer may silently BE a user's send time: #2217 proposes this
// number and the user's tap writes it, #2211 uses it as a bound. Read the shape as
// saying so — it answers, it does not bind.

// How many measured arrivals the statistic insists on before it will answer. Below
// this the sample is too thin to carry a percentile and the caller falls back.
// `integration_sync_rows` retention on the measured instance reaches back ~12–13
// days, so a thin sample is the ordinary case rather than an exotic one.
export const MIN_ARRIVAL_SAMPLE = 5;

// The percentile of the ARRIVAL CLOCK TIME distribution a send time or deadline
// clears. NOT the median: a median guarantees ~50% failure by definition.
// (Renamed from ARRIVAL_LAG_PERCENTILE with the correction — it is taken over
// arrivals now, never over lags, and a name saying "lag" would preserve exactly the
// confusion #2214 removes.)
export const ARRIVAL_PERCENTILE = 0.9;

// The typical arrival — the same distribution's midpoint. Declared beside its
// sibling rather than written inline at the call site, because it is a DECISION:
// "does the configured time lose more often than not" is a question about the
// median and about nothing else.
export const ARRIVAL_TYPICAL_PERCENTILE = 0.5;

// Lags outside [0, this] are not MORNING arrivals and never join the sample. A
// negative lag is a row stamped before the session it describes ended (a backfill);
// a multi-hour one is a Takeout-style bulk import or a device that spent the day
// off the charger. Either would drag a percentile somewhere no morning digest
// should follow, and neither describes "when does last night normally land".
export const MAX_ARRIVAL_LAG_MIN = 240;

// ── MIDNIGHT WRAP: the stated position, not an accident ─────────────────────
//
// Clock times are circular and minute-of-day arithmetic is not. 00:14 and 23:50 are
// 24 minutes apart on a clock and 1416 apart on the number line, so a naive
// percentile over a sample straddling midnight describes a distribution that does
// not exist.
//
// THE DECISION: arrivals are ordered and interpolated as PLAIN minutes of day on
// [0, 1440), with no rotation and no circular mean — and the statistic REFUSES a
// sample that is not confined to a single contiguous half-day window. It does not
// try to be clever about a wrapped sample; it declines to describe one.
//
// That is sound here rather than merely convenient. Admission already requires a lag
// in [0, 240] behind an overnight session's END, so an admitted arrival is a morning
// arrival within four hours of a night ending — the shapes that would produce a
// 23:xx alongside an 00:xx (bulk imports, backfills, a device off the charger for a
// day) are exactly what the lag filter removes. A sample that spans more than half
// the clock in spite of that is not a daily rhythm, and no percentile over it would
// mean what its consumers read it to mean.
export const MAX_ARRIVAL_SPREAD_MIN = 12 * 60;

// The largest slot minute that has a retry band to defer INTO. `slotAttempt`
// deliberately does not wrap past midnight (minute 0 is the next calendar day,
// where the per-day marker is fresh), so a slot at/after 23:00 has no same-day
// retry band and declining there would drop the digest for the day rather than
// delay it. 22:59 is the last minute whose +60 retry is still same-day.
export const LAST_DEFERRABLE_MINUTE = 22 * 60 + 59;

/** One night's sleep row and the moment it actually landed. Gathered by
 * `getSleepArrivals` (lib/queries/metrics.ts); nothing here reads a DB or a clock. */
export interface ArrivalNight {
  /** The ARRIVAL's profile-local calendar date (YYYY-MM-DD). */
  date: string;
  /** The arrival's profile-local minute of day, 0..1439. */
  arrivalMinute: number;
  /** Minutes from the night's end instant to the arrival. The admission test only. */
  lagMin: number;
  /**
   * Whether `date` is a day on which the profile's zone changed UTC offset. Such a
   * day mixes two offsets into one clock-time sample, and with ~13 nights available
   * a single hour-shifted arrival moves the p90 materially — so it is dropped
   * (#2214 constraint 2). Roughly two nights a year, carrying no information about
   * the sync pipeline.
   */
  dstTransition: boolean;
}

/**
 * Why there is no statistic. Each value is a genuinely different situation and the
 * consumers may want to say different things about them — a profile that has never
 * synced sleep is not a profile whose every arrival was a bulk import.
 */
export type ArrivalUnavailableReason =
  /** No candidate nights at all: no syncing sleep source, or no provenance rows. */
  | "no-source"
  /** Candidates existed; none was a morning arrival (all backfills/imports/DST). */
  | "no-arrivals"
  /** Admitted, but fewer than MIN_ARRIVAL_SAMPLE. Never extrapolate from these. */
  | "thin-sample"
  /** Admitted arrivals span more than half the clock — see MAX_ARRIVAL_SPREAD_MIN. */
  | "dispersed";

/**
 * The arrival statistic. A DISCRIMINATED UNION rather than a nullable number, so
 * "there is no answer" is a first-class state a caller cannot mistake for a time:
 * neither minute exists unless `available` is true.
 */
export type ArrivalStatistics =
  | {
      available: true;
      /** Admitted nights the two minutes were computed from. */
      nights: number;
      /** ARRIVAL_PERCENTILE of the arrival clock times, profile-local minute of day. */
      p90Minute: number;
      /** ARRIVAL_TYPICAL_PERCENTILE of the same sample, profile-local minute of day. */
      medianMinute: number;
    }
  | {
      available: false;
      /** Admitted nights — 0, or the under-gate count. Visible so a caller can say
       * "3 of the 5 mornings needed" rather than only "not yet". */
      nights: number;
      reason: ArrivalUnavailableReason;
    };

/**
 * Linear-interpolated percentile of an ASCENDING sample, unrounded. Shared by every
 * percentile in this module so there is exactly one method: interpolation rather
 * than nearest-rank, so a small sample doesn't collapse onto its maximum. Requires a
 * non-empty sample (both callers gate on MIN_ARRIVAL_SAMPLE first).
 */
export function interpolatedPercentile(
  sortedAsc: readonly number[],
  p: number
): number {
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * The one arrival computation (#2214). Admits on the lag, measures on the clock,
 * and returns the p90 and the median of the same admitted sample — or a stated
 * reason there is no answer.
 */
export function arrivalStatistics(
  nights: readonly ArrivalNight[]
): ArrivalStatistics {
  if (nights.length === 0) {
    return { available: false, nights: 0, reason: "no-source" };
  }
  const admitted = nights
    .filter(
      (n) =>
        !n.dstTransition &&
        Number.isFinite(n.lagMin) &&
        n.lagMin >= 0 &&
        n.lagMin <= MAX_ARRIVAL_LAG_MIN &&
        Number.isFinite(n.arrivalMinute) &&
        n.arrivalMinute >= 0 &&
        n.arrivalMinute < 24 * 60
    )
    .map((n) => n.arrivalMinute)
    .sort((a, b) => a - b);

  if (admitted.length === 0) {
    return { available: false, nights: 0, reason: "no-arrivals" };
  }
  // The gate counts what SURVIVED admission, so a dropped DST day or a bulk import
  // is visible as a thinner sample rather than silently padding it (#2214 test 4).
  if (admitted.length < MIN_ARRIVAL_SAMPLE) {
    return { available: false, nights: admitted.length, reason: "thin-sample" };
  }
  if (admitted[admitted.length - 1] - admitted[0] > MAX_ARRIVAL_SPREAD_MIN) {
    return { available: false, nights: admitted.length, reason: "dispersed" };
  }
  return {
    available: true,
    nights: admitted.length,
    p90Minute: Math.round(interpolatedPercentile(admitted, ARRIVAL_PERCENTILE)),
    medianMinute: Math.round(
      interpolatedPercentile(admitted, ARRIVAL_TYPICAL_PERCENTILE)
    ),
  };
}

/**
 * The minute of day an `auto` morning digest should resolve to: the first minute
 * STRICTLY AFTER the arrival p90. Null when the statistic has no answer, which is
 * the caller's signal to fall back to today's wake-time behavior.
 *
 * At minute grain (#2121) the old round-up-to-the-next-whole-hour is gone with the
 * rounding problem it papered over. "Strictly after" (the +1) survives, so a digest
 * scheduled for the same minute the data typically lands is not a race it loses half
 * the time. Clamped inside the deferrable range so the auto digest always keeps its
 * retry band.
 *
 * This is the DIGEST's resolution and only the digest's. The `auto` Morning intake
 * time keeps the raw wake minute deliberately: it needs you awake, not your
 * tracker synced, so the wake time is the correct answer for it.
 */
export function digestAutoMinute(stats: ArrivalStatistics): number | null {
  if (!stats.available) return null;
  return Math.min(LAST_DEFERRABLE_MINUTE, stats.p90Minute + 1);
}

// ── 2. Deferring one hour when last night has not landed ─────────────────────

export interface DigestDeferInput {
  /** The digest's resolved slot minute of day, profile-local. */
  slotMinute: number;
  /** The profile-local minute of day this tick is running in. */
  currentMinute: number;
  /** The (observed, clamped) tick cadence, so the attempt bands match the tick's. */
  tickMinutes: number;
  /**
   * Whether the digest time is the resolved `auto` time rather than one the user
   * typed. Deferral is auto-only: a manually set time is user-owned timing, and
   * silently sliding someone's 07:00 to 08:00 makes their own setting untrue.
   */
  auto: boolean;
}

/**
 * Whether this tick should DECLINE to send the digest and let the retry attempt
 * send it instead. `sleepPending` is a thunk so the caller pays for the sleep read
 * only on the one tick per day where the answer can matter.
 *
 * The deferral is once and only once, by construction (#2121 re-derivation of the
 * #2102 rule — same structure, expressed over slotAttempt's bands):
 *   • it declines only on the "first" attempt band, so the retry band never defers;
 *   • `slotAttempt` offers no third band;
 *   • so the digest sends on the retry attempt — an hour after the slot, at every
 *     tick rate — whether or not sleep arrived.
 * The digest also carries activity, upcoming, biomarkers and more — one pending
 * section must never hold the rest hostage, and here it structurally cannot.
 */
export function shouldDeferDigest(
  input: DigestDeferInput,
  sleepPending: () => boolean
): boolean {
  if (!input.auto) return false;
  if (
    slotAttempt(input.slotMinute, input.currentMinute, input.tickMinutes) !==
    "first"
  ) {
    return false;
  }
  if (input.slotMinute > LAST_DEFERRABLE_MINUTE) return false;
  return sleepPending();
}
