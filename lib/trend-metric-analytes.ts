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
// `TrendMetricSlug` is not listed in the flat browser; one that does not, stays. That
// KEEPS #1076's rule rather than overriding it — nothing is stranded, because
// membership is now decided by WHETHER A HOME EXISTS rather than by which category the
// quantity happens to be filed under.
//
// DERIVED, NEVER HAND-LISTED. The two registries that already answer it are the only
// inputs:
//
//   • `TREND_METRIC_SLUGS` / `TREND_METRIC_META` (lib/trend-metrics.ts) — the ONE
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
// touch nothing at all. lib/__tests__/trend-metric-analytes.test.ts asserts BOTH
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
// `TrendMetricSlug`, the `lib/fitness-freshness.ts` precedent). A slug added later has
// to answer the question rather than silently start swallowing document rows — which
// is the same drift-proofing property the name derivation itself is built on.
//
// AND THE DECLARATION IS CHECKED, not trusted. Three of its four "reaches" mechanisms
// are verifiable against the code that implements them, and the tests verify each one
// rather than reading the prose beside it:
//
//   • `observations`      — against the pure reading model (a canonical identity with
//                           NO stream source), in lib/__tests__/trend-metric-analytes;
//                           the DB tier separately cross-checks that this agrees with
//                           `METRIC_READING_STORE`, which lives in a module that opens
//                           the database and so cannot be reached from the pure tier.
//   • `observation-fold`  — against `metricObservationFoldIdentity`.
//   • `import-projection` — against the projector's OWN recognizer (`bodyMetricKind` /
//                           `isHeightReading` / `isHeadCircReading`), asked with the
//                           very names the slug claims.
//
//   • `derived-inputs`   — against `derivedInputsMetricFor`, the recognizer the ingest
//                           drop is built on, asked with the names the slug claims.
//
// A declaration that stops being true fails CI.
//
// AND EVERY REACHING ARM NOW RESOLVES THE IMPORTED ROW (#2646). It did not always:
// `derived-inputs` declared reachability and had no ingest consequence at all, so a
// printed BMI survived as a `medical_records` row, an AI import coined an `ai`
// vocabulary name for it, and `getUsedCanonicalNames` returned it forever as a
// Coverage candidate for a quantity this very registry had just declared answered.
// The arm's consequence is a DROP with no projection — see `derivedInputsMetricFor`
// below for why that is the right shape and why it is unconditional. Which slug the
// arm covers is a judgement, and it still has exactly one member, the issue's own
// explicit ruling; what is no longer a judgement is whether a row obeys it.
//
// A MISPLACED ROW IS THEN A PLACEMENT BUG, NOT A CATALOG PROBLEM. "Body Mass Index
// (BMI)" arriving as a `medical_records` row is #2318's misplacement — under this rule
// it stops being browsable for the RIGHT reason (the quantity is answered), independent
// of whether that placement is fixed; `/trends/metric/bmi` computes it from the weight
// and height that came in beside it, and both of those are themselves projected onto
// their own charts. `Waist Circumference` then made the round trip this module was
// built to make cheap: #2322 added the slug AND the projector that carries an imported
// row to its chart, so the analyte left the catalog with NO edit here — the registry
// changed and the derivation followed. This module answers only "is this quantity
// answered elsewhere"; which store a given row went to is `placeReading()`'s question.
//
// CONSEQUENCE MUST SCALE WITH CONFIDENCE (#2678). The `derived-inputs` arm turned a
// recognition this module had always made into a DELETE, and the two are not the same
// bet. The same acronym fuzz that files a row under a slightly wrong home — visible,
// mergeable, recoverable — deletes the row outright once a drop hangs off it, and a
// destination-less drop is the one ingest outcome with no forensic trail. So the fix
// is TIERED, and the tiers are ordered by how much damage a wrong answer does:
//
//   1. `trendMetricHomeFor`, the SHARED recognizer, applies BOTH name rules — the
//      structural one (an acronym may CORROBORATE, never OVERRULE:
//      `acronymOverruledBy`) and the statistic-signifier one
//      (`foreignStatisticSignifier`). Both are derived from the registry, so they also
//      fix the pre-existing cosmetic bug that `listedInResultsCatalog` inherited: a
//      stored BMI percentile stops being hidden from the Results browser by a chart
//      that does not plot percentiles.
//   2. `derivedInputsMetricFor`, the ONE caller whose consequence is deletion, keeps
//      the signifier refusal as an explicit FLOOR of its own — the same function, so
//      the two tiers cannot disagree about one label, but the delete tier's standard
//      stays stated at the delete tier rather than borrowed from a recognizer someone
//      could later relax.
//   3. The drop itself is COUNTED — `withoutDerivedResults` in lib/import-shape.ts
//      reports each one as an `ImportDrop`, so Data → Review can say a document had
//      three printed derived results. Not a tombstone: the drop is by design, and this
//      is only the visibility every other ingest outcome already has.
//
// The failure asymmetry is the whole argument. When recognition is uncertain, the
// failure must land on the side that leaves evidence.
//
// WHY THE SIGNIFIER CHECK MOVED UP TO TIER 1 (#2700). #2678 scoped it to the DROP tier
// on the reading that cosmetic homing can tolerate fuzz a delete cannot. The owner's
// ruling is that this particular consequence is NOT cosmetic: hiding a stored row from
// the flat Results catalog — the only place a reading with no chart of its own is
// browsable — while its one link points at a chart that cannot plot it, is a
// findability defect, not a filing preference. And it landed on exactly the wrong
// spelling: Tier 1's structural rule reaches `Body Mass Index Percentile (BMI%)`
// because there is a full half to consult, and cannot reach a bare `BMI%`, which is
// the shape a paediatric flowsheet prints and the number that matters most for a child
// (raw BMI is close to meaningless at 6 vs 16). So the row #2699 rescued from deletion
// was saved-but-unfindable.
//
// The supersession is NARROW, in the ruling's own words: #2678's principle still
// governs, and nothing about acronym matching loosens or tightens anywhere else. What
// is settled is that catalog invisibility COUNTS as a consequence for this check.
//
// AND THE UNIT IS PART OF A SLUG'S OWN VOCABULARY. Running the check at Tier 1 asks it
// of every homed quantity rather than of `bmi` alone, and two of them are MEASURED in
// percent: `spo2` and `body-fat` both declare `unit: "%"`. In `Body Fat %` the `%` is
// the unit, not a percentile marker, and refusing that label would push a body-fat
// reading out of its own chart's home — the exact defect this change exists to remove,
// in the other direction. So `foreignStatisticSignifier` reads the slug's declared UNIT
// alongside its registered names: a signifier the slug's own vocabulary already carries
// is corroboration, never contradiction. Derived from the registry like everything else
// here, and it discriminates for free — `%` matches the unit `%`, while `percentile`,
// `centile`, `z-score` and `SDS` do not, so `Body Fat Percentile` is still refused.
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
  TREND_METRIC_META,
  TREND_METRIC_SLUGS,
  type TrendMetricSlug,
} from "./trend-metrics";

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
 * Per-slug reachability. TOTAL over `TrendMetricSlug` — a new metric must answer.
 *
 * `reaches: false` is not a defect and needs no fixing: it means the flat catalog is
 * still the right home for that quantity's imported readings, exactly as #1076 left it.
 */
export const METRIC_DOCUMENT_REACH: Record<
  TrendMetricSlug,
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
    projectedBy:
      "bodyMetricKind → body_metrics.weight_kg (lib/body-metric-extract.ts)",
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
  // #2322's slug, and the reason its PR built a projector rather than only a
  // registry entry. Declaring `reaches` is what removes "Waist Circumference" from
  // the flat catalog, so the declaration had to be EARNED: a slug that swallowed the
  // analyte name without a path from an imported row to its chart would delete the
  // reading from the only surface showing it. The projector is the third arm of the
  // same length-measure family as height and head circumference.
  "waist-circ": {
    reaches: "import-projection",
    projectedBy:
      "isWaistCircReading → metric_samples 'waist_circumference_cm' (lib/waist-circ-extract.ts)",
  },

  // ── Derived from inputs that arrive with it ───────────────────────────────────
  // BMI has no row of its own; the chart is a date-paired computation over weight and
  // height. A document that prints a BMI printed the weight and height it came from,
  // and both of those ARE projected — so the quantity is charted from the same import.
  // This is #2318's misplaced row, and the reason it stops being browsable is that the
  // question "what is this person's BMI" is answered, not that the row was tidied away.
  //
  // Its ingest consequence (#2646) is a DROP with no projection, because there is no
  // destination row to project INTO — `derivedInputsMetricFor` below, applied by
  // `withoutDerivedResults` in lib/import-shape.ts, with migration
  // 20260813-bmi-derived-rows retiring what is already on disk.
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
 *
 * Exported for the #2678 generative guard, which decorates every name a
 * `derived-inputs` slug claims with every statistic signifier and requires the result
 * to survive ingest. That guard has to read the SAME list the recognizer does, or the
 * next derived slug inherits a test that quietly covers nothing.
 */
export function registryNamesFor(slug: TrendMetricSlug): string[] {
  if (METRIC_DOCUMENT_REACH[slug].reaches === false) return [];
  const meta = TREND_METRIC_META[slug];
  const knowledge = METRIC_KNOWLEDGE[slug];
  const names = [meta.title];
  if ("canonical" in knowledge) names.push(knowledge.canonical);
  if (looksLikeAbbreviation(meta.label)) names.push(meta.label);
  return names;
}

// normalized name key -> the slug that is its home. Built once, first registration
// wins; the pure test pins that no key is claimed by two different slugs, so "first
// wins" is a guard against a future collision rather than a silent tie-break.
const HOME_BY_KEY: ReadonlyMap<string, TrendMetricSlug> = (() => {
  const map = new Map<string, TrendMetricSlug>();
  for (const slug of TREND_METRIC_SLUGS) {
    for (const name of registryNamesFor(slug)) {
      const key = normalizeCanonicalKey(name);
      if (key && !map.has(key)) map.set(key, slug);
    }
  }
  return map;
})();

// The TOKEN SETS of the names each slug claims — the same three sources, kept as sets
// so the subset question below can be asked of them. Derived from the registry in the
// same pass as HOME_BY_KEY, so the two cannot disagree about what a slug is called.
const KEY_TOKENS_BY_SLUG: ReadonlyMap<TrendMetricSlug, Set<string>[]> = (() => {
  const map = new Map<TrendMetricSlug, Set<string>[]>();
  for (const slug of TREND_METRIC_SLUGS) {
    const sets = registryNamesFor(slug)
      .map((name) => new Set(tokensOf(name)))
      .filter((s) => s.size > 0);
    if (sets.length) map.set(slug, sets);
  }
  return map;
})();

function tokensOf(name: string): string[] {
  return normalizeCanonicalKey(name).split(" ").filter(Boolean);
}

/**
 * AN ACRONYM MAY CORROBORATE, NEVER OVERRULE (#2678) — the structural half.
 *
 * `acronymNameForms` splits "Full Name (ABBR)" and the bare ABBR is tried on its own.
 * That is a lossy compression of the words standing right beside it, and until this
 * gate the compression could outvote its own expansion: "Body Mass Index Percentile
 * (BMI)" matched `bmi` on the acronym, even though the full half says in words that
 * the quantity is a percentile OF a BMI.
 *
 * The rule, derived from the registry and never from a denylist: the bare abbr may
 * vouch for slug S only when NO registered name-key of S is a PROPER SUBSET of the
 * full half's token set. `{body, index, mass}` ⊂ `{body, index, mass, percentile}`
 * means the full half is naming a statistic of S and the leftover tokens say which —
 * a contradiction the acronym does not get to settle.
 *
 * PROPER is load-bearing in both directions. EQUALITY is the ordinary case ("Body Mass
 * Index (BMI)"), which the full form already matched before the abbr is ever tried, and
 * DISJOINTNESS is the corroborating case this must not break: "Índice de Masa Corporal
 * (BMI)" states no contradiction — nothing of S's vocabulary is in it — so the acronym
 * is the only evidence there is and it still matches. "Resting HR (RHR)" is untouched
 * for the same reason.
 */
function acronymOverruledBy(slug: TrendMetricSlug, fullHalf: string): boolean {
  const fullTokens = new Set(tokensOf(fullHalf));
  if (fullTokens.size === 0) return false;
  for (const keyTokens of KEY_TOKENS_BY_SLUG.get(slug) ?? []) {
    if (keyTokens.size >= fullTokens.size) continue; // proper subset only
    let contained = true;
    for (const t of keyTokens)
      if (!fullTokens.has(t)) {
        contained = false;
        break;
      }
    if (contained) return true;
  }
  return false;
}

/**
 * A word or mark that says a label names a STATISTIC OF a quantity rather than the
 * quantity (#2678, at Tier 1 since #2700). Deliberately small and curated, each entry
 * carrying the reason it earns a place, in the glyph-registry style.
 *
 * Matched against the ORIGINAL spelling, before `normalizeCanonicalKey` folds case,
 * word order and punctuation away, because for the `%` entry the punctuation IS the
 * signifier.
 */
export interface StatisticSignifier {
  /** How the signifier is written, for the reason line and for tests to enumerate. */
  readonly token: string;
  /** What recognizes it in an original spelling. No `g` flag — these are reused. */
  readonly pattern: RegExp;
  /** Why this marks a statistic OF the quantity rather than the quantity itself. */
  readonly reason: string;
}

export const STATISTIC_SIGNIFIERS: readonly StatisticSignifier[] = [
  {
    token: "%",
    pattern: /%/,
    reason:
      "The percentile marker a paediatric flowsheet prints bare (`BMI%`, `BMI %`). normalizeCanonicalKey strips every non-alphanumeric, so it is erased before any key exists — no token set, and no full half for the structural rule to consult. This entry is the only thing standing between that spelling and a delete.",
  },
  {
    token: "percentile",
    pattern: /\bpercentiles?\b/i,
    reason:
      "The spelled-out age/sex rank — LOINC 59574-4 is `Body mass index (BMI) [Percentile]`, a different quantity from BMI's own 39156-5. A rank is not the measurement it ranks, and for a child it is the clinically meaningful number.",
  },
  {
    token: "centile",
    pattern: /\bcentiles?\b/i,
    reason:
      "The UK/WHO growth-chart spelling of the same statistic. Listed separately because `\\bcentile\\b` does not match inside `percentile` — neither entry covers the other.",
  },
  {
    token: "z-score",
    pattern: /\bz[\s-]?scores?\b/i,
    reason:
      "Standard deviations from the reference mean — a normalised position on a growth curve. Shares nothing with the measurement's own scale or units.",
  },
  {
    token: "SDS",
    pattern: /\bsds\b/i,
    reason:
      "Standard Deviation Score: the paediatric-endocrinology abbreviation for the z-score above, and the form a growth-clinic report actually prints.",
  },
];

/**
 * The first statistic signifier `label` carries that `slug`'s OWN VOCABULARY does not,
 * or null. The second half is what keeps the list from refusing a quantity that is
 * honestly named — or honestly MEASURED — after a statistic: if a slug's registry title
 * said "percentile", a label saying so would be agreeing with it, not contradicting it.
 *
 * The slug's vocabulary is its registered names AND its declared UNIT. The unit half
 * matters from #2700, when this check started running at Tier 1 for every homed
 * quantity rather than for `bmi` alone: `spo2` and `body-fat` are MEASURED in percent,
 * so in "Body Fat %" the `%` is the unit and the label is the quantity. Without it, the
 * fix for the paediatric percentile would have evicted a body-fat reading from the
 * chart that plots it — the same findability defect, pointed the other way. It
 * discriminates for free rather than by exception: `%` matches the unit `%`, while
 * `percentile`, `centile`, `z-score` and `SDS` match no unit any metric declares, so
 * "Body Fat Percentile" is still refused.
 */
function foreignStatisticSignifier(
  slug: TrendMetricSlug,
  label: string
): StatisticSignifier | null {
  const vocabulary = [...registryNamesFor(slug), TREND_METRIC_META[slug].unit];
  for (const sig of STATISTIC_SIGNIFIERS) {
    if (!sig.pattern.test(label)) continue;
    if (vocabulary.some((n) => sig.pattern.test(n))) continue;
    return sig;
  }
  return null;
}

/**
 * The metric slug that is this analyte's home, or null when nothing charts it.
 *
 * The name is tried as written and — when it is written "Full Name (ABBR)" — as the
 * spellings that derivation yields, so a document's "Body Mass Index (BMI)" and the
 * registry's "Body Mass Index" are one quantity. The bare acronym is the WEAKEST of
 * the three and is tried last, under `acronymOverruledBy`.
 *
 * Whichever of the three spellings matched, the ORIGINAL label is then held to
 * `foreignStatisticSignifier` (#2700): a key match says the tokens agree, and a
 * signifier the slug's own vocabulary lacks says the label is naming a STATISTIC of
 * that quantity — which normalization has already thrown away by the time any key
 * exists. `BMI%` matches the `bmi` key and is still not a BMI.
 */
export function trendMetricHomeFor(
  name: string | null | undefined
): TrendMetricSlug | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;
  const slug = matchedHomeFor(raw);
  if (!slug) return null;
  return foreignStatisticSignifier(slug, raw) ? null : slug;
}

/** The slug whose registered keys this label MATCHES, before the signifier check. */
function matchedHomeFor(raw: string): TrendMetricSlug | null {
  const asWritten = HOME_BY_KEY.get(normalizeCanonicalKey(raw));
  if (asWritten) return asWritten;
  const forms = acronymNameForms(raw);
  if (forms.length === 0) return null;
  const [full, abbr] = forms;
  const byFull = HOME_BY_KEY.get(normalizeCanonicalKey(full));
  if (byFull) return byFull;
  const byAbbr = HOME_BY_KEY.get(normalizeCanonicalKey(abbr));
  if (!byAbbr) return null;
  return acronymOverruledBy(byAbbr, full) ? null : byAbbr;
}

/** Whether some registered trend metric already charts this quantity. */
export function hasTrendMetricHome(name: string | null | undefined): boolean {
  return trendMetricHomeFor(name) !== null;
}

/**
 * The DERIVED metric an imported reading of this name is the printed RESULT of, or
 * null — i.e. the `derived-inputs` arm, asked at the door (#2646).
 *
 * THE ARM THAT HAD NO INGEST CONSEQUENCE. Every other REACHING variant resolves the
 * imported `medical_records` row: `observations` keeps it (the row IS the chart
 * point), `observation-fold` keeps it (folded onto the stream by identity), and
 * `import-projection` DROPS it, because a `withoutCaptured*` helper wrote the stream
 * row instead. `derived-inputs` did nothing at all: no projector, no destination, no
 * drop — so the row survived, an AI import coined a `canonical_biomarkers` name for
 * it, and `getUsedCanonicalNames` returned it forever as a Coverage candidate for a
 * quantity the app already answers on a chart.
 *
 * The consequence here is a DROP WITH NO PROJECTION, because there is no destination
 * row to move to: the chart is a computation over inputs that arrive in the same
 * document and are themselves projected. It is UNCONDITIONAL. A document that
 * measured the inputs gives the derivation everything it needs, and a document that
 * did NOT is echoing a chart value carried forward from an earlier visit (the #2646
 * evidence: an identical BMI to two decimals six days apart, and a FLAT BMI two
 * months later for a growing toddler) — so a printed result is never independent
 * evidence either way. Same argument shape as EGFR_RACE_BRANCHED: the reported value
 * is superseded by a derivation the app trusts more.
 *
 * Derived from `METRIC_DOCUMENT_REACH` rather than from a second list, so this cannot
 * disagree with the declaration it implements, and a second `derived-inputs` slug
 * gets the ingest arm with no edit at the door.
 *
 * NAME AND CANONICAL ONLY, never LOINC. "Body Mass Index Percentile" (LOINC 59574-4)
 * is a DIFFERENT quantity from BMI (LOINC 39156-5) and shares its stem, so a code
 * axis would need its own negative list; the name axis separates them for free,
 * because a percentile's token set is not a BMI's.
 *
 * THE SIGNIFIER REFUSAL IS STATED HERE, AND IS NOW ALSO TIER 1's (#2678, #2700). This
 * is still the only caller whose consequence is DELETION, so its standard is written at
 * the delete tier rather than borrowed: the line below is a FLOOR, not an increment.
 * Since #2700 `trendMetricHomeFor` applies the very same function — the owner's ruling
 * that hiding a stored row from the flat catalog is a consequence too — so today the
 * call is satisfied before it is reached, and that is the point. One function means the
 * two tiers cannot disagree about one label (the standing "one question, one
 * computation" rule); keeping the call means a future relaxation of the shared
 * recognizer cannot quietly loosen what gets DELETED, which is #2678's whole argument.
 */
export function derivedInputsMetricFor(
  name: string | null | undefined
): TrendMetricSlug | null {
  const raw = (name ?? "").trim();
  const slug = trendMetricHomeFor(raw);
  if (!slug) return null;
  if (METRIC_DOCUMENT_REACH[slug].reaches !== "derived-inputs") return null;
  return foreignStatisticSignifier(slug, raw) ? null : slug;
}

/**
 * Whether the flat Results catalog (/results/readings, rendered as Results ›
 * Biomarkers) lists this analyte — the ONE place the question is asked, so the rows
 * the gather returns and the panels the facet offers can never disagree about what
 * "listed" means. The CATALOG axis, one level finer than
 * RESULTS_CATALOG_CATEGORIES; it says nothing about the row's identity (#2479).
 *
 * The identity checked is the one the table itself renders and SQL groups on
 * (`biomarkerNameKey`: the canonical name when the vocabulary recognized the row,
 * otherwise the name the source printed).
 */
export function listedInResultsCatalog(row: {
  category?: string | null;
  canonical_name?: string | null;
  name?: string | null;
}): boolean {
  if ((row.category ?? "") !== HOMED_ANALYTE_CATEGORY) return true;
  const identity = row.canonical_name?.trim() || row.name;
  return !hasTrendMetricHome(identity);
}
