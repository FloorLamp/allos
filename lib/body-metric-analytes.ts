// DOES THIS ANALYTE ALREADY HAVE A BODY-METRIC HOME? (issue #2365)
//
// THE DEFECT. #1076 re-homed six medical-record CLASSES out of the flat Biomarkers
// browser and deliberately kept `vitals`, for a reason that is still right: the
// DOMAIN vitals catalogued there — audiogram thresholds (#713), intraocular pressure
// and visual acuity (#697), periodontal probing depth (#705) — have no dedicated
// chart surface, so the flat catalog is their only reachable home and removing them
// would STRAND them.
//
// The outcome was wrong because the CATEGORY is the wrong granularity for that
// decision. `vitals` holds two populations, and keeping it whole to protect the small
// one drags the large one along: measured on one real profile, 131 of 145 `vitals`
// rows were blood pressure / SpO2 / respiratory rate / body temperature / BMI — every
// one of them a quantity with a Trends metric home — against 14 rows of genuinely
// homeless domain vitals. The catalog listed ten measurements that already had a home
// for every one it rescued.
//
// THE RULE, per analyte instead of per category: a `vitals` analyte that maps to a
// `BodyMetricSlug` is not listed in the flat browser; one that does not, stays. That
// KEEPS #1076's rule rather than overriding it — nothing is stranded, because
// membership is now decided by WHETHER A HOME EXISTS rather than by which category the
// quantity happens to be filed under.
//
// DERIVED, NEVER HAND-LISTED. The two registries that already answer it are the only
// inputs:
//
//   • `BODY_METRIC_SLUGS` / `BODY_METRIC_META` (lib/trends-body-metrics.ts) — the ONE
//     declaration of which quantities get a tile, a chart and a
//     `/trends/metric/<slug>` detail page, i.e. which quantities HAVE a home, and what
//     each one is called.
//   • `METRIC_KNOWLEDGE` (lib/metric-judgment.ts) — the slug → canonical-name half,
//     for the metrics whose knowledge is filed in the canonical vocabulary.
//
// So a slug added to the metric registry removes its analyte from the catalog with NO
// second edit, and the two registries cannot drift apart — which is the deliverable;
// the behaviour change is a consequence of it. #2322 gets the same property for free:
// an analyte that gains a dedicated surface there leaves the browser automatically,
// and one that does not, stays.
//
// WHICH NAMES A SLUG CLAIMS, and why each source is safe:
//
//   1. The CANONICAL name `METRIC_KNOWLEDGE` declares, when it declares one. The
//      curated, exact route — "Blood Pressure Systolic", "Oxygen Saturation",
//      "Peak Expiratory Flow".
//   2. The registry TITLE. Needed because a metric can have a home and no canonical
//      band: `bmi`'s knowledge is honestly `none` ("a child's BMI is a
//      percentile-for-age question"), yet "Body Mass Index" is unmistakably the
//      quantity `/trends/metric/bmi` charts.
//   3. The registry LABEL, but ONLY when it is an ACRONYM by the same gate the
//      canonical alias derivation uses (`looksLikeAbbreviation`). That admits "BMI",
//      "RHR", "HRV", "BMR" — which are what a document actually prints — and rejects
//      "Body Temp", "Avg HR", "Resp. Rate", "Weight": chart chrome, not analyte names.
//
// MATCHING IS EXACT, NEVER FUZZY, because getting this wrong in the REMOVING direction
// is the expensive failure: a domain vital with no other home would vanish from the
// app. Comparison is on `normalizeCanonicalKey` — the order-independent token SET the
// whole vocabulary already compares on — over WHOLE names only. The one derivation
// applied to the stored name is `acronymNameForms`, which strips a trailing ACRONYM and
// nothing else, so "Body Mass Index (BMI)" reaches "Body Mass Index" while a WORD
// parenthetical stays part of the quantity: "Blood Pressure Systolic (Peak Exercise)"
// is NOT resting blood pressure, and a stress-test vital keeps its place in the
// catalog. "Waist Circumference" never touches "Head Circumference"; "Pure Tone
// Average", "Color Vision", "Ankle-Brachial Index" and "Cardio-Ankle Vascular Index"
// touch nothing at all. lib/__tests__/body-metric-analytes.test.ts asserts BOTH
// directions over the real registries — the slugged analytes leave AND every listed
// domain vital stays.
//
// "A CHART EXISTS" IS NOT THE QUESTION. The question is whether a DOCUMENT-IMPORTED
// reading of this quantity can REACH that chart, and those are different — which is
// the hole this module shipped with. `hrv` and `bmr` both have a registered slug, a
// tile and a detail page, and both charts are fed EXCLUSIVELY by integration streams:
// neither quantity has a canonical entry (so no identity exists to fold an observation
// through) and no import projection writes one. A cardiology report's HRV and an
// indirect-calorimetry report's BMR are real clinical readings a real document prints,
// and dropping them from the catalog on the strength of "there is a chart" would land
// them on NO surface at all. That is exactly the stranding #1076 exists to prevent,
// arriving through a different door and SILENTLY — the expensive direction this module
// names above.
//
// So reachability is DECLARED per slug, in `METRIC_DOCUMENT_REACH` below, and a slug
// that does not answer it does not compile (the registry is total over
// `BodyMetricSlug`, the `lib/fitness-freshness.ts` precedent). A slug added later has
// to answer the question rather than silently start swallowing document rows — which
// is the same drift-proofing property the name derivation itself is built on.
//
// AND THE DECLARATION IS CHECKED, not trusted. Three of its four "reaches" mechanisms
// are verifiable against the code that implements them, and the completeness test in
// lib/__tests__/body-metric-analytes.test.ts verifies each one rather than reading the
// prose beside it: `observations` against `METRIC_READING_STORE`, `observation-fold`
// against `metricObservationFoldIdentity`, `import-projection` against the projector's
// OWN recognizer (`bodyMetricKind` / `isHeightReading` / `isHeadCircReading`), asked
// with the very names the slug claims. A declaration that stops being true fails CI.
//
// A MISPLACED ROW IS THEN A PLACEMENT BUG, NOT A CATALOG PROBLEM. "Body Mass Index
// (BMI)" arriving as a `medical_records` row is #2318's misplacement — under this rule
// it stops being browsable for the RIGHT reason (the quantity is answered), independent
// of whether that placement is fixed; `/trends/metric/bmi` computes it from the weight
// and height that came in beside it, and both of those are themselves projected onto
// their own charts. `Waist Circumference` is a body metric by the owner's ruling on
// #2322 but is NOT yet a slug, so it stays browsable today and leaves on its own the
// moment that slug lands. This module answers only "is this quantity answered
// elsewhere"; which store a given row went to is `placeReading()`'s question.
//
// PURE: registries and string keys, no DB, no React. The projectors are deliberately
// NOT imported here — they pull the extraction types in behind them, and the check
// belongs to the test rather than to the request path.

import {
  acronymNameForms,
  looksLikeAbbreviation,
  normalizeCanonicalKey,
} from "./canonical-name";
import { METRIC_KNOWLEDGE } from "./metric-judgment";
import {
  BODY_METRIC_META,
  BODY_METRIC_SLUGS,
  type BodyMetricSlug,
} from "./trends-body-metrics";

// The category the per-analyte rule applies to. #1076's other re-homed classes are
// excluded WHOLE (they have a home by class), and `lab` / `genomics` / `scan` stay
// listed whole; `vitals` is the one category that holds both populations.
export const HOMED_ANALYTE_CATEGORY = "vitals";

/**
 * How a DOCUMENT-IMPORTED reading of a metric's quantity reaches that metric's chart —
 * or the stated reason it cannot.
 *
 * Only a metric that answers `reaches` may claim its analyte names, so only such a
 * metric can remove an analyte from the catalog.
 */
export type DocumentReadingReach =
  /**
   * The chart IS the observation store: the imported `medical_records` row is itself a
   * point on it. Verifiable — `METRIC_READING_STORE[slug].table === "medical_records"`.
   */
  | { reaches: "observations" }
  /**
   * The chart plots a STREAM and folds same-identity observations into it (#1996), so
   * a clinic-measured reading appears beside the wearable ones. Verifiable —
   * `metricObservationFoldIdentity(slug) !== null`.
   */
  | { reaches: "observation-fold" }
  /**
   * Document import PROJECTS the reading into the metric's stream store, so the same
   * measurement is on the chart under its stream key. Verifiable — the named
   * projector's own recognizer accepts every name this slug claims.
   */
  | { reaches: "import-projection"; projectedBy: string }
  /**
   * A DERIVED series with no row of its own, whose INPUTS arrive in the same document
   * and are themselves projected — so the quantity is charted even though the imported
   * row is not a point. The one judgement call here, and it is the issue's own ruling.
   */
  | { reaches: "derived-inputs"; from: string }
  /** Nothing carries an imported reading of this quantity onto the chart. */
  | { reaches: false; reason: string };

/**
 * Per-slug reachability. TOTAL over `BodyMetricSlug` — a new metric must answer.
 *
 * `reaches: false` is not a defect and needs no fixing: it means the flat catalog is
 * still the right home for that quantity's imported readings, exactly as #1076 left it.
 */
export const METRIC_DOCUMENT_REACH: Record<
  BodyMetricSlug,
  DocumentReadingReach
> = {
  // ── The vitals that STORE as observations: the row is the chart point ──────────
  systolic: { reaches: "observations" },
  diastolic: { reaches: "observations" },
  spo2: { reaches: "observations" },
  "respiratory-rate": { reaches: "observations" },
  temperature: { reaches: "observations" },

  // ── Streams that fold their clinical twin in (#1996) ──────────────────────────
  // Each names a canonical entry AND registers a stream, which is precisely the pair
  // `metricObservationFoldIdentity` requires: a clinic resting HR, a DEXA body fat and
  // a pulmonology report's peak flow all land on the same chart as the device rows.
  "resting-hr": { reaches: "observation-fold" },
  "body-fat": { reaches: "observation-fold" },
  "peak-flow": { reaches: "observation-fold" },

  // ── Projected at ingest: the import writes the stream row itself ──────────────
  // No canonical entry, so nothing folds — but the document path recognizes these by
  // name and writes a second, charted row, which is why removing the catalog copy
  // hides nothing.
  weight: {
    reaches: "import-projection",
    projectedBy: "bodyMetricKind → body_metrics.weight_kg (lib/body-metric-extract.ts)",
  },
  height: {
    reaches: "import-projection",
    projectedBy:
      "isHeightReading → metric_samples 'height_cm' (lib/height-extract.ts)",
  },
  "head-circ": {
    reaches: "import-projection",
    projectedBy:
      "isHeadCircReading → metric_samples 'head_circumference_cm' (lib/head-circ-extract.ts)",
  },

  // ── Derived from inputs that arrive with it ───────────────────────────────────
  // BMI has no row of its own; the chart is a date-paired computation over weight and
  // height. A document that prints a BMI printed the weight and height it came from,
  // and both of those ARE projected — so the quantity is charted from the same import.
  // This is #2318's misplaced row, and the reason it stops being browsable is that the
  // question "what is this person's BMI" is answered, not that the row was tidied away.
  bmi: {
    reaches: "derived-inputs",
    from: "weight × height (bmiSeriesDatePaired), both import-projected",
  },

  // ── NOT REACHED: the catalog stays their home ─────────────────────────────────
  // Each reason is specific. A generic "no" is what would let the next one through.
  hrv: {
    reaches: false,
    reason:
      "Charted from `metric_samples` HRV samples ONLY. HRV has no canonical entry, so there is no identity to fold an observation through, and no import projection writes one — a cardiology report's HRV would reach no surface at all.",
  },
  bmr: {
    reaches: false,
    reason:
      "Charted from `metric_samples` tracker estimates ONLY. An indirect-calorimetry report's measured BMR is a genuinely clinical reading with no canonical entry, no fold and no projection.",
  },
  "skin-temp": {
    reaches: false,
    reason:
      "An import-only tracker baseline DEVIATION with no canonical entry — nothing folds and nothing projects, so an imported row would be lost.",
  },
  "lean-mass": {
    reaches: false,
    reason:
      "Charted from `metric_samples` scale estimates. The curated body-composition entry is the Appendicular Lean Mass INDEX, a different quantity, so there is no identity to fold through.",
  },
  "bone-mass": {
    reaches: false,
    reason:
      "Charted from `metric_samples` scale estimates, with no canonical entry to fold a DXA-reported value through.",
  },
  hr: {
    reaches: false,
    reason:
      "A DAILY AVERAGE derived from `hr_minutes` — it has no reading rows at all, and a measured heart rate is a different quantity (the #482 exclusion METRIC_KNOWLEDGE.hr already states).",
  },
  sun: {
    reaches: false,
    reason:
      "Derived from activities against the solar day; there is no reading of it to import and nothing an imported row could join.",
  },
  steps: {
    reaches: false,
    reason:
      "An activity COUNT charted from `metric_samples`, with no canonical entry and no projection.",
  },
  "active-calories": {
    reaches: false,
    reason:
      "An activity COUNT charted from `metric_samples`, with no canonical entry and no projection.",
  },
  calories: {
    reaches: false,
    reason:
      "An intake TOTAL charted from `metric_samples`, with no canonical entry and no projection.",
  },
  hydration: {
    reaches: false,
    reason:
      "An intake TOTAL charted from `metric_samples`, with no canonical entry and no projection.",
  },
  mood: {
    reaches: false,
    reason:
      "The daily check-in's own store, which only the check-in writes — an imported row could never join it.",
  },
  energy: {
    reaches: false,
    reason:
      "The daily check-in's own store, which only the check-in writes — an imported row could never join it.",
  },
  calm: {
    reaches: false,
    reason:
      "The daily check-in's own store, which only the check-in writes — an imported row could never join it.",
  },
};

/**
 * Every name the metric registry knows a quantity by — the three sources above — or
 * NOTHING when an imported reading of it cannot reach its chart, because a slug that
 * cannot receive the reading has not earned the right to remove it from the catalog.
 */
function registryNamesFor(slug: BodyMetricSlug): string[] {
  if (METRIC_DOCUMENT_REACH[slug].reaches === false) return [];
  const meta = BODY_METRIC_META[slug];
  const knowledge = METRIC_KNOWLEDGE[slug];
  const names = [meta.title];
  if ("canonical" in knowledge) names.push(knowledge.canonical);
  if (looksLikeAbbreviation(meta.label)) names.push(meta.label);
  return names;
}

// normalized name key -> the slug that is its home. Built once, first registration
// wins; the pure test pins that no key is claimed by two different slugs, so "first
// wins" is a guard against a future collision rather than a silent tie-break.
const HOME_BY_KEY: ReadonlyMap<string, BodyMetricSlug> = (() => {
  const map = new Map<string, BodyMetricSlug>();
  for (const slug of BODY_METRIC_SLUGS) {
    for (const name of registryNamesFor(slug)) {
      const key = normalizeCanonicalKey(name);
      if (key && !map.has(key)) map.set(key, slug);
    }
  }
  return map;
})();

/**
 * The metric slug that is this analyte's home, or null when nothing charts it.
 *
 * The name is tried as written and — when it is written "Full Name (ABBR)" — as the
 * spellings that derivation yields, so a document's "Body Mass Index (BMI)" and the
 * registry's "Body Mass Index" are one quantity.
 */
export function bodyMetricHomeFor(
  name: string | null | undefined
): BodyMetricSlug | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;
  for (const form of [raw, ...acronymNameForms(raw)]) {
    const slug = HOME_BY_KEY.get(normalizeCanonicalKey(form));
    if (slug) return slug;
  }
  return null;
}

/** Whether some registered body metric already charts this quantity. */
export function hasBodyMetricHome(name: string | null | undefined): boolean {
  return bodyMetricHomeFor(name) !== null;
}

/**
 * Whether the flat Biomarkers browser lists this analyte — the ONE place the question
 * is asked, so the rows the gather returns and the panels the facet offers can never
 * disagree about what "listed" means.
 *
 * The identity checked is the one the table itself renders and SQL groups on
 * (`biomarkerNameKey`: the canonical name when the vocabulary recognized the row,
 * otherwise the name the source printed).
 */
export function listedInBiomarkerBrowser(row: {
  category?: string | null;
  canonical_name?: string | null;
  name?: string | null;
}): boolean {
  if ((row.category ?? "") !== HOMED_ANALYTE_CATEGORY) return true;
  const identity = row.canonical_name?.trim() || row.name;
  return !hasBodyMetricHome(identity);
}
