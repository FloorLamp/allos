// A WEARABLE BREATHING RATE IS ONE READING PER NIGHT (issue #5409), pure half.
//
// WHY IT EXISTS. Fitbit computes ONE breathing rate per sleep log and writes it to
// Health Connect as an instant record stamped at the log's CURRENT end. When it extends
// the log it re-publishes the same reading with a new stamp. The Health Connect parser
// keyed the observation on that stamp (`health-connect:<canonical>:<t>`), so every
// re-stamp was a NEW `medical_records` row: six of the last forty-five nights on the
// owner's record carried two or three "Respiratory Rate" results for one night, and the
// record rendered them in the "Vital signs results" fold as three lab results.
//
// THE FIX IS THE NATURAL KEY. The reading is not an instant measurement; it is an
// aggregate OVER a sleep session, exactly as `skin_temp_delta_c` and `hrv_ms` are. Keyed
// on the SESSION START — the same key sleep itself uses — a re-published reading for the
// same night is an `ON CONFLICT DO UPDATE` on value and window, and no provisional row
// survives. That is the whole of "replace in place" (owner ruling, 2026-09-05).
//
// ── TWO QUANTITIES, NOT ONE (the owner ruling this module exists to hold) ──────────
//
// The nightly reading is NOT the clinical respiratory rate, and it must never be judged
// as one. The clinical quantity is a spot count taken while awake, curated at 12–20 with
// LOINC 9279-1; the nightly one is an overnight average from a wrist device, the way
// Resting HR is a daily aggregate distinct from Heart Rate — a pair the reading identity
// map already keeps apart. So they are two identities:
//
//   • `Respiratory Rate`         — observations in `medical_records`, LOINC 9279-1,
//                                  the 12–20 band, the clinical results page. UNCHANGED.
//   • `Breathing Rate (sleep)`   — the nightly stream, `metric_samples`
//                                  `respiratory_rate_bpm`, no population band.
//
// The trap this closes is the tempting shortcut of registering the nightly stream under
// canonical `Respiratory Rate`, which would grant a sleeping average the awake band.
//
// ── THE SOURCE DECIDES, NOT THE ANALYTE NAME ──────────────────────────────────────
//
// `isWearableRespiratorySource` is the whole discrimination, and it reads the INTEGRATION
// that wrote the row. A nurse's count at a visit, a document's, and a hand-typed reading
// are `manual` / `document:<id>` / a legacy NULL, and every one of them stays a clinical
// observation. Widening this set is how a clinical row would be moved by mistake, so it
// is an explicit list of integration ids rather than a prefix test or a "not manual"
// negation — `lib/__tests__/breathing-rate.test.ts` pins both directions.

/** The `metric_samples` metric key the nightly reading streams on. */
export const BREATHING_RATE_METRIC = "respiratory_rate_bpm";

/** The canonical name of the nightly quantity — NOT `Respiratory Rate`. */
export const BREATHING_RATE_CANONICAL = "Breathing Rate (sleep)";

/** The canonical name of the CLINICAL quantity, which nothing here moves. */
export const CLINICAL_RESPIRATORY_CANONICAL = "Respiratory Rate";

/**
 * The integrations whose respiratory rate is a wearable's nightly aggregate.
 *
 * Both write the SAME quantity: Health Connect carries Fitbit's per-session reading
 * stamped at the session end, and Fitbit Takeout's `daily_respiratory_rate` is that same
 * nightly number labelled by day. No other source writes a `Respiratory Rate` row — the
 * pull-sync integrations have no respiratory feed, and manual entry and document
 * extraction are clinical by construction.
 */
export const WEARABLE_RESPIRATORY_SOURCES: readonly string[] = [
  "health-connect",
  "fitbit-takeout",
];

/**
 * Is this stored row's `source` a wearable's nightly breathing rate?
 *
 * EXACT MATCH, deliberately. `document:17` must not match on a prefix, `manual` must not
 * match on a negation, and a NULL legacy source is UNKNOWN — never "wearable".
 */
export function isWearableRespiratorySource(
  source: string | null | undefined
): boolean {
  return source != null && WEARABLE_RESPIRATORY_SOURCES.includes(source);
}

/** One sleep session's window, in the columns the match below reads. */
export interface BreathingRateSession {
  startedAt: string;
  endedAt: string;
  startMs: number;
  endMs: number;
  /** The profile-local wake day the session is filed under. */
  wakeDay: string;
  /** The writing package, or null when the source stated none. */
  origin: string | null;
}

/**
 * The session a wearable reading stamped at `stampMs` summarizes, or undefined.
 *
 * CONTAINMENT, INCLUSIVE OF BOTH EDGES, and nothing else. The exporter stamps the
 * reading at the session's current END to the second, so the equal-to-end case is the
 * ordinary one and the inside case is what an extended log leaves behind; a clock
 * heuristic ("within an hour of a night") would claim an evening spot reading.
 *
 * SAME ORIGIN. A reading is the night's only when the same package recorded both. Two
 * unstated origins (NULL) match each other because within one payload they are one
 * exporter's silence, not two devices — and the consequence of a wrong match here is
 * mild in a way the #3628 collapse's is not: a mismatched reading stays an observation,
 * which is where it lands today.
 *
 * The LONGEST containing session wins when a nap nests inside an overnight one, so the
 * reading joins the night rather than the nap.
 */
export function sessionForStamp(
  stampMs: number,
  origin: string | null,
  sessions: readonly BreathingRateSession[]
): BreathingRateSession | undefined {
  let best: BreathingRateSession | undefined;
  for (const s of sessions) {
    if (s.origin !== origin) continue;
    if (stampMs < s.startMs || stampMs > s.endMs) continue;
    if (!best || s.endMs - s.startMs > best.endMs - best.startMs) best = s;
  }
  return best;
}

/**
 * The MAIN session of a wake day — what a day-labelled Takeout reading summarizes.
 *
 * The longest session filed under that day, which is the same election
 * `mainSleepSession` makes for the sleep surfaces. Undefined when the day holds none,
 * and the caller then keeps the day window it already had.
 */
export function mainSessionForDay(
  wakeDay: string,
  sessions: readonly BreathingRateSession[]
): BreathingRateSession | undefined {
  let best: BreathingRateSession | undefined;
  for (const s of sessions) {
    if (s.wakeDay !== wakeDay) continue;
    if (!best || s.endMs - s.startMs > best.endMs - best.startMs) best = s;
  }
  return best;
}
