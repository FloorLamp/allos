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
import { FRAGMENT_MERGE_GAP_MAX_MIN } from "./sleep-regularity";

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
  /** That window's start instant — the "four hours earlier" the copy can name. */
  troughStart: string;
  /**
   * The awake-level run inside the claim, when the RUN reading below is what caught
   * this night and the median reading did not. Null on a median finding.
   *
   * The copy has to branch on it: a median finding can say "an equally long window
   * earlier the same day held the overnight low", and on a run finding no such window
   * exists — that absence is the whole reason the median reading missed it.
   *
   * `start` names the run on the same quarter-hour grid the search steps on, so it can
   * sit up to one block before the first fully awake minute. It is a grain, not a
   * clock time to quote to the minute.
   */
  awakeRun: { bpm: number; start: string } | null;
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

// ── THE SECOND READING: an awake-level run inside the claim ──────────────────
// The median test asks whether the BULK of the claimed window reads awake. It cannot
// see a shift SHORTER than the night is long: the real trough then overlaps the claim,
// the overlap exclusion in the search below drops the one comparable window that would
// expose it, and every window left is awake time. That is the 08-27 night in #5020 —
// stamped three hours late, claimed median 61 against a best non-overlapping window of
// 68, so the gap is negative and the night stands as fact.
//
// So ask a second question of the same trace: does the claim CONTAIN a stretch too long
// for any one night to hold it awake, at the level this person's own day runs at? The
// length is not a new number. FRAGMENT_MERGE_GAP_MAX_MIN is the repo's one declared
// bound on the longest awake gap still inside a single night (lib/sleep-regularity.ts),
// so a run at least that long, at awake level, inside a window claimed as sleep is a
// contradiction by a number this codebase already stands behind.
export const AWAKE_RUN_MINUTES = FRAGMENT_MERGE_GAP_MAX_MIN;

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
function bpmIn(
  samples: readonly { at: number; bpm: number }[],
  from: number,
  to: number
): number[] {
  const inside: number[] = [];
  for (const s of samples) {
    if (s.at >= from && s.at < to) inside.push(s.bpm);
  }
  return inside;
}

// Whether a window carries enough samples to speak at all, measured against its OWN
// width in minutes.
function covered(sampleCount: number, from: number, to: number): boolean {
  const expectedMinutes = Math.round((to - from) / MINUTE_MS);
  return (
    expectedMinutes > 0 && sampleCount / expectedMinutes >= MIN_HR_COVERAGE
  );
}

function windowStats(
  samples: readonly { at: number; bpm: number }[],
  from: number,
  to: number
): { median: number; mean: number } | null {
  const inside = bpmIn(samples, from, to);
  if (!covered(inside.length, from, to)) return null;
  return {
    median: median(inside),
    mean: inside.reduce((a, b) => a + b, 0) / inside.length,
  };
}

// The longest contiguous awake-level run inside [start, end), when that run reaches
// AWAKE_RUN_MINUTES and stands clear of the claim's own bulk. Null otherwise.
//
// A run is measured on the same quarter-hour grid the trough search steps on, and a
// block counts as awake when the block's OWN median comes within MIN_MEDIAN_BPM_GAP of
// the day's awake level. Judging blocks rather than single minutes is what makes "a
// run" mean anything on a real trace: one noisy minute cannot break a three-hour
// afternoon in half, and a noisy quarter-hour cannot make a run out of a quiet night.
// Judging one 120-minute window by ITS median would not be a run at all — half its
// minutes could be asleep, so a 105-minute awake block would read as one.
//
// BOTH halves are required, and the conjunction is what makes the reading safe:
//   - every block of the run comes within MIN_MEDIAN_BPM_GAP of the day's awake level,
//   - and the claim as a whole sits at least MIN_MEDIAN_BPM_GAP below the run.
// The first alone would re-judge a night the median reading deliberately declined: a
// claim sitting at awake level whose best trough is 9 bpm away is ordinary variation,
// and stays so. The second alone would key on the difference between deep sleep and
// morning REM inside one ordinary night, which nothing in this repo has measured — the
// same objection MIN_MEDIAN_BPM_GAP's own comment raises. Together they describe one
// shape: part of the claim is the trough and part of it is daytime.
//
// Known reach: a real night stamped as ONE session across a full two-hour arousal reads
// the same way and carries the same hedge. That is the cost of the bound the repo
// declares — and `mainSleepPeriod` already treats a gap that long as two nights, so a
// source that stamps one session across it is itself unusual.
function awakeRunInside(
  samples: readonly { at: number; bpm: number }[],
  start: number,
  end: number,
  awakeMedian: number,
  claimedMedian: number
): { median: number; at: number } | null {
  const floor = awakeMedian - MIN_MEDIAN_BPM_GAP;
  const needed = AWAKE_RUN_MINUTES * MINUTE_MS;
  let run: { at: number; to: number; bpm: number[] } | null = null;
  let longest: { at: number; to: number; bpm: number[] } | null = null;
  for (let from = start; from + SEARCH_STEP_MS <= end; from += SEARCH_STEP_MS) {
    const to = from + SEARCH_STEP_MS;
    const block = bpmIn(samples, from, to);
    if (!covered(block.length, from, to) || median(block) < floor) {
      run = null;
      continue;
    }
    run =
      run == null
        ? { at: from, to, bpm: block }
        : { at: run.at, to, bpm: [...run.bpm, ...block] };
    if (
      run.to - run.at >= needed &&
      (longest == null || run.to - run.at > longest.to - longest.at)
    ) {
      longest = run;
    }
  }
  if (longest == null) return null;
  // Every block held at least half its samples at awake level, so the run's own median
  // is awake level too. The only thing left to ask is whether the claim as a whole
  // stands clear below it.
  const runMedian = median(longest.bpm);
  if (runMedian - claimedMedian < MIN_MEDIAN_BPM_GAP) return null;
  return { median: runMedian, at: longest.at };
}

/**
 * Does this session's claimed window disagree with the heart rate recorded across it?
 *
 * Two readings of the one signal. The evidence comes back when the BULK of the claim
 * stands above a comparable trough elsewhere in the day, or when the claim HOLDS an
 * awake-level run too long for one night — and null in every other case, including the
 * two that matter most: no concurrent coverage, and a genuinely shifted night whose HR
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
  //
  // The same scan carries the day's AWAKE level — the highest median among those same
  // comparable windows. It costs nothing extra, it is comparable by the same
  // construction, and the run reading below needs an awake anchor rather than a trough
  // one: it asks whether a stretch inside the claim reaches the level this person's day
  // runs at, and the day is what these windows measure. The two are tracked together
  // because a run finding still quotes the trough, and a day that has one has both.
  const width = end - start;
  let comparable: {
    low: { median: number; mean: number; at: number };
    awakeMedian: number;
  } | null = null;
  for (
    let from = start - SEARCH_RADIUS_MS;
    from <= start + SEARCH_RADIUS_MS;
    from += SEARCH_STEP_MS
  ) {
    if (from < end && from + width > start) continue; // overlaps the claim
    const stats = windowStats(samples, from, from + width);
    if (stats == null) continue;
    if (comparable == null) {
      comparable = { low: { ...stats, at: from }, awakeMedian: stats.median };
      continue;
    }
    if (
      stats.median < comparable.low.median ||
      (stats.median === comparable.low.median &&
        stats.mean < comparable.low.mean)
    ) {
      comparable.low = { ...stats, at: from };
    }
    if (stats.median > comparable.awakeMedian) {
      comparable.awakeMedian = stats.median;
    }
  }
  if (comparable == null) return null;

  const evidence = {
    start: session.start,
    end: session.end,
    claimedBpm: claimed.median,
    troughBpm: comparable.low.median,
    troughStart: utcInstant(new Date(comparable.low.at)),
  };

  // Reading one: the bulk of the claim sits above a comparable trough.
  if (claimed.median - comparable.low.median >= MIN_MEDIAN_BPM_GAP) {
    return { ...evidence, awakeRun: null };
  }

  // Reading two: the claim holds an awake-level run no single night could hold awake.
  const run = awakeRunInside(
    samples,
    start,
    end,
    comparable.awakeMedian,
    claimed.median
  );
  if (run == null) return null;
  return {
    ...evidence,
    awakeRun: { bpm: run.median, start: utcInstant(new Date(run.at)) },
  };
}
