// THE RESPIRATORY DOMAIN — pure (no DB, no network). Issue #1850.
//
// The fourth specialty domain to ride the biomarker substrate, after audiometry
// (#1600/#713), periodontal measures (#705) and per-eye refraction / IOP (#697).
// It is an INSTANCE of that shape, not a new invention — the design doctrine's
// "new data is an instance of an existing substrate before it is a new table".
//
// ── THE STORE DECISION (per the #860/#944 observation rule) ───────────────────
//
// Respiratory function is TWO cadences of one subject, and each one already has a
// home:
//
//   • PEAK EXPIRATORY FLOW is a home-measured number, taken once or twice a day
//     during a flare on a £10 plastic tube. That is the STREAM cadence — the same
//     one resting heart rate and body fat arrive at — so it registers a
//     `metric_samples` stream source in lib/reading-identity-map.ts and renders on
//     the metric detail surface (`/trends/metric/peak-flow`), which is what #1932
//     says a continuously-arriving reading gets.
//   • SPIROMETRY (FEV1, FVC, FEV1/FVC) is measured on a pulmonology report, a few
//     times a lifetime. That is the LAB cadence, so those three are ordinary
//     canonical `vitals` analytes landing in `medical_records` through the document
//     pipeline — exactly like an audiogram threshold or a probing depth, read
//     against their band on the reading detail page.
//
// NO NEW TABLE and NO MIGRATION. Nothing about a peak-flow reading needs a column
// `metric_samples` lacks (date, instant, value, source, the #133 edit lock), and
// nothing about a spirometry result needs a column `medical_records` lacks. A
// parallel table would strand both from the readings table, the trend fold, the
// document-import footprint, source comparison, undo-delete and search — the same
// stranding argument lib/audiogram.ts makes at length for its own twelve series.
//
// ── THE ONE DELIBERATE DIVERGENCE FROM THE THREE SIBLINGS ────────────────────
//
// Audiometry has the WHO ≤25 dB HL band, periodontal probing the AAP ≤3 mm band,
// tonometry the 10–21 mmHg band. All three are POPULATION ranges: the value alone
// decides the verdict, so `reconciledFlag()` can derive a flag from the row and
// store it on the row.
//
// Peak flow is not read that way and never has been. An asthma action plan is
// keyed to YOUR OWN personal best — green ≥80%, yellow 50–80%, red <50% of it — so
// 400 L/min is a green day for one person and a red one for another. The verdict is
// a function of (value, a profile fact), not of the value, which means:
//
//   • it CANNOT be a stored `flag`. A flag column is written once at ingest and
//     re-derived by the canonical-flag reconcile; a personal best changes, and every
//     historical row's verdict changes with it. Storing one would be a value that
//     silently goes stale — the #221 "one question, one computation" failure.
//   • so it is not stored at all. `peakFlowZone()` below is computed AT READ, from
//     the reading and the profile's recorded best, by every surface that shows it.
//
// That is why the canonical entry for Peak Expiratory Flow curates NO reference
// band (the honest answer — there is no population range for it) and why the
// knowledge declaration in lib/metric-judgment.ts is `source: "personal-best"`
// rather than `"canonical"`: the reconciliation path is not forked, it is simply
// not the thing that answers here. The argument lives beside the sibling flag
// declarations, in METRIC_KNOWLEDGE, where a reader comparing the four domains
// finds it.
//
// WITH NO PERSONAL BEST THERE IS NO VERDICT. `peakFlowZone` returns null, and every
// surface renders the reading with no zone rather than falling back to a population
// range this quantity does not have. A borrowed band is the #482 exclusion
// discipline's exact prohibition, and here it would be worse than merely wrong: it
// would put a green light on a number that is red for the person holding the meter.

// ---- Vocabulary -------------------------------------------------------------

/** The canonical biomarker name a peak-flow reading is a reading OF. */
export const PEAK_FLOW_CANONICAL = "Peak Expiratory Flow";

/** The canonical unit. Litres per minute, universal for a peak-flow meter. */
export const PEAK_FLOW_UNIT = "L/min";

/** The `metric_samples` key the stream lands under. */
export const PEAK_FLOW_METRIC = "peak_flow_lmin";

/**
 * The metric-detail slug this quantity renders on. Declared here so the surface, the
 * revalidate target and the deep link all spell it once; it is checked against
 * `TREND_METRIC_SLUGS` by the registry's own guards.
 */
export const PEAK_FLOW_SLUG = "peak-flow";

/**
 * The spirometry analytes, in report order. They are observations only — no stream
 * source, no metric surface — so they are NOT registered in the identity map; they
 * are ordinary canonical analytes judged by their own curated row on the surface
 * that reads it (the membership boundary METRIC_KNOWLEDGE writes down).
 */
export const SPIROMETRY_CANONICAL_NAMES = [
  "Forced Expiratory Volume in 1 Second (FEV1)",
  "Forced Vital Capacity (FVC)",
  "FEV1/FVC Ratio",
] as const;

/**
 * Plausibility bounds for a hand-entered peak flow, in L/min. A meter's own scale
 * runs roughly 60–800; the window is a shade wider on both sides so a real reading
 * is never refused, and narrow enough that a mistyped 5000 is.
 */
export const PEAK_FLOW_MIN = 50;
export const PEAK_FLOW_MAX = 900;

// ---- The zone decision ------------------------------------------------------

/** The three action-plan zones, best → worst. */
export const PEAK_FLOW_ZONES = ["green", "yellow", "red"] as const;
export type PeakFlowZone = (typeof PEAK_FLOW_ZONES)[number];

/**
 * The band FLOORS, as a percentage of personal best. Green is the top band, so it
 * has no ceiling; red is the bottom band, so its floor is 0. Declared as data
 * rather than as `if` arms so the copy, the tests and the card all read the same
 * numbers — and so a future action plan with different cut-points is one edit.
 */
export const PEAK_FLOW_ZONE_FLOOR_PCT: Record<PeakFlowZone, number> = {
  green: 80,
  yellow: 50,
  red: 0,
};

/** One reading's verdict against the profile's own best. */
export interface PeakFlowVerdict {
  zone: PeakFlowZone;
  /** The reading as a whole-number percentage of the personal best. */
  percent: number;
  /** The best the percentage was taken against, echoed so a surface can cite it. */
  personalBest: number;
}

/**
 * THE ZONE DECISION — the one computation every surface formats.
 *
 * Returns null when there is nothing to judge against: no personal best recorded,
 * a non-positive or non-finite one, or a non-finite reading. Null means NO VERDICT
 * — never a population fallback, and never a silently substituted default best.
 *
 * The band is taken on the ROUNDED percentage, deliberately: the percentage is what
 * the card prints, so banding on the raw ratio would let a card read "80% of your
 * best" beside a yellow dot. One number, one verdict.
 */
export function peakFlowZone(
  value: number | null | undefined,
  personalBest: number | null | undefined
): PeakFlowVerdict | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (
    personalBest == null ||
    !Number.isFinite(personalBest) ||
    personalBest <= 0
  ) {
    return null;
  }
  const percent = Math.round((value / personalBest) * 100);
  const zone: PeakFlowZone =
    percent >= PEAK_FLOW_ZONE_FLOOR_PCT.green
      ? "green"
      : percent >= PEAK_FLOW_ZONE_FLOOR_PCT.yellow
        ? "yellow"
        : "red";
  return { zone, percent, personalBest };
}

/**
 * What each zone MEANS, in the plain words an action plan uses. Informational — it
 * describes the zone, it never tells anyone what to take.
 */
export const PEAK_FLOW_ZONE_COPY: Record<
  PeakFlowZone,
  { label: string; blurb: string }
> = {
  green: {
    label: "Green zone",
    blurb: "80% or more of your personal best — breathing as usual.",
  },
  yellow: {
    label: "Yellow zone",
    blurb:
      "50–80% of your personal best — airways are narrower than usual. Worth noting, and worth telling your clinician if it stays here.",
  },
  red: {
    label: "Red zone",
    blurb:
      "Under 50% of your personal best. Follow the plan your clinician gave you; seek urgent care if you are struggling to breathe.",
  },
};

/**
 * The reading a personal best would be, if it were taken from the readings on file:
 * the highest value seen. Returns null for an empty series.
 *
 * This is a SUGGESTION and nothing else. Nothing in this domain writes the personal
 * best — it is a user-owned health fact, and the attention doctrine's rule is that
 * the system may detect and suggest while the user's tap is the write. A surface may
 * cite this beside the field ("your highest recorded reading is 620"); it may not
 * quietly become the best, because a single freak blow is exactly the value a person
 * would want to reject.
 */
export function suggestedPersonalBest(
  values: readonly number[]
): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

/**
 * Validate a hand-entered peak flow, in L/min. Returns the user-facing error or
 * null — the ONE bounds check the quick-add form, the write core and their tests
 * share, so a value the client accepts is a value the server accepts.
 */
export function peakFlowRangeError(value: number): string | null {
  return value < PEAK_FLOW_MIN || value > PEAK_FLOW_MAX
    ? `Peak flow must be between ${PEAK_FLOW_MIN} and ${PEAK_FLOW_MAX} ${PEAK_FLOW_UNIT}.`
    : null;
}

/**
 * Validate a personal best. Same window as a reading, because a personal best IS a
 * reading — the best one you have ever blown — so a number outside the plausible
 * meter range is as wrong here as it is there.
 */
export function personalBestRangeError(value: number): string | null {
  return value < PEAK_FLOW_MIN || value > PEAK_FLOW_MAX
    ? `Personal best must be between ${PEAK_FLOW_MIN} and ${PEAK_FLOW_MAX} ${PEAK_FLOW_UNIT}.`
    : null;
}
