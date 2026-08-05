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
//      `digestAutoHour` below resolves past the arrivals instead.
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
// (`currentHour !== slotHour`), not by a stored flag — which is why nothing here
// needs to be registered in SEND_MARKER_REGISTRY.

// ── 1. Resolving the `auto` digest hour ──────────────────────────────────────

// How many measured arrival lags the resolution insists on before it will trust
// them. Below this the sample is too thin to carry a percentile and the caller
// falls back to the wake hour (where the deferral below is the safety net).
// `integration_sync_rows` retention on the measured instance reaches back ~12
// days, so a thin sample is the ordinary case rather than an exotic one.
export const MIN_ARRIVAL_SAMPLE = 5;

// The percentile of the arrival-lag distribution the resolved hour clears. NOT the
// median: a median guarantees ~50% failure by definition. The remaining tail is
// what the one-hour deferral is for.
export const ARRIVAL_LAG_PERCENTILE = 0.9;

// Lags outside [0, this] are not MORNING arrivals and never join the sample. A
// negative lag is a row stamped before the session it describes ended (a backfill);
// a multi-hour one is a Takeout-style bulk import or a device that spent the day
// off the charger. Either would drag a percentile somewhere no morning digest
// should follow, and neither describes "how long after waking does last night
// normally land".
export const MAX_ARRIVAL_LAG_MIN = 240;

// The largest slot hour that has a retry hour to defer INTO. `slotDue` deliberately
// does not wrap past midnight (hour 0 is the next calendar day, where the per-day
// marker is fresh), so hour 23's window is one hour wide and declining there would
// drop the digest for the day rather than delay it.
export const LAST_DEFERRABLE_HOUR = 22;

/**
 * The arrival-lag allowance (minutes after waking) the digest hour should clear, or
 * null when the sample is too thin to say. Samples are minutes between a night's
 * wake instant and the moment its row actually landed in the database.
 */
export function arrivalLagAllowance(lags: readonly number[]): number | null {
  const usable = lags
    .filter((m) => Number.isFinite(m) && m >= 0 && m <= MAX_ARRIVAL_LAG_MIN)
    .sort((a, b) => a - b);
  if (usable.length < MIN_ARRIVAL_SAMPLE) return null;
  // Linear-interpolated percentile, so a small sample doesn't collapse onto its
  // maximum the way nearest-rank would.
  const idx = (usable.length - 1) * ARRIVAL_LAG_PERCENTILE;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(usable[lo] + (usable[hi] - usable[lo]) * (idx - lo));
}

/**
 * The hour (0–23) an `auto` morning digest should resolve to: the first whole hour
 * STRICTLY AFTER the typical wake time plus the arrival-lag allowance. Null when
 * either input is missing, which is the caller's signal to fall back to today's
 * wake-hour behavior.
 *
 * Rounded UP, not to nearest: rounding to nearest pulls the result back below the
 * arrivals it was computed to clear, which is exactly how 05:40 became 06:00.
 * Strictly after, so a digest scheduled for the same minute the data typically
 * lands is not a race it loses half the time.
 *
 * This is the DIGEST's resolution and only the digest's. The `auto` Morning intake
 * hour keeps the shared wake-hour helper deliberately: it needs you awake, not your
 * tracker synced, so the wake hour is the correct answer for it.
 */
export function digestAutoHour(
  wakeMinute: number | null,
  lagAllowanceMin: number | null
): number | null {
  if (wakeMinute == null || lagAllowanceMin == null) return null;
  const target = wakeMinute + lagAllowanceMin;
  return Math.min(23, Math.floor(target / 60) + 1);
}

// ── 2. Deferring one hour when last night has not landed ─────────────────────

export interface DigestDeferInput {
  /** The digest's resolved slot hour (0–23), profile-local. */
  slotHour: number;
  /** The profile-local hour this tick is running in. */
  currentHour: number;
  /**
   * Whether the digest hour is the resolved `auto` hour rather than one the user
   * typed. Deferral is auto-only: a manually set hour is user-owned timing, and
   * silently sliding someone's 07:00 to 08:00 makes their own setting untrue.
   */
  auto: boolean;
}

/**
 * Whether this tick should DECLINE to send the digest and let the retry hour send
 * it instead. `sleepPending` is a thunk so the caller pays for the sleep read only
 * on the one tick per day where the answer can matter.
 *
 * The deferral is once and only once, by construction:
 *   • it fires only when `currentHour === slotHour`, so the retry hour never defers;
 *   • `slotDue` stops offering the slot after `slotHour + 1`;
 *   • so the digest sends at `slotHour + 1` whether or not sleep arrived.
 * The digest also carries activity, upcoming, biomarkers and more — one pending
 * section must never hold the rest hostage, and here it structurally cannot.
 */
export function shouldDeferDigest(
  input: DigestDeferInput,
  sleepPending: () => boolean
): boolean {
  if (!input.auto) return false;
  if (input.currentHour !== input.slotHour) return false;
  if (input.slotHour > LAST_DEFERRABLE_HOUR) return false;
  return sleepPending();
}
