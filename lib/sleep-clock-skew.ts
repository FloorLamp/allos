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

// SORTED WITHOUT A COMPARATOR (#5035). `[...values].sort((a, b) => a - b)` calls a JS
// closure at every comparison, and this median runs once per quarter-hour window across
// a whole day — the profile in #5035 put roughly half the detector's self time in that
// comparator alone, and removing it is worth more than any change to the algorithm
// around it.
//
// `Float64Array#sort` sorts numerically ascending with no comparator, which is the same
// order `(a, b) => a - b` produces for every value that can reach here: `bpm` is checked
// with `Number.isFinite` at intake, so there is no NaN to sort differently and no
// `undefined` to sort last. The values themselves are unchanged, so the even-count
// average of the two middle elements is the same double it always was.
function median(values: number[]): number {
  const sorted = Float64Array.from(values).sort();
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
// THE TRACE, PLUS THE ONE FACT THAT LETS A WINDOW BE SLICED RATHER THAN SCANNED.
//
// Every window read below asks for the samples inside a half-open span. On a trace whose
// instants are non-decreasing those samples are a CONTIGUOUS RANGE, so the read is a
// binary search and a walk instead of a pass over the whole day — and this detector asks
// ~97 times for the trough search alone, plus once per quarter-hour inside the claim.
//
// WHY THE FLAG RATHER THAN JUST SORTING (#5035). Sorting would be safe for the median,
// which sorts a copy anyway. It is NOT safe for the MEAN: floating-point addition is not
// associative, so summing the same values in a different order can differ in the last
// bit — and that mean is the tie-break between windows of equal median, whose winner's
// instant the copy quotes. A reorder could move `troughStart` by a quarter-hour, which
// is a wrong statement rather than a rounding. So nothing is ever reordered: an ordered
// trace takes the slice, and anything else takes the original scan, verbatim.
//
// The production caller reads `ORDER BY ts` (lib/queries/sleep-clock-skew.ts), so the
// fast path is the one that runs. The flag exists because this function is exported and
// "the caller happens to sort" is not a property of the function.
interface SkewTrace {
  readonly samples: readonly { at: number; bpm: number }[];
  readonly ordered: boolean;
}

function traceOf(samples: readonly { at: number; bpm: number }[]): SkewTrace {
  let ordered = true;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].at < samples[i - 1].at) {
      ordered = false;
      break;
    }
  }
  return { samples, ordered };
}

/** The index of the first sample at or after `from`, on an ordered trace. */
function firstAtOrAfter(
  samples: readonly { at: number; bpm: number }[],
  from: number
): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].at < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bpmIn(trace: SkewTrace, from: number, to: number): number[] {
  const { samples } = trace;
  const inside: number[] = [];
  if (trace.ordered) {
    // Index order on an ordered trace IS scan order, so the values arrive in the same
    // sequence the scan below would have produced them — which is what keeps the mean's
    // summation identical.
    for (let i = firstAtOrAfter(samples, from); i < samples.length; i++) {
      if (samples[i].at >= to) break;
      inside.push(samples[i].bpm);
    }
    return inside;
  }
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
  trace: SkewTrace,
  from: number,
  to: number
): { median: number; mean: number } | null {
  const inside = bpmIn(trace, from, to);
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
// AND THE RUN MUST TOUCH AN EDGE of the claim — its first or last quarter-hour (owner
// ruling, 2026-09-04 13:05 UTC). A clock error MOVES A BOUNDARY, so the awake stretch a
// shift produces is always against one end of the claimed window; every shifted night
// still flags. What the condition removes is the one shape this reading reached and
// should not have: a real night stamped as ONE session across a two-hour wake in the
// MIDDLE, which is a person who was awake at 3 a.m. and not a source with a wrong
// clock. It no longer receives the hedge or the doors.
function awakeRunInside(
  trace: SkewTrace,
  start: number,
  end: number,
  awakeMedian: number,
  claimedMedian: number
): { median: number; at: number } | null {
  const floor = awakeMedian - MIN_MEDIAN_BPM_GAP;
  const needed = AWAKE_RUN_MINUTES * MINUTE_MS;
  // Where the last whole block ends. A claim is rarely a whole number of quarter-hours,
  // so the trailing edge is this rather than `end` — a run judged against `end` could
  // never touch it.
  const lastBlockTo =
    start + Math.floor((end - start) / SEARCH_STEP_MS) * SEARCH_STEP_MS;
  let run: { at: number; to: number; bpm: number[] } | null = null;
  let longest: { at: number; to: number; bpm: number[] } | null = null;
  for (let from = start; from + SEARCH_STEP_MS <= end; from += SEARCH_STEP_MS) {
    const to = from + SEARCH_STEP_MS;
    const block = bpmIn(trace, from, to);
    if (!covered(block.length, from, to) || median(block) < floor) {
      run = null;
      continue;
    }
    run =
      run == null
        ? { at: from, to, bpm: block }
        : { at: run.at, to, bpm: [...run.bpm, ...block] };
    // The edge test is applied HERE and not to the winner, because a night can hold a
    // longer run in the middle and a shorter one against an edge: judging the longest
    // and then rejecting it would drop the qualifying run the ruling keeps.
    if (
      run.to - run.at >= needed &&
      (run.at === start || run.to === lastBlockTo) &&
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
  const trace = traceOf(samples);

  const claimed = windowStats(trace, start, end);
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
    const stats = windowStats(trace, from, from + width);
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

  // Reading one: the bulk of the claim sits above a comparable trough.
  const bulkReadsAwake =
    claimed.median - comparable.low.median >= MIN_MEDIAN_BPM_GAP;
  // Reading two: the claim holds an awake-level run no single night could hold awake.
  const run = bulkReadsAwake
    ? null
    : awakeRunInside(trace, start, end, comparable.awakeMedian, claimed.median);
  // Neither reading spoke, which is the answer for every ordinary night.
  if (!bulkReadsAwake && run == null) return null;

  // ── WHAT THE COPY MAY NAME, once the finding exists (#5021) ──────────────
  //
  // The comparison above excludes every window overlapping the claim, which is right
  // for the DECISION — an overlapping window is partly the claim, so ranking against it
  // would compare a thing with itself. It is wrong for the REPORT. When the clock error
  // is shorter than the session, the real trough overlaps the claim and is excluded, so
  // `comparable.low.at` is the lowest window that does not touch it — necessarily
  // displaced away from the onset. Measured on a 420-minute night with a 240-minute
  // shift, that landed **three hours** before the real onset, 43% of a session width;
  // on a shift LONGER than the night it is exact, because then the trough does not
  // overlap at all.
  //
  // So the reported instant is re-derived over the same radius with overlap allowed.
  // Nothing about either verdict moves: `comparable.low` still decides reading one and
  // still anchors reading two's awake level, with the same rules and the same
  // threshold. This only chooses which instant the sentence quotes — and BOTH readings
  // quote it, because a partial shift is exactly the case that displaces it furthest.
  //
  // PAID ONLY BY A NIGHT THAT ALREADY FLAGGED, which is why it sits below both
  // readings rather than inside the scan: the excluded windows are skipped before
  // `windowStats` up there, so scanning them costs `median` calls — the cost #5035
  // measures — and a night that says nothing pays none of it.
  let settled = comparable.low;
  for (
    let from = start - SEARCH_RADIUS_MS;
    from <= start + SEARCH_RADIUS_MS;
    from += SEARCH_STEP_MS
  ) {
    const stats = windowStats(trace, from, from + width);
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
    troughBpm: comparable.low.median,
    troughStart: utcInstant(new Date(settled.at)),
    awakeRun:
      run == null
        ? null
        : { bpm: run.median, start: utcInstant(new Date(run.at)) },
  };
}
