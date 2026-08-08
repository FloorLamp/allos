// The morning digest's OWN scheduling decisions — pure, no DB, no clock, no network.
//
// TWO MODES, NO `auto` (#2211). The digest used to have three states — off, a typed
// `HH:MM`, and `auto` — and `auto` did two jobs at once: "pick my time for me" AND
// "make my digest complete". Those are different wishes, and welding them together
// produced the measured defect: a typed time NEVER waited (`shouldDeferDigest` opened
// with `if (!input.auto) return false`), so a configured 07:00 shipped without last
// night's sleep on 7 of 13 mornings and never said so; and when a time DID wait it
// waited an hour to answer a two-minute question, because #2102 borrowed the failure
// backoff band as its landing zone.
//
// What replaced it is the two real user groups, named by intent rather than by
// mechanism:
//
//   STATIC   — "same time every day".      Send at HH:MM. Complete or not.
//   DYNAMIC  — "as soon as it's ready".    Send when last night lands. Not before HH:MM.
//
// Both send exactly ONE digest per profile per day, hard-deduped by
// `notify_last_digest`. The modes change WHEN, never HOW OFTEN — no mode can increase
// contact — and neither is ever written by anything but a user's own tap.
//
// WHY THERE IS NO `auto`. Its job was "the user cannot compute the right time
// themselves", which is true — nobody knows their own p90 sync arrival. But a
// SUGGESTION does that job better, because it tells the user the number instead of
// silently being it, and this statistic is unfit to be a live binding: measured median
// wake drifted 05:34 → 05:53 over three weekly steps and leave-one-night-out moves the
// arrival p90 by up to 11 minutes. A time that wanders 10-20 minutes a month with no
// user action is the opposite of what Static promises. #2217 is the suggestion; the
// tap is the write. (`AUTO_TIME` stays alive for the Morning INTAKE slot, which
// resolves from wake time and depends on nothing having synced.)
//
// WHAT THIS MODULE IS NOT. It decides WHEN the digest sends. It never decides what
// the digest prints: #2099 owns that (a stale night is omitted rather than printed
// as last night's), and the two answers stay separate on purpose — a digest that
// reaches its deadline with no sleep in hand simply has no Sleep section, which is
// already correct behavior.

import {
  clampTickMinutes,
  slotAttempt,
  SLOT_RETRY_DELAY_MIN,
} from "./schedule";
import { formatClockMinutes, type TimeFormat } from "../format-date";

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

// The largest minute a Dynamic deadline may sit at. `slotAttempt` deliberately does
// not wrap past midnight (minute 0 is the next calendar day, where the per-day marker
// is fresh), so a minute at/after 23:00 has no same-day retry band and a deadline
// there would drop the digest for the day rather than delay it. 22:59 is the last
// minute whose +60 retry is still same-day.
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

// ── 2. The two modes ─────────────────────────────────────────────────────────

/**
 * How the morning digest decides its send time. Descriptive, not adjectival: the
 * tone contract is numbers not adjectives, and calling one of them "Smart" implies
 * the other is dumb.
 *
 *   static  — "Same time every day"     — send at the minute, complete or not.
 *   dynamic — "As soon as it's ready"   — send when last night lands, not before
 *                                         the minute, and by the deadline at the latest.
 *
 * OFF is not a mode. It is the absence of a time (`notify_digest_hour` = "" or
 * absent), exactly as it always was — the mode key carries the mode and nothing
 * else, so no third meaning is multiplexed onto either value (#2205).
 */
export type DigestMode = "static" | "dynamic";

export const DIGEST_MODES = ["static", "dynamic"] as const;

/**
 * The mode a profile has when nothing is stored. Static, so a digest configured
 * before modes existed keeps behaving EXACTLY as it did — the migration writes the
 * mode explicitly, and this is what makes a missed row harmless rather than a
 * silent behavior change.
 */
export const DEFAULT_DIGEST_MODE: DigestMode = "static";

/** Read the stored mode; anything unrecognised (absent, corrupt) is Static. */
export function parseDigestMode(raw: string | undefined): DigestMode {
  return raw === "dynamic" ? "dynamic" : DEFAULT_DIGEST_MODE;
}

/**
 * The minute the digest picker PRE-FILLS when the digest is switched on — the
 * Static send time, or the Dynamic floor. A pre-fill, not an `auto` binding: it
 * never moves on its own, and #2217 corrects it once there is evidence. Declared
 * once so the picker, onboarding and the migration cannot each pick their own
 * "default digest time".
 */
export const DIGEST_DEFAULT_MINUTE = 7 * 60;

/**
 * How long past the measured arrival p90 a Dynamic digest waits before sending
 * whatever it has. DECLARED AND AUDITABLE, in the style of MIN_ARRIVAL_SAMPLE and
 * ARRIVAL_PERCENTILE beside it — not a fitted parameter. It clears the observed
 * p90→max spread (9 minutes on the 13-night fixture) with headroom, while bounding
 * how late a digest can be on a day the data never arrives at all.
 */
export const DEADLINE_MARGIN_MIN = 30;

/**
 * The deadline when the arrival statistic has NO ANSWER — for any of its four
 * reasons. `floor + 60` is exactly today's retry band, so a profile whose sample
 * cannot carry a percentile behaves precisely as it does now. Never extrapolate
 * from a thin sample: an hour is the stated fallback, not a guess at the tail.
 */
export const DEADLINE_FALLBACK_MIN = 60;

/**
 * Attempts per profile per day, in EITHER mode. #2121 item 3's decision, unchanged:
 * a failing send is attempted exactly twice, an hour apart, invariant under the tick
 * rate — the budget an SMTP greylist can outlive (#1855) and a 429-ing push service
 * is not hammered by. Re-checks re-evaluate a CONDITION; they never re-attempt a
 * delivery, which is why the Dynamic re-check loop below is not an attempt loop.
 */
export const MAX_DIGEST_ATTEMPTS = 2;

/**
 * The Dynamic deadline: the profile-local minute at which the digest sends whether
 * or not last night arrived.
 *
 * `p90 + DEADLINE_MARGIN_MIN`, and:
 *   • floored at `floor + one tick`, so Dynamic never degenerates into "send at the
 *     floor" through a p90 that sits at or before the floor;
 *   • clamped by LAST_DEFERRABLE_MINUTE, which is where the same-day retry band ends;
 *   • never before the floor itself — a floor past LAST_DEFERRABLE_MINUTE has nothing
 *     to wait INTO, so its deadline collapses onto the floor and Dynamic behaves as
 *     Static for it. That is the honest degenerate answer, not a dropped digest.
 *
 * THE DEADLINE IS NOT `floor + SLOT_RETRY_DELAY_MIN`. That began as #2102 borrowing
 * the failure backoff as a landing zone; with no `auto` left, the floor has nothing
 * to secretly anchor and the deadline derives from the arrival distribution instead
 * (#2214). The two requirements are opposed: a BACKOFF wants to be long and
 * tick-rate-invariant, WAITING FOR AN ARRIVAL wants the next tick, whatever the tick is.
 */
export function digestDeadlineMinute(
  floorMinute: number,
  stats: ArrivalStatistics,
  tickMinutes: number
): number {
  const base = stats.available
    ? stats.p90Minute + DEADLINE_MARGIN_MIN
    : floorMinute + DEADLINE_FALLBACK_MIN;
  const notBefore = floorMinute + clampTickMinutes(tickMinutes);
  return Math.max(
    floorMinute,
    Math.min(LAST_DEFERRABLE_MINUTE, Math.max(base, notBefore))
  );
}

// ── The per-day attempt fact ─────────────────────────────────────────────────
//
// THE ONE GENUINELY NEW STATE IN THE DESIGN, and the thing #2102 deliberately did
// without. Its rule was "NO NEW STORED STATE, and in particular NO NEW SEND MARKER":
// "have I deferred today?" was answered by the clock, because the retry band sat at a
// FIXED offset from a FIXED slot and a decline therefore needed no trace.
//
// That stops being viable the moment the retry anchor moves. A Dynamic send fires at
// whatever tick the data landed on, so its retry band must anchor to the ATTEMPT
// INSTANT (`attempt + SLOT_RETRY_DELAY_MIN`) — anchoring to the floor instead is
// wrong and worth naming: a send that fails at 08:05 would have its retry band at
// `floor + 60`, already in the past, and would silently get no retry at all.
//
// ONE FACT ANSWERS BOTH QUESTIONS. The tick must know WHEN the failed attempt
// happened, which is the same per-day record that distinguishes a DECLINE from a
// FAILURE — and the distinction falls out of the record's PRESENCE rather than
// needing a third value: a decline writes nothing (the condition is simply re-asked
// next tick), a failure writes this. Delivery is still `notify_last_digest`, so the
// three outcomes are: marker set = delivered, attempt row = attempted-and-failed,
// neither = declined or not yet due.

/** Today's failed-attempt record for one profile's digest. */
export interface DigestAttempt {
  /** The profile-local date it belongs to. A record for another date is stale. */
  date: string;
  /** How many attempts have been made today, capped by MAX_DIGEST_ATTEMPTS. */
  attempts: number;
  /** The profile-local minute of day of the most recent attempt — the retry anchor. */
  minute: number;
}

/** `date|attempts|minute`, the value stored under DIGEST_ATTEMPT_KEY. */
export function formatDigestAttempt(a: DigestAttempt): string {
  return `${a.date}|${a.attempts}|${a.minute}`;
}

/**
 * Today's attempt record, or null when there is none — absent, corrupt, or belonging
 * to another day. A stale record reads as "no attempt yet today", which re-arms the
 * digest with the day rather than freezing it: the same per-day re-arm every other
 * marker in SEND_MARKER_REGISTRY has.
 */
export function parseDigestAttempt(
  raw: string | undefined,
  date: string
): DigestAttempt | null {
  if (!raw) return null;
  const [d, a, m] = raw.split("|");
  if (d !== date) return null;
  const attempts = Number(a);
  const minute = Number(m);
  if (!Number.isInteger(attempts) || attempts < 1) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute >= 24 * 60) return null;
  return { date, attempts, minute };
}

/** The record after one more attempt at `minute`. */
export function nextDigestAttempt(
  prev: DigestAttempt | null,
  date: string,
  minute: number
): DigestAttempt {
  return { date, attempts: (prev?.attempts ?? 0) + 1, minute };
}

// ── The tick decision ────────────────────────────────────────────────────────

/**
 * What this tick should do about the digest.
 *   send — build and dispatch it now.
 *   wait — DECLINE: last night is outstanding but expected, and the deadline has not
 *          arrived. Writes nothing; the next tick asks again.
 *   idle — not this tick's business at all.
 */
export type DigestTickAction = "send" | "wait" | "idle";

export interface DigestTickInput {
  mode: DigestMode;
  /** Static: the send time. Dynamic: the floor. Profile-local minute of day. */
  slotMinute: number;
  /** The profile-local minute of day this tick is running in. */
  currentMinute: number;
  /** The (observed, clamped) tick cadence, so attempt bands match the tick's. */
  tickMinutes: number;
  /**
   * Dynamic only: `digestDeadlineMinute` for this profile. A THUNK, exactly like
   * `sleepPending` below and for the same reason (#2249): resolving it costs a
   * 30-night arrival gather, and most Dynamic ticks decline before the deadline can
   * matter — every Static tick, every tick before the floor, and every tick under a
   * failed-attempt record. Static never calls it at all.
   */
  deadlineMinute: () => number;
  /** Today's failed-attempt record, or null. Only Dynamic ever writes one. */
  attempt: DigestAttempt | null;
}

/**
 * The digest's whole scheduling decision, for both modes.
 *
 * STATIC is today's behavior, to the minute, and MUST STAY SO — it is the regression
 * that must never land. Two slot-anchored attempt bands from `slotAttempt`, send on
 * either, sleep pending or not. It never waits, never reads `sleepPending`, and never
 * writes an attempt record, so its retry stays exactly the slot-anchored pair #2121
 * designed.
 *
 * DYNAMIC re-checks. From the floor onward it asks each tick whether last night has
 * landed, sends the moment it has, and sends unconditionally at the deadline — one
 * pending section never holds activity, upcoming and biomarkers hostage. Once a send
 * has FAILED, the record short-circuits everything: the only remaining opportunity is
 * the single attempt-anchored retry band, so the two-attempts-a-day budget holds at
 * every tick rate however many re-check ticks ran.
 *
 * With the Sleep section off, `sleepPending` is already false, so Dynamic collapses to
 * "send at the floor". That is correct — there is nothing to wait for — and
 * `describeDigestSchedule` states it rather than leaving it to be discovered.
 *
 * `sleepPending` — and, since #2249, `deadlineMinute` — are THUNKS so the caller pays
 * for each read only on the ticks where its answer can matter (constraint 5: those
 * reads ride the tick's memoization).
 */
export function planDigestTick(
  input: DigestTickInput,
  sleepPending: () => boolean
): DigestTickAction {
  const tick = clampTickMinutes(input.tickMinutes);

  if (input.mode === "static") {
    return slotAttempt(input.slotMinute, input.currentMinute, tick) !== null
      ? "send"
      : "idle";
  }

  // Before the floor — including every next-day tick, whose offset is negative.
  // Midnight does not wrap here for the same reason it does not wrap in
  // `slotAttempt`: hour 0 is the next calendar day, where the per-day marker is fresh.
  if (input.currentMinute < input.slotMinute) return "idle";

  if (input.attempt) {
    if (input.attempt.attempts >= MAX_DIGEST_ATTEMPTS) return "idle";
    const offset = input.currentMinute - input.attempt.minute;
    return offset >= SLOT_RETRY_DELAY_MIN &&
      offset < SLOT_RETRY_DELAY_MIN + tick
      ? "send"
      : "idle";
  }

  // At or past the deadline the digest sends unconditionally, in the SAME two
  // slot-anchored bands Static gets — which is what bounds the work: a digest with no
  // channel configured (dispatch returns nothing, nothing is marked) costs two builds
  // for the day rather than one per tick until midnight.
  // The first point at which the deadline can change the answer — every short-circuit
  // above it returns without paying for the arrival gather behind it (#2249).
  const deadlineMinute = input.deadlineMinute();
  if (input.currentMinute >= deadlineMinute) {
    return slotAttempt(deadlineMinute, input.currentMinute, tick) !== null
      ? "send"
      : "idle";
  }

  // The re-check window. This is the whole point: three ticks run between a 07:26
  // arrival and the old 08:15 retry band, each able to answer "has it landed?" for one
  // already-memoized read.
  return sleepPending() ? "wait" : "send";
}

// ── What the user is told ────────────────────────────────────────────────────

/**
 * The digest's schedule in words. ONE computation (#221): Settings renders this, and
 * anything else that has to explain the same schedule formats this same result — a
 * mode and a surface must never describe the send time two different ways.
 */
export interface DigestScheduleSummary {
  /** The schedule itself, naming every time it depends on. */
  headline: string;
  /** Where the deadline came from, or null when there is no deadline to explain. */
  detail: string | null;
}

/**
 * Say what this profile's digest will actually do.
 *
 * THE FOUR UNAVAILABLE REASONS ARE FOUR DIFFERENT THINGS and are answered as such.
 * Flattening them into one "not enough data yet" would be a lie to at least one
 * person: `thin-sample` genuinely resolves by waiting, `no-source` and `no-arrivals`
 * resolve by a change in what syncs, and `dispersed` — an arrival sample spanning more
 * than half the clock, which is what a shift worker's genuine rhythm looks like —
 * does NOT resolve by waiting at all. Promising that person a sample that will never
 * qualify is exactly the editorialising constraint 4 forbids.
 */
export function describeDigestSchedule(input: {
  mode: DigestMode;
  /** Static: the send time. Dynamic: the floor. */
  floorMinute: number;
  /** Whether the digest's Sleep section is on — the only thing Dynamic waits for. */
  sleepSectionEnabled: boolean;
  stats: ArrivalStatistics;
  tickMinutes: number;
  /**
   * The reader's clock convention (#964/#1163), for DISPLAY only. Defaults to 24h —
   * the documented fixed format for a surface with no login in context. Every stored
   * value, form field and wire token still serializes through `formatNotifyTime`.
   */
  timeFormat?: TimeFormat;
}): DigestScheduleSummary {
  const clock = (minute: number) =>
    formatClockMinutes(input.timeFormat ?? "24h", minute);
  const at = clock(input.floorMinute);

  if (input.mode === "static") {
    // With the Sleep section off, "whether or not last night's sleep has arrived by
    // then" is noise: this digest carries no sleep, so there is no arrival for the
    // send time to beat (#2255 §3). Parallel to the Dynamic branch's own sleep-off
    // variant below — the same fact, stated where it changes what the mode does.
    return {
      headline: input.sleepSectionEnabled
        ? `Sends at ${at} every day, whether or not last night’s sleep has arrived by then.`
        : `Sends at ${at} every day.`,
      detail: null,
    };
  }

  if (!input.sleepSectionEnabled) {
    return {
      headline: `Sends at ${at}. Last night’s sleep summary is off, so there is nothing to wait for.`,
      detail: null,
    };
  }

  const deadline = clock(
    digestDeadlineMinute(input.floorMinute, input.stats, input.tickMinutes)
  );
  const headline = `Sends as soon as last night’s sleep lands — never before ${at}, and by ${deadline} at the latest.`;

  if (input.stats.available) {
    return {
      headline,
      detail: `Your sleep has arrived by ${clock(input.stats.p90Minute)} on 9 of every 10 of the last ${input.stats.nights} measured mornings; the latest send adds ${DEADLINE_MARGIN_MIN} minutes to that.`,
    };
  }

  const detail = ((): string => {
    switch (input.stats.reason) {
      case "no-source":
        return "Nothing is syncing sleep yet, so there is no arrival time to measure — until something does, the latest send stays an hour after your earliest time.";
      case "no-arrivals":
        return "Your sleep rows land as backfills and bulk imports rather than each morning, so there is no arrival time to measure — the latest send stays an hour after your earliest time.";
      case "thin-sample":
        return `${input.stats.nights} of the ${MIN_ARRIVAL_SAMPLE} mornings needed have been measured so far; until there are ${MIN_ARRIVAL_SAMPLE}, the latest send stays an hour after your earliest time.`;
      case "dispersed":
        return "Your sleep lands across more than half the clock, so there is no typical arrival time to measure and waiting longer will not produce one — the latest send stays an hour after your earliest time.";
    }
  })();

  return { headline, detail };
}
