// THE ONE BOUNDED ARRIVAL WAIT (issue #5001).
//
// Three places in this app wait for a source to deliver something, and until now each
// one was hand-built: the sleep morning state (#2097), the practice finish message's
// bound (#4775 §3), and — as of #4996 — the recap line that promises details when
// Strava syncs. Only the sleep one MEASURED, and nothing in its arithmetic was about
// sleep. This is that arithmetic with sleep's names removed.
//
// THE MEASURED LAG AND THE DEFAULT ARE NOT INTERCHANGEABLE, and keeping them apart is
// the point of the shape below. The default BOUNDS the window; it is never quoted as an
// ETA, because a number nobody measured is not a promise anyone may make. So `etaMin`
// is the measured value or nothing at all — the sample gate lives in whatever produced
// `measuredLagMin` (`getArrivalLagMinutes` returns null under it), and a caller that
// wants to quote an ETA reads this field rather than re-deriving one.
//
// AND EVERY WAIT IS BOUNDED. `maxMin` is the whole difference between an informative
// state and a stuck one (the rule #2097 wrote for the sleep window, at
// lib/sleep-waiting.ts): past it the answer stops being "waiting" whatever the measured
// lag says. A consumer whose own reason to stop is shorter than any pipeline — the
// practice recap, where "a message about a sauna three hours ago is a bulletin, not a
// finish note" — passes that reason as `maxMin` and gets it enforced against a fast
// profile and a slow one alike.

export interface ArrivalWaitInput {
  /**
   * The measured median lag for this source and row kind, or null when nothing has
   * been measured to the sample gate. Null is not "no lag" — it is "no promise".
   */
  measuredLagMin: number | null;
  /** The window's lag when nothing is measured. Bounds; never quoted. */
  defaultLagMin: number;
  /** Slack past the expected arrival before the wait gives up. A median is a median. */
  graceMin: number;
  /** The hard bound. Past it the state stops being "waiting", measured or not. */
  maxMin: number;
  /**
   * Minutes since the awaited thing's own origin — a night's wake anchor, a practice
   * window's end. NEGATIVE before it, which is a state of its own: nothing is late
   * yet, because nothing is due yet.
   */
  elapsedMin: number;
}

export type ArrivalWait =
  /** The origin has not passed. Nothing is due, so nothing is late. */
  | { kind: "ready" }
  /** Inside the window. `etaMin` is minutes after the origin, or null under the gate. */
  | { kind: "waiting"; etaMin: number | null }
  /** Past the window. The wait is over and the thing did not come. */
  | { kind: "overdue" };

/** How long this wait runs before it gives up, in minutes after the origin. */
export function arrivalWaitWindowMin(
  input: Pick<
    ArrivalWaitInput,
    "measuredLagMin" | "defaultLagMin" | "graceMin" | "maxMin"
  >
): number {
  return Math.min(
    (input.measuredLagMin ?? input.defaultLagMin) + input.graceMin,
    input.maxMin
  );
}

export function arrivalWait(input: ArrivalWaitInput): ArrivalWait {
  if (input.elapsedMin < 0) return { kind: "ready" };
  if (input.elapsedMin <= arrivalWaitWindowMin(input)) {
    return { kind: "waiting", etaMin: input.measuredLagMin };
  }
  return { kind: "overdue" };
}

// ── the sample's own two numbers ─────────────────────────────────────────────
//
// They live HERE rather than beside either consumer, because they are the
// MEASUREMENT's parameters and the invariant #5001 states is that there is one
// measurement per (source, row kind) with no consumer keeping its own. Both are
// re-exported from where they used to live, so nothing that already reads them from
// the sleep surface has to move.

/**
 * How many arrivals before a median may be QUOTED as an ETA.
 *
 * `integration_sync_rows` retention reaches back about twelve days on the measured
 * instance, so an arrival sample is often thinner than it looks; a median built on
 * three mornings is not something to put on screen as a promise. Under the gate the
 * producer returns null and the copy degrades to its unquantified wording.
 */
export const MIN_ARRIVAL_SAMPLES = 5;

/**
 * The plausibility cut on one arrival, in minutes.
 *
 * An ARCHIVE import — a Fitbit Takeout zip, a Strava bulk export — inserts hundreds of
 * rows at once whose "lag" is months. Letting those into the sample would quote a
 * number measured on a one-off backfill instead of the daily rhythm every consumer of
 * this model is actually asking about.
 */
export const ARRIVAL_LAG_MAX_MIN = 12 * 60;

/** The median of a sample, or null under the gate. The one place it is taken. */
export function arrivalLagMedian(lags: readonly number[]): number | null {
  if (lags.length < MIN_ARRIVAL_SAMPLES) return null;
  const sorted = [...lags].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median);
}
