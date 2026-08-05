// THE READING IDENTITY MAP — one declaration, both halves derived (issue #2086 §3).
//
// A canonical biomarker name is joined to the rest of the app by two facts:
//
//   • the STREAM it arrives on, if any — the `body_metrics` column or `metric_samples`
//     key whose rows are readings of that same quantity (`STREAM_READING_SOURCES`,
//     lib/reading-model.ts since #1996);
//   • the metric SURFACE that renders it, if the reading arrives continuously enough
//     to be read as a trend rather than against a band (`CONTINUOUS_READING_METRIC`,
//     lib/reading-cadence.ts since #1932/#2032).
//
// Those are two halves of ONE bijection — "which stored quantity is this canonical name,
// and where does it render" — and until #2086 they were two literal tables in two files,
// consistency-tested but separately edited. A half-added entry was a live shape: a
// canonical name registered as a stream but not routed to its surface renders a chart
// its readings never reach, and one routed to a surface with no stream registered folds
// no observations into it. Both are exactly the #1996 defect one layer out.
//
// So the declaration is here, once, and the two tables are DERIVED from it. An entry
// cannot be half-added, because there is only one place to add it.
//
// DISCIPLINE, unchanged and load-bearing (#482). Registering a name here claims that the
// stream measures the SAME quantity the canonical entry curates. Weight, height, HRV,
// steps and the rest of the stream vocabulary are absent because the canonical
// vocabulary has no entry for them — an invented mapping would grant a reading a band
// that was never curated for it. Widening the GUARD must never widen the VOCABULARY.
//
// PURE, and deliberately import-light: only type-only imports, so nothing that consumes
// the map pulls a DB module in behind it.

import type { BodyMetricColumn } from "./metric-readings";
import type { BodyMetricSlug } from "./trends-body-metrics";

// A STREAM store's column/metric and the canonical biomarker name it measures — the
// half that lets a wearable row resolve clinical knowledge filed under a canonical NAME.
export interface StreamReadingSource {
  store: "body_metrics" | "metric_samples";
  /** The `body_metrics` column, or the `metric_samples` metric key. */
  key: BodyMetricColumn | string;
  /** The canonical biomarker name this stream measures. */
  canonical: string;
  /** The unit the stream stores in (canonical for that quantity). */
  unit: string;
}

/**
 * One canonical name's place in the app: where its readings stream from, and which
 * metric surface renders them.
 *
 * `surface` is the #1932 CADENCE answer — a slug means "this arrives continuously and
 * is read as a trend, so the metric detail page is its renderer"; `null` means the
 * reading is episodic and belongs on the reading detail page (/biomarkers/view).
 * `stream` is the #1996 STORE answer — present when rows of this quantity land in a
 * stream store rather than (only) in `medical_records`.
 *
 * An entry with NEITHER would be a name that claims nothing, so at least one is always
 * set; the guard in lib/__tests__/reading-identity-map.test.ts pins it.
 */
export interface ReadingIdentityEntry {
  canonical: string;
  /** The metric-detail kind that renders this reading as a trend, or null (episodic). */
  surface: BodyMetricSlug | null;
  /** The stream store this quantity's rows land in, or null (observations only). */
  stream: Omit<StreamReadingSource, "canonical"> | null;
}

export const READING_IDENTITY_MAP: readonly ReadingIdentityEntry[] = [
  // ── The physiologic vitals that store as OBSERVATIONS and stream from nothing ──
  // lib/vitals-input.ts deliberately lands manual and Health-Connect vitals in
  // `medical_records` under these canonical names, so the metric surface charts the
  // observation rows directly and there is no stream half to register.
  {
    canonical: "Blood Pressure Systolic",
    surface: "systolic",
    stream: null,
  },
  {
    canonical: "Blood Pressure Diastolic",
    surface: "diastolic",
    stream: null,
  },
  { canonical: "Oxygen Saturation", surface: "spo2", stream: null },
  { canonical: "Respiratory Rate", surface: "respiratory-rate", stream: null },
  { canonical: "Body Temperature", surface: "temperature", stream: null },

  // ── The reported instance (#1996): a STREAM whose knowledge is filed by name ──
  // A wearable resting heart rate streams into `body_metrics` while "Resting Heart
  // Rate" observations — and the curated age bands that judge a child's 120 bpm —
  // live in `medical_records` under that canonical name. Both halves set: the
  // observations fold into the stream's chart, and a clinic-measured reading routes
  // to the surface that charts it (#2032).
  {
    canonical: "Resting Heart Rate",
    surface: "resting-hr",
    stream: { store: "body_metrics", key: "resting_hr", unit: "bpm" },
  },
  // The same shape, found by the #1996 audit: body fat streams from a smart scale and
  // has a curated "Body Fat Percentage" entry.
  //
  // Its `surface` is deliberately NULL. A DEXA-reported body-fat percentage is an
  // episodic clinical measurement read against a band, and #1932's whole point is that
  // the renderer follows the CADENCE the reading arrives at, not the existence of a
  // chart elsewhere. The metric page still folds the observations in (that is the
  // stream half's job); what it does not do is claim the clinical reading's detail
  // page. Routing it here would be a behaviour change, and it is not one this
  // declaration is entitled to make silently.
  {
    canonical: "Body Fat Percentage",
    surface: null,
    stream: { store: "body_metrics", key: "body_fat_pct", unit: "%" },
  },
];

/**
 * The stream ↔ canonical half (#1996). Derived, so a stream can only be registered by
 * an entry that also had to answer the surface question.
 */
export const STREAM_READING_SOURCES: readonly StreamReadingSource[] =
  READING_IDENTITY_MAP.flatMap((e) =>
    e.stream ? [{ ...e.stream, canonical: e.canonical }] : []
  );

/**
 * The canonical → metric-surface half (#1932). Derived from the same entries, so a
 * continuous reading cannot be routed to a page nobody declared a store for.
 */
export const CONTINUOUS_READING_METRIC: Record<string, BodyMetricSlug> =
  Object.fromEntries(
    READING_IDENTITY_MAP.flatMap((e) =>
      e.surface ? [[e.canonical, e.surface] as const] : []
    )
  );
