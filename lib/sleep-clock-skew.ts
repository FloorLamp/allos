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

// One per-minute HR bucket as stored: `ts` is a canonical UTC instant (hr_minutes.ts
// has been an absolute instant since migration 164), `bpm` the count-weighted average.
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
}

const MINUTE_MS = 60_000;

// How much of the claimed window (and of any comparison window) must carry an HR
// sample before either is allowed to speak. Below this the answer is "no concurrent
// coverage", which is a NON-detection: a session with a sparse or absent trace can
// never flag, however odd its clocks look (#4299 acceptance criterion 2).
const MIN_HR_COVERAGE = 0.5;

// The median gap, in bpm, at which a claimed window reads as awake-level against a
// comparable trough elsewhere. Derived from the sighting: the contradicted session
// averaged up to 75 bpm while the real overnight trough four hours earlier averaged
// 57–62 — a gap of 13 to 18. Ordinary within-night variation (an early-morning
// awakening leaving a slightly deeper trough elsewhere in the same night) is a few
// bpm. 10 sits between them, closer to the noise than to the defect on purpose:
// this feeds a calm observation and a delete affordance, never an alarm.
//
// The MEDIAN is the "bulk of the session" test, not a separate one — a median 10 bpm
// above the trough's median means at least half the claimed minutes are that high.
const MIN_MEDIAN_BPM_GAP = 10;

// How far either side of the claimed session to look for the real trough. The observed
// skew is 6 hours; a stale zone reference can be any offset, and ±12h covers every one
// of them while staying inside "the surrounding day".
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

// The median bpm over [from, to), or null when the window's coverage is too thin to
// carry a claim. `expectedMinutes` is the window's own width, so coverage is measured
// against what a complete trace would hold rather than against a constant.
function windowMedian(
  samples: readonly { at: number; bpm: number }[],
  from: number,
  to: number
): number | null {
  const inside: number[] = [];
  for (const s of samples) {
    if (s.at >= from && s.at < to) inside.push(s.bpm);
  }
  const expectedMinutes = Math.round((to - from) / MINUTE_MS);
  if (expectedMinutes <= 0) return null;
  return inside.length / expectedMinutes >= MIN_HR_COVERAGE
    ? median(inside)
    : null;
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
  const samples = hr.flatMap((s) => {
    const at = Date.parse(s.ts);
    return Number.isFinite(at) && Number.isFinite(s.bpm) ? [{ at, bpm: s.bpm }] : [];
  });
  if (samples.length === 0) return null;

  const claimedBpm = windowMedian(samples, start, end);
  if (claimedBpm == null) return null;

  // Every equal-width window in the surrounding day that does NOT overlap the claim.
  // Equal width is what makes "comparable" true by construction: a five-hour night is
  // compared against five-hour windows, never against a ten-minute dip.
  const width = end - start;
  let best: { bpm: number; at: number } | null = null;
  for (
    let from = start - SEARCH_RADIUS_MS;
    from <= end + SEARCH_RADIUS_MS - width;
    from += SEARCH_STEP_MS
  ) {
    if (from < end && from + width > start) continue; // overlaps the claim
    const bpm = windowMedian(samples, from, from + width);
    if (bpm != null && (best == null || bpm < best.bpm)) best = { bpm, at: from };
  }
  if (best == null || claimedBpm - best.bpm < MIN_MEDIAN_BPM_GAP) return null;

  return {
    start: session.start,
    end: session.end,
    claimedBpm,
    troughBpm: best.bpm,
    troughStart: new Date(best.at).toISOString().slice(0, 19) + "Z",
  };
}
