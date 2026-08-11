// ONE RENDERER PER CADENCE (issue #1932).
//
// A dated clinical reading has two detail surfaces in this app, and which one it
// belongs on is a property of HOW OFTEN IT ARRIVES, not of which table it sits in:
//
//   • EPISODIC — a few readings a year, read against a reference band. A lab draw,
//     an audiogram threshold, a periodontal probing depth, an intraocular pressure,
//     a grip-strength test. The question is "where does this value sit in its
//     range?", so the reading detail page (/results/readings/view) is the right renderer:
//     reference + optimal bands, lab provenance ("Reported as", the reporting lab's
//     own range), a whole-history line that CONNECTS the draws because connecting
//     them is the story.
//
//   • CONTINUOUS — daily-to-many-times-daily, read as a trend. SpO2, blood
//     pressure, respiratory rate, body temperature. The question is "what is this
//     doing lately?", so the metric detail surface (/trends/metric/<slug>) is the
//     right renderer: a windowed chart, trailing 7/30/90-day period cards (#1909),
//     and the readings table with row actions (#1488).
//
// Before #1932 the presentation had no cadence branch at all: `category = 'vitals'`
// was already correct in the data (see lib/vitals-input.ts, which deliberately lands
// manual and Health-Connect vitals in `medical_records` under one canonical name)
// and nothing consumed it, so an SpO2 reading rendered through the lab renderer —
// a permanently-empty "Lab reference" column, a duplicate optimal range, and an
// 8-year spline drawn confidently across a void between one 2018 CCD import and 45
// daily 2026 readings.
//
// THE AUDIT (why this is a per-name table and not `category === 'vitals'`).
// `category = 'vitals'` is NOT the continuous set. Of the 31 canonical entries
// carrying it, six are physiologic vital signs and the other twenty-five are DOMAIN
// vitals — audiogram hearing thresholds (#713), intraocular pressure and visual
// acuity (#697), periodontal measures (#705), the functional-fitness markers (#158).
// lib/medical-categories.ts already says this out loud: those domain vitals have no
// chart surface in this codebase and the flat biomarker catalog is their home. They
// also arrive at the LAB cadence (an audiogram is an annual event) and are read the
// LAB way (against a band, or by an age/sex percentile card the reading detail page
// renders). Routing them by category would trade one wrong page for a dead end —
// which is the failure mode this table exists to make impossible.
//
// So the discriminator is the name, declared here, and the two structural pins are
// in the tests rather than in a comment:
//   • lib/__tests__/reading-cadence.test.ts — every `category = 'vitals'` canonical
//     entry is classified by this module (a NEW vital is an immediate red test, not
//     a silently mis-rendered page), and no episodic-category entry claims a
//     continuous slug.
//   • lib/__db_tests__/vitals-reading-surface.test.ts — every continuous reading's
//     slug is a real metric-detail kind whose METRIC_READING_STORE is exactly this
//     canonical name in `medical_records`, so the destination genuinely charts and
//     lists the rows we send it (no dead ends, by construction).
//
// PURE (no DB, no queries): lib/hrefs.ts consumes it, and hrefs reaches client
// components.

import { biomarkerFamily } from "./canonical-name";
import type { MedicalCategory } from "./types";
import type { BodyMetricSlug } from "./trends-body-metrics";
import { CONTINUOUS_READING_METRIC } from "./reading-identity-map";

export type ReadingCadence = "continuous" | "episodic";

// Which cadences a medical-record CATEGORY can contain. Every category is either
// wholly episodic or, for `vitals` alone, MIXED — the audit above. Exhaustive over
// MedicalCategory, so a new category is a type error here before it is a wrong page
// anywhere else.
export const CATEGORY_CADENCE = {
  // Lab draws, imaging measurements, genomic calls, derived indices, immutable
  // reference facts, screening instruments, prescriptions and narrative reports:
  // all arrive as discrete events and are read against a band or a rubric.
  lab: "episodic",
  genomics: "episodic",
  scan: "episodic",
  derived: "episodic",
  reference: "episodic",
  instrument: "episodic",
  prescription: "episodic",
  report: "episodic",
  // A non-measurement assessment or qualifier (#2318). It is dated like everything
  // else here, so it is episodic — but note that this map answers "what cadence can
  // this category contain", not "does it earn a reading page": an `assessment` never
  // reaches one, because it never claims a biomarker identity in the first place
  // (NON_IDENTITY_CATEGORIES).
  assessment: "episodic",
  // The emptied pre-#1076 bucket. Nothing canonical carries it any more; it stays
  // in the enum, so it stays classified.
  biomarker: "episodic",
  // The one mixed category: physiologic vital signs stream, domain vitals do not.
  // CONTINUOUS_READING_METRIC below is the per-name split.
  vitals: "mixed",
} as const satisfies Record<MedicalCategory, ReadingCadence | "mixed">;

// The continuous readings and the metric-detail kind each one renders through.
// Canonical names are byte-for-byte the ones lib/vitals-input.ts and the Health
// Connect parser write (the same discipline lib/bp-percentiles.ts MARKER_COMPONENT
// keeps); lookup below is by #482 identity family, so a future alias of one of these
// names resolves with it.
//
// Resting Heart Rate is HERE as of #2032, and the two-step reason it took this long is
// worth keeping, because both steps were real:
//
//   • Until #1996/#1999, "the destination would be empty": `/trends/metric/resting-hr`
//     read `body_metrics.resting_hr` and never the `medical_records` row an imported
//     "Resting Heart Rate" observation lands in, so routing a clinic reading there
//     showed a page that did not contain it. Phase 1 fixed that — the metric surface
//     folds in same-identity observations (lib/queries/readings.ts) and the curated age
//     bands judge the trend (lib/metric-judgment.ts).
//   • Until #2032, what still held was EDITABILITY: a folded observation was read-only
//     there, because the write path resolved its store from the metric SLUG. Routing a
//     reading to a page that could chart it but not correct it would have traded one gap
//     for another. Phase 2 closed it — every row of that table posts the PHYSICAL row it
//     writes to, so a clinic-measured resting heart rate is corrected on the surface
//     that charts it.
//
// With that, the two structural pins below GENERALIZE from "one store per destination"
// to "one identity per destination": the destination no longer has to hold the reading
// in `medical_records` under the same canonical name, it has to hold readings of the same
// #482 IDENTITY — which for a streaming quantity means its registered stream source. See
// lib/__db_tests__/vitals-reading-surface.test.ts.
//
// DERIVED since #2086 from the one declaration in lib/reading-identity-map.ts, which
// carries this half and the stream half (`STREAM_READING_SOURCES`) together. The
// membership and the discipline are unchanged; what moved is the literal, so a name can
// no longer be routed to a metric surface without also answering which store its rows
// land in — the half-added entry this pair made possible.
export { CONTINUOUS_READING_METRIC };

const SLUG_BY_FAMILY = new Map<string, BodyMetricSlug>(
  Object.entries(CONTINUOUS_READING_METRIC).map(([name, slug]) => [
    biomarkerFamily(name).toLowerCase(),
    slug,
  ])
);

/**
 * The metric-detail kind a canonical reading renders through, or `null` when the
 * reading is episodic and belongs on the reading detail page. Matching is by #482
 * identity family, so an aliased spelling of a continuous vital resolves with it.
 */
export function continuousReadingSlug(
  canonicalName: string | null | undefined
): BodyMetricSlug | null {
  const name = canonicalName?.trim();
  if (!name) return null;
  return SLUG_BY_FAMILY.get(biomarkerFamily(name).toLowerCase()) ?? null;
}

/**
 * How often this reading arrives — the ONE question that decides its renderer.
 * Every consumer that needs the decision (the href helper, the reading detail
 * page's own guard) asks here rather than re-deriving it from a category string.
 */
export function readingCadence(
  canonicalName: string | null | undefined
): ReadingCadence {
  return continuousReadingSlug(canonicalName) == null
    ? "episodic"
    : "continuous";
}
