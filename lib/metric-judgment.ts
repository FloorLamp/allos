// ONE JUDGEMENT LOOKUP, KEYED BY IDENTITY (#1996).
//
// THE DEFECT. Age bands, optimal bands and direction live in the canonical
// biomarker vocabulary, keyed by biomarker NAME. The metric detail surface is
// keyed by `BodyMetricSlug`. Nothing mapped one to the other, so a streamed
// reading was charted UNJUDGED — a three-year-old's 120 bpm daily resting-heart-
// rate trend measured against nothing, while the very bands that judge it
// (0–1 → 90–160, 1–3 → 80–150 …) sat in `canonical_biomarkers` waiting for an
// imported observation that may never arrive.
//
// That is an IDENTITY problem, not a storage one: merging the stores would leave a
// table still keyed by metric and still needing this lookup. So the fix is the
// #1997 identity — `metricJudgment(identity, subject)` — and the registry below,
// which says for EVERY registered metric which knowledge system answers for it, or
// says `none` WITH A REASON.
//
// THE COMPLETENESS GUARD is the point of the registry. `lib/__tests__/
// metric-judgment.test.ts` asserts every `BodyMetricSlug` has an entry, so "audit
// whether another metric has this shape" is a build failure instead of a recurring
// manual sweep — the sweep that would have caught body fat before #1996 was
// written.
//
// ONE COMPUTATION. The bands themselves are resolved by the SAME
// `referenceRange`/`optimalBand`/`rangeBadge` the flag reconcile and the biomarker
// surfaces use, so a metric page's band can never disagree with the flag stored on
// a row of the same reading. This module adds the identity lookup around them and
// nothing else.
//
// PURE: no DB. The canonical vocabulary defaults to the committed dataset (which is
// what boot seeds `canonical_biomarkers` FROM); the runtime caller passes the
// profile's DB row instead, so a re-seeded or AI-extended entry wins at runtime.
// See lib/queries/metric-judgment.ts.

import { CANONICAL_BIOMARKERS } from "./datasets/canonical-biomarkers";
import { readingIdentity, streamSourcesForIdentity } from "./reading-model";
import {
  ageBandLabel,
  optimalBand,
  rangeBadge,
  referenceRange,
  type RangeBadge,
} from "./reference-range";
import type { CanonicalRanges } from "./reference-range/parsing";
import { BODY_METRIC_SLUGS, type BodyMetricSlug } from "./trends-body-metrics";
import type { BiomarkerDirection, ReproductiveStatus, Sex } from "./types";

// Which knowledge system answers for a metric.
//
//   • "canonical"        — a curated canonical entry: reference range, optimal
//                          band, direction, and (where curated) age bands.
//   • "growth-percentile"— a WHO/CDC percentile-for-age, which is not a band and
//                          is rendered by the growth card that owns it. Naming it
//                          here says the knowledge EXISTS and where it lives.
//   • "none"             — no clinical band exists for the quantity. The reason is
//                          mandatory: saying so out loud is the point, and it is
//                          what stops a future metric from silently inheriting
//                          "unjudged" as a default.
export type MetricKnowledge =
  | { source: "canonical"; canonical: string }
  | { source: "growth-percentile"; renderedBy: string }
  | { source: "none"; reason: string };

// The registry. EVERY BodyMetricSlug appears — that is the completeness guard.
export const METRIC_KNOWLEDGE: Record<BodyMetricSlug, MetricKnowledge> = {
  // The vitals whose readings ARE observations: identity already reached them,
  // the lookup simply makes the band visible on the surface that charts them.
  systolic: { source: "canonical", canonical: "Blood Pressure Systolic" },
  diastolic: { source: "canonical", canonical: "Blood Pressure Diastolic" },
  spo2: { source: "canonical", canonical: "Oxygen Saturation" },
  "respiratory-rate": { source: "canonical", canonical: "Respiratory Rate" },
  temperature: { source: "canonical", canonical: "Body Temperature" },
  // The reported instance and its sibling: readings STREAM into `body_metrics`
  // while the knowledge is filed under a canonical name (#1996's whole subject).
  "resting-hr": { source: "canonical", canonical: "Resting Heart Rate" },
  "body-fat": { source: "canonical", canonical: "Body Fat Percentage" },
  // Growth is judged as a percentile-for-age against the WHO/CDC charts, not as a
  // band — a 95 cm three-year-old is not "out of range", they are at a percentile.
  height: {
    source: "growth-percentile",
    renderedBy: "the growth card (lib/growth.ts)",
  },
  "head-circ": {
    source: "growth-percentile",
    renderedBy: "the growth card (lib/growth.ts)",
  },
  // No band exists — each reason is specific, because a generic "n/a" would hide
  // exactly the distinctions that make these different questions.
  hrv: {
    source: "none",
    reason:
      "HRV is meaningful against your OWN rolling baseline; population bands vary by device and measurement window, and none is curated here.",
  },
  "skin-temp": {
    source: "none",
    reason:
      "A signed deviation from the tracker's own baseline, not an absolute temperature — there is nothing for a population range to be a range OF.",
  },
  weight: {
    source: "none",
    reason:
      "Weight alone carries no clinical band; height-relative measures and a goal target are how it is judged.",
  },
  bmi: {
    source: "none",
    reason:
      "No curated canonical entry — and a child's BMI is a percentile-for-age question, not the adult category table.",
  },
  hr: {
    source: "none",
    reason:
      "A DAILY AVERAGE including activity is a different quantity from resting heart rate, so the resting bands must not judge it (#482 exclusion discipline).",
  },
  "lean-mass": {
    source: "none",
    reason:
      "No curated band; the curated body-composition entry is the Appendicular Lean Mass INDEX, a different (height-normalized) quantity.",
  },
  "bone-mass": {
    source: "none",
    reason:
      "A scale's bone-mass estimate has no clinical reference range; bone health is judged by DXA T-score, a different measurement.",
  },
  bmr: {
    source: "none",
    reason:
      "An estimate derived from body composition, not a measured quantity with a normal range.",
  },
  hydration: {
    source: "none",
    reason: "An intake TOTAL — a target, not a clinical range.",
  },
  calories: {
    source: "none",
    reason: "An intake TOTAL — a target, not a clinical range.",
  },
  steps: {
    source: "none",
    reason: "An activity COUNT — a target, not a clinical range.",
  },
  "active-calories": {
    source: "none",
    reason: "An activity COUNT — a target, not a clinical range.",
  },
  sun: {
    source: "none",
    reason:
      "Daily outdoor minutes are a behaviour, not a measured quantity with a band.",
  },
  mood: {
    source: "none",
    reason: "A 1–5 self-rating; there is no normal range for how you feel.",
  },
  energy: {
    source: "none",
    reason: "A 1–5 self-rating; there is no normal range for how you feel.",
  },
  calm: {
    source: "none",
    reason: "A 1–5 self-rating; there is no normal range for how you feel.",
  },
};

/** The metric slugs that resolve to a canonical identity, for the sweeps. */
export const JUDGED_METRIC_SLUGS: BodyMetricSlug[] = BODY_METRIC_SLUGS.filter(
  (slug) => METRIC_KNOWLEDGE[slug].source === "canonical"
);

/**
 * The #482 identity a metric's readings carry, or null when the metric has no
 * canonical identity (which is most of the stream vocabulary — see the registry).
 */
export function metricIdentity(slug: BodyMetricSlug): string | null {
  const knowledge = METRIC_KNOWLEDGE[slug];
  return knowledge.source === "canonical"
    ? readingIdentity(knowledge.canonical)
    : null;
}

/**
 * The identity whose OBSERVATIONS a metric surface must fold in, or null when it
 * must not (#1996 part 2).
 *
 * A metric whose identity has a STREAM source charts `body_metrics`/
 * `metric_samples` rows, so a clinic-measured reading of the same quantity is
 * missing from it and belongs in the fold. A metric whose readings ARE
 * observations (SpO2, blood pressure, respiratory rate, body temperature) already
 * shows them — folding there would list every reading twice.
 *
 * It lives here because this module owns the ONE slug → identity map; a second
 * one, anywhere, is the disease this whole change exists to cure.
 */
export function metricObservationFoldIdentity(
  slug: BodyMetricSlug
): string | null {
  const identity = metricIdentity(slug);
  if (!identity) return null;
  return streamSourcesForIdentity(identity).length > 0 ? identity : null;
}

// Who the reading is about. `value` is optional: with it the judgement carries the
// verdict for that reading, without it only the bands.
export interface JudgmentSubject {
  age?: number | null;
  sex?: Sex | null;
  status?: ReproductiveStatus | null;
  /** A reading to judge, in the CANONICAL unit for the identity. */
  value?: number | null;
}

// The resolved clinical knowledge for one identity and one subject.
export interface MetricJudgment {
  identity: string;
  /** The canonical entry that answered — what to NAME the knowledge by. */
  canonical: string;
  unit: string | null;
  /** The reference range for THIS subject (age band applied where curated). */
  low: number | null;
  high: number | null;
  optimalLow: number | null;
  optimalHigh: number | null;
  /** "age 1–3" when an age band applied, null when the adult fields did. */
  bandLabel: string | null;
  direction: BiomarkerDirection | null;
  /** The verdict for `subject.value`; "unknown" when no value was supplied. */
  badge: RangeBadge;
  knowledge: "canonical";
}

// The vocabulary entry this module needs, stated STRUCTURALLY so both shapes of
// the same data satisfy it: the committed dataset row (`Biomarker`, which omits
// the fields it never curates) and the `canonical_biomarkers` DB row
// (`CanonicalBiomarker`, which carries every column). One judgement, two
// vocabularies — never two judgements.
export interface JudgmentEntry {
  name: string;
  unit?: string | null;
  direction?: BiomarkerDirection | null;
  ref_low?: number | null;
  ref_high?: number | null;
  ref_low_male?: number | null;
  ref_high_male?: number | null;
  ref_low_female?: number | null;
  ref_high_female?: number | null;
  optimal_low?: number | null;
  optimal_high?: number | null;
  optimal_low_male?: number | null;
  optimal_high_male?: number | null;
  optimal_low_female?: number | null;
  optimal_high_female?: number | null;
  ranges_by_age?: unknown;
  ranges_by_status?: unknown;
  ranges_by_cycle_phase?: unknown;
}

// Fill the shared range helpers' required shape; every absent field is an explicit
// null, which is what "not curated" already means to them.
function toCanonicalRanges(e: JudgmentEntry): CanonicalRanges {
  return {
    name: e.name,
    unit: e.unit ?? null,
    direction: e.direction ?? null,
    ref_low: e.ref_low ?? null,
    ref_high: e.ref_high ?? null,
    ref_low_male: e.ref_low_male ?? null,
    ref_high_male: e.ref_high_male ?? null,
    ref_low_female: e.ref_low_female ?? null,
    ref_high_female: e.ref_high_female ?? null,
    optimal_low: e.optimal_low ?? null,
    optimal_high: e.optimal_high ?? null,
    optimal_low_male: e.optimal_low_male ?? null,
    optimal_high_male: e.optimal_high_male ?? null,
    optimal_low_female: e.optimal_low_female ?? null,
    optimal_high_female: e.optimal_high_female ?? null,
    ranges_by_age: e.ranges_by_age,
    ranges_by_status: e.ranges_by_status,
    ranges_by_cycle_phase: e.ranges_by_cycle_phase,
  };
}

function entryForIdentity(
  identity: string,
  entries: readonly JudgmentEntry[]
): CanonicalRanges | null {
  const key = identity.trim().toLowerCase();
  if (!key) return null;
  const hit = entries.find(
    (e) => readingIdentity(e.name).toLowerCase() === key
  );
  return hit ? toCanonicalRanges(hit) : null;
}

/**
 * The clinical knowledge for an identity, resolved for a subject — the ONE lookup
 * a reading surface makes, whatever store the reading came from.
 *
 * Returns null when the vocabulary has no entry for the identity, or when the
 * entry states no numeric band at all (an entry with nothing to judge against is
 * not a judgement, and rendering an empty band would be the same lie as an
 * unjudged chart).
 */
export function metricJudgment(
  identity: string,
  subject: JudgmentSubject = {},
  entries: readonly JudgmentEntry[] = CANONICAL_BIOMARKERS
): MetricJudgment | null {
  const entry = entryForIdentity(identity, entries);
  if (!entry) return null;
  const ref = referenceRange(entry, subject.sex, subject.age, subject.status);
  const opt = optimalBand(entry, subject.sex, subject.age);
  if (
    ref.low == null &&
    ref.high == null &&
    opt.low == null &&
    opt.high == null
  ) {
    return null;
  }
  return {
    identity: readingIdentity(entry.name),
    canonical: entry.name,
    unit: entry.unit ?? null,
    low: ref.low,
    high: ref.high,
    optimalLow: opt.low,
    optimalHigh: opt.high,
    // The age band that actually applied — the reference band names it first,
    // falling back to the optimal band's when only that one is age-curated.
    bandLabel: ageBandLabel(ref.band ?? opt.band),
    direction: entry.direction ?? null,
    // The SAME judgement the flag reconcile makes, so the page and the row agree.
    badge: rangeBadge(
      subject.value,
      entry,
      subject.sex,
      subject.age,
      subject.status
    ),
    knowledge: "canonical",
  };
}

/**
 * The judgement for a metric SLUG — the registry lookup composed with the identity
 * one, so a surface keyed by slug asks exactly one question.
 */
export function metricJudgmentForSlug(
  slug: BodyMetricSlug,
  subject: JudgmentSubject = {},
  entries?: readonly JudgmentEntry[]
): MetricJudgment | null {
  const identity = metricIdentity(slug);
  return identity ? metricJudgment(identity, subject, entries) : null;
}
