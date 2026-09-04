// Source-side sleep CLOCK SKEW (issue #4299) — the contradiction the DB already holds.
//
// An exporter can write sleep sessions whose UTC instants are simply wrong: the
// observed case is Fitbit's Health Connect writes landing +6h off (the Honolulu→
// New_York offset) for every night after a return east, so Allos rendered "Bed time
// 5:39 AM · Wake time 10:37 AM" as fact and lifted the short night into ATTENTION.
// The durations were right; only the instants were fabricated.
//
// This is NOT #3524. There the reading's instant is right and Allos's day-keying moved
// under it, so a re-key fixes it. Here the SOURCE's instant is wrong, and no Allos-side
// re-keying can reach it.
//
// ── WHY HEART RATE IS THE WHOLE SIGNAL ───────────────────────────────────────
// The tempting signal is the schedule break: every pre-trip night started ~9:30–11 PM
// local and the post-return nights jump to "5:30 AM bedtimes". That signal is WRONG to
// key on, and deliberately so — a real jet-lag week produces exactly the same
// discontinuity, and a detector built on it turns every genuinely shifted night into a
// false alarm. So nothing in this module reads a bedtime history, a timezone switch, or
// a day-of-week.
//
// What it reads is `hr_minutes` from the same database: a body asleep runs at its
// overnight trough. If the claimed session sits at awake-level HR while a COMPARABLE
// window elsewhere in the surrounding day holds the trough, the session's instants
// disagree with the body. On a true jet-lag night the session IS the trough, no lower
// comparable window exists, and this returns null — which is the discriminator working,
// not a gap in it.
//
// Proximity to a `timezone_switches` entry may strengthen a finding's WORDING. It is
// not a parameter of this function, so it cannot fire on its own by construction.
//
// Pure — no DB, no clock. The gather is lib/queries/sleep-clock-skew.ts.

import { utcInstant } from "./date";

// The dedupeKey namespace this evidence rides on when it becomes a coaching-tier
// finding (#448's registry, #449's reach policy). ONE finding per EPISODE, anchored to
// the OLDEST suspect night still in the window: a source whose clock has gone stale
// mis-stamps every night until it heals, and a per-night key would mint a fresh row
// each morning after a dismiss.
export const SLEEP_SKEW_PREFIX = "sleep-clock-skew:";

export function sleepClockSkewSignalKey(firstWakeDay: string): string {
  return `${SLEEP_SKEW_PREFIX}${firstWakeDay}`;
}

// The one sentence a surface prints beneath a suspect session's times INSTEAD of
// letting them stand as fact. It names the disagreement and stops there — it never
// says how far off the clock is, because nothing here measures that (#4299's
// out-of-scope ruling).
export const SLEEP_SKEW_HEDGE =
  "These times disagree with your heart rate — the source clock may be off.";

// The second line, beneath the hedge: WHEN the body settled, as information (#5021's
// owner ruling, 2026-09-04).
//
// It is deliberately not a bedtime and does not read like one. `troughStart` is where
// the heart rate reached its lowest comparable window, which is sleep ONSET — a person
// who lay awake first did not go to bed then, and "your bedtime was 03:00" would be a
// claim this module has no way to make. Saying what was measured, and leaving the
// inference to the person, is the same discipline as the hedge above it: #4299 ruled
// that a silent 6-hour rewrite is a bigger lie than the one it fixes, and a
// confidently-worded wrong bedtime is that lie in one sentence.
//
// Takes the clock already formatted, because the zone in force at that instant and the
// login's 12h/24h preference are both the surface's to resolve — this module is pure.
export function sleepSkewSettledLine(clock: string): string {
  return `Your heart rate settled around ${clock}.`;
}

// One per-minute HR bucket as stored: `ts` is a canonical UTC instant (hr_minutes.ts
// has been an absolute instant since migration 164 — docs/internals/time-columns.md),
// `bpm` the count-weighted average.
export interface HrMinuteSample {
  ts: string;
  bpm: number;
}

// A sleep session's stored window, as the source stamped it.
export interface SkewCandidateSession {
  start: string;
  end: string;
}

// The evidence, in the units the finding quotes. Every field is a measurement, never a
// verdict about how far the clock is off: this module says "these instants disagree
// with your heart rate", never "they are 6 hours late" (#4299's out-of-scope ruling —
// a silent shift is a bigger lie than the one it fixes).
export interface SleepClockSkew {
  /** The session's stored start instant — the identity every surface keys on. */
  start: string;
  end: string;
  /** Median bpm over the minutes the session CLAIMS to cover. */
  claimedBpm: number;
  /** Median bpm over the best comparable window elsewhere in the surrounding day. */
  troughBpm: number;
  /**
   * Where the body actually settled: the start of the lowest-median window of the
   * session's own width anywhere in the surrounding day, overlap with the claim
   * ALLOWED (#5021).
   *
   * Not the same window as `troughBpm`, and deliberately so. `troughBpm` is the
   * comparison the verdict rests on and excludes anything overlapping the claim; this
   * is the instant a sentence may quote, and excluding the overlap would displace it
   * whenever the clock error is shorter than the session — by three hours on a measured
   * 420-minute night.
   *
   * It is INFORMATION, never a bedtime: "your heart rate settled around 03:00" is true
   * of sleep onset, and a person who lay awake first did not go to bed then (#5021's
   * owner ruling, 2026-09-04).
   */
  troughStart: string;
}

const MINUTE_MS = 60_000;

// How much of the claimed window (and of any comparison window) must carry an HR
// sample before either is allowed to speak. Below this the answer is "no concurrent
// coverage", which is a NON-detection: a session with a sparse or absent trace can
// never flag, however odd its clocks look (#4299 acceptance criterion 2).
export const MIN_HR_COVERAGE = 0.5;

// The median gap, in bpm, at which a claimed window reads as awake-level against a
// comparable trough elsewhere. The ONE measurement behind it is the sighting in #4299:
// the contradicted session ran up to 75 bpm while the real overnight trough four hours
// earlier ran 57–62, so the observed gap was 13–18. 10 sits below that on purpose —
// this feeds a calm observation and a delete affordance, never an alarm, so the cost of
// the threshold being a little low is a hedge nobody needed, not a missed contradiction.
// It is NOT derived from any measurement of ordinary within-night variation; nothing in
// this repo measures that, and a number invented for it would read as though something
// had.
//
// The MEDIAN is the "bulk of the session" test, not a separate one — a median 10 bpm
// above the trough's median means at least half the claimed minutes are that high.
export const MIN_MEDIAN_BPM_GAP = 10;

// How far either side of the claimed session's START to look for the real trough. This
// is a bound on "the surrounding day", NOT a claim to cover every possible offset error
// — zone offsets run −12:00 to +14:00, so a stale reference can in principle be further
// out than this. The observed skew is 6h, a window wider than a day would start
// comparing one night against another, and a trough more than 12h from the claim is not
// evidence about THIS night.
const SEARCH_RADIUS_MS = 12 * 60 * MINUTE_MS;

// Step the comparison window by a quarter hour. Finer buys nothing — a trough is hours
// wide — and the window itself is session-width, so the comparison stays apples to
// apples whatever the session's length.
const SEARCH_STEP_MS = 15 * MINUTE_MS;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The median and mean bpm over [from, to), or null when the window's coverage is too
// thin to carry a claim. Coverage is measured against the window's OWN width in
// minutes, so a five-hour night is judged against what a complete five-hour trace would
// hold rather than against a constant.
//
// The MEAN is carried only to break ties between windows of equal median (see the
// search below); nothing compares it across windows of different medians.
function windowStats(
  samples: readonly { at: number; bpm: number }[],
  from: number,
  to: number
): { median: number; mean: number } | null {
  const inside: number[] = [];
  for (const s of samples) {
    if (s.at >= from && s.at < to) inside.push(s.bpm);
  }
  const expectedMinutes = Math.round((to - from) / MINUTE_MS);
  if (expectedMinutes <= 0) return null;
  if (inside.length / expectedMinutes < MIN_HR_COVERAGE) return null;
  return {
    median: median(inside),
    mean: inside.reduce((a, b) => a + b, 0) / inside.length,
  };
}

/**
 * Does this session's claimed window disagree with the heart rate recorded across it?
 *
 * Returns the evidence when a comparable, non-overlapping window in the surrounding day
 * holds a materially lower median — and null in every other case, including the two
 * that matter most: no concurrent coverage, and a genuinely shifted night whose HR
 * agrees with its clocks.
 */
export function detectSleepClockSkew(
  session: SkewCandidateSession,
  hr: readonly HrMinuteSample[]
): SleepClockSkew | null {
  const start = Date.parse(session.start);
  const end = Date.parse(session.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const samples: { at: number; bpm: number }[] = [];
  for (const s of hr) {
    const at = Date.parse(s.ts);
    if (Number.isFinite(at) && Number.isFinite(s.bpm))
      samples.push({ at, bpm: s.bpm });
  }
  if (samples.length === 0) return null;

  const claimed = windowStats(samples, start, end);
  if (claimed == null) return null;

  // Every equal-width window in the surrounding day that does NOT overlap the claim.
  // Equal width is what makes "comparable" true by construction: a five-hour night is
  // compared against five-hour windows, never against a ten-minute dip.
  //
  // Ranked by median, ties broken by the lower MEAN. The tie-break is not cosmetic: at
  // a quarter-hour step many overlapping windows share the trough's median — a window
  // straddling the trough's leading edge has the same median as the trough itself once
  // half its minutes are asleep — and without the tie-break the earliest of them wins,
  // so `troughStart` would name an hour up to half a session-width before the real
  // onset. The copy quotes this instant, so naming the wrong hour is a wrong statement,
  // not a rounding.
  const width = end - start;
  let best: { median: number; mean: number; at: number } | null = null;
  for (
    let from = start - SEARCH_RADIUS_MS;
    from <= start + SEARCH_RADIUS_MS;
    from += SEARCH_STEP_MS
  ) {
    if (from < end && from + width > start) continue; // overlaps the claim
    const stats = windowStats(samples, from, from + width);
    if (stats == null) continue;
    if (
      best == null ||
      stats.median < best.median ||
      (stats.median === best.median && stats.mean < best.mean)
    ) {
      best = { ...stats, at: from };
    }
  }
  if (best == null || claimed.median - best.median < MIN_MEDIAN_BPM_GAP) {
    return null;
  }

  // ── WHAT THE COPY MAY NAME, once the finding exists (#5021) ──────────────
  //
  // The comparison above excludes every window overlapping the claim, which is right
  // for the DECISION — an overlapping window is partly the claim, so ranking against it
  // would compare a thing with itself. It is wrong for the REPORT. When the clock error
  // is shorter than the session, the real trough overlaps the claim and is excluded, so
  // `best.at` is the lowest window that does not touch it — necessarily displaced away
  // from the onset. Measured on a 420-minute night with a 240-minute shift, that landed
  // **three hours** before the real onset, 43% of a session width; on a shift LONGER
  // than the night it is exact, because then the trough does not overlap at all.
  //
  // So the reported instant is re-derived over the same radius with overlap allowed.
  // Nothing about the verdict moves: `best` above still decides, with the same rule and
  // the same threshold, and this only chooses which instant the sentence quotes.
  //
  // PAID ONLY BY A NIGHT THAT ALREADY FLAGGED. The excluded windows are skipped before
  // `windowStats` today, so scanning them costs `median` calls — the cost #5035
  // measures. Running the second pass after the verdict means suspect nights pay it and
  // the rest do not.
  let settled = best;
  for (
    let from = start - SEARCH_RADIUS_MS;
    from <= start + SEARCH_RADIUS_MS;
    from += SEARCH_STEP_MS
  ) {
    const stats = windowStats(samples, from, from + width);
    if (stats == null) continue;
    if (
      stats.median < settled.median ||
      (stats.median === settled.median && stats.mean < settled.mean)
    ) {
      settled = { ...stats, at: from };
    }
  }

  return {
    start: session.start,
    end: session.end,
    claimedBpm: claimed.median,
    troughBpm: best.median,
    troughStart: utcInstant(new Date(settled.at)),
  };
}
