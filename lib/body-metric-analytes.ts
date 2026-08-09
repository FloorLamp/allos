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
// A MISPLACED ROW IS A PLACEMENT BUG, NOT A CATALOG PROBLEM. Most of what leaves has a
// twin on the very chart that answers for it: the import path already projects a
// document's weight / body fat / resting HR into `body_metrics` and its height / head
// circumference into `metric_samples`, and the five vitals that store as observations
// are charted from `medical_records` directly. "Body Mass Index (BMI)" arriving as a
// `medical_records` row is #2318's misplacement — under this rule it stops being
// browsable for the RIGHT reason (the quantity has a home), independent of whether that
// placement is fixed; `/trends/metric/bmi` computes the same quantity from the weight
// and height that came in beside it. `Waist Circumference` is a body metric by the
// owner's ruling on #2322 but is NOT yet a slug, so it stays browsable today and leaves
// on its own the moment that slug lands. This module answers only "does the QUANTITY
// have a home"; which store a given row went to is `placeReading()`'s question.
//
// PURE: registries and string keys, no DB, no React.

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

/** Every name the metric registry knows a quantity by — the three sources above. */
function registryNamesFor(slug: BodyMetricSlug): string[] {
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
