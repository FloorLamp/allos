// ONE JUDGEMENT LOOKUP, KEYED BY IDENTITY (#1996).
//
// THE DEFECT. Age bands, optimal bands and direction live in the canonical
// biomarker vocabulary, keyed by biomarker NAME. The metric detail surface is
// keyed by `TrendMetricSlug`. Nothing mapped one to the other, so a streamed
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
// metric-judgment.test.ts` asserts every `TrendMetricSlug` has an entry, so "audit
// whether another metric has this shape" is a build failure instead of a recurring
// manual sweep — the sweep that would have caught body fat before #1996 was
// written.
//
// AND ITS DOMAIN IS NO LONGER ONE ENUM (#2086). A guard total over `TrendMetricSlug`
// leaves every judged quantity WITHOUT a slug outside the discipline — which is how
// VO₂ max ended up with a canonical entry, curated fitness norms, and nothing in the
// build able to notice whether either reached its readings. `QUANTITY_KNOWLEDGE` and
// `quantityKnowledge()` below widen the domain from "metric slugs" to JUDGED
// QUANTITIES keyed by #482 identity, with the membership boundary written down where
// the declaration is.
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
import type { CyclePhase } from "./cycle";
import { TREND_METRIC_SLUGS, type TrendMetricSlug } from "./trend-metrics";
import type { BiomarkerDirection, ReproductiveStatus, Sex } from "./types";

// Which knowledge system answers for a metric.
//
//   • "canonical"        — a curated canonical entry: reference range, optimal
//                          band, direction, and (where curated) age bands.
//   • "growth-percentile"— a WHO/CDC percentile-for-age, which is not a band and
//                          is rendered by the growth card that owns it. Naming it
//                          here says the knowledge EXISTS and where it lives.
//   • "fitness-norms"    — an age/sex PERCENTILE against the baked population norms
//                          (lib/fitness-norms.ts, #158). Also not a band: a 42
//                          mL/kg/min VO2 max is not "in range", it is a percentile
//                          for a 55-year-old man. Naming it here is what brought the
//                          functional-fitness markers inside the completeness guard
//                          (#2086) instead of leaving them one enum out.
//   • "personal-best"    — a percentage of THIS PROFILE's own recorded best, not a
//                          population range (#1850). Peak expiratory flow is the only
//                          member, and it is the one deliberate divergence from the
//                          three specialty domains that came before it — see the
//                          declaration below, where the argument is written out.
//   • "none"             — no clinical band exists for the quantity. The reason is
//                          mandatory: saying so out loud is the point, and it is
//                          what stops a future metric from silently inheriting
//                          "unjudged" as a default.
export type MetricKnowledge =
  | { source: "canonical"; canonical: string }
  | { source: "growth-percentile"; renderedBy: string }
  | { source: "fitness-norms"; marker: string; renderedBy: string }
  // A SELF-REFERENTIAL band: the verdict is a function of the reading AND a profile
  // fact, so it resolves through neither the canonical vocabulary nor a population
  // dataset. It still names its `canonical` entry, because the quantity has one
  // (unit, direction, identity, the panel it belongs to) — what it does not have is a
  // range. `computedBy` names the ONE pure function that decides, so the registry
  // points at the computation rather than restating its numbers.
  | {
      source: "personal-best";
      canonical: string;
      computedBy: string;
      renderedBy: string;
    }
  | { source: "none"; reason: string };

// The registry. EVERY TrendMetricSlug appears — that is the completeness guard.
export const METRIC_KNOWLEDGE: Record<TrendMetricSlug, MetricKnowledge> = {
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
  // ── THE ONE DIVERGENCE FROM THE THREE SPECIALTY SIBLINGS (#1850) ───────────
  //
  // Audiometry (#713/#1600), periodontal probing (#705) and per-eye tonometry (#697)
  // all reuse the biomarker substrate the same way and are all judged the same way:
  // a curated POPULATION band (≤25 dB HL, ≤3 mm, 10–21 mmHg) that the value alone
  // satisfies or fails, so `reconciledFlag()` derives a flag at ingest and stores it
  // on the row.
  //
  // Peak flow is the fourth domain and it breaks exactly one of those properties.
  // An asthma action plan reads a blow as a percentage of YOUR OWN personal best —
  // green ≥80%, yellow 50–80%, red <50% — so the same 400 L/min is a green day for
  // one adult and a red one for another. Two consequences, both load-bearing:
  //
  //   • THE VERDICT CANNOT BE A STORED FLAG. A flag is written once and re-derived
  //     only when the canonical vocabulary changes; a personal best is a user-owned
  //     fact that moves, and every historical row's verdict moves with it. A stored
  //     one would be silently stale — the #221 defect, in the safety-adjacent place
  //     it matters most.
  //   • SO THE RECONCILIATION PATH IS NOT FORKED. Nothing here teaches
  //     `reconciledFlag` about profile settings. The canonical entry curates NO band
  //     (the honest answer: there is no population range for peak flow), so the flag
  //     engine correctly says nothing, and the zone is computed AT READ by the one
  //     pure `peakFlowZone()` that every surface formats. Adapting at the READ layer
  //     rather than inside the flag engine is what keeps the other three domains —
  //     and every lab analyte — untouched.
  //
  // WITH NO PERSONAL BEST THERE IS NO VERDICT, ever: `peakFlowZone()` returns null
  // and the surface renders the reading bare. Falling back to a population range
  // would be the #482 borrowed-band failure with a green light on someone's red day.
  "peak-flow": {
    source: "personal-best",
    canonical: "Peak Expiratory Flow",
    computedBy: "peakFlowZone() (lib/peak-flow.ts)",
    renderedBy:
      "the peak-flow zone card on the metric detail page (components/PeakFlowZoneCard.tsx)",
  },
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
  // ── WAIST CIRCUMFERENCE: an ARGUED `none`, not an oversight (#2322) ─────────
  //
  // Published thresholds for it certainly exist — the IDF/WHO central-obesity
  // cut-offs — and they are the reason this entry needs an argument rather than a
  // shrug. They are branched on SEX **and on POPULATION**: ≥94 cm / ≥80 cm for
  // European men and women, ≥90 cm / ≥80 cm for South Asian, Chinese and Japanese
  // ones, with further region-specific tables, and the IDF's own text says the
  // ethnic-group value is the one to apply.
  //
  // The curated vocabulary has a SEX axis (`ref_*_male` / `ref_*_female`, the fields
  // #2407 used for Fat Mass Index) and an AGE axis. It has no POPULATION axis, and
  // this repo does not store the subject's ethnicity — nor should it acquire one to
  // hang a band on. Curating the European cut-off would silently judge every profile
  // against one population's threshold and stamp a flag on the row saying so, which
  // is the borrowed-band failure #482 and #2086 both exist to prevent, in a place
  // where the borrowed answer is wrong by a full 4 cm for most of the world.
  //
  // Half a band is not available either: the entry the owner ruled AGAINST creating
  // is the only thing a `canonical` source could name, so `none` is also the only
  // declaration consistent with the ruling. The chart still shows the trend, which is
  // the question the ruling says this quantity is for.
  "waist-circ": {
    source: "none",
    reason:
      "The published cut-offs (IDF/WHO central obesity) are branched by SEX and by POPULATION — ≥94 cm for European men against ≥90 cm for South Asian ones — and the canonical vocabulary has a sex axis but no population axis, so a single curated band would judge every profile against one population's threshold. Per #2322's ruling this is a body metric with no biomarker entry at all, so there is nothing for a range to be curated ON; the trend is the question here.",
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

// ── THE WIDENED COMPLETENESS DOMAIN (issue #2086) ───────────────────────────
//
// The registry above is total over `TrendMetricSlug` — ONE enum. A judged quantity
// outside it escaped the discipline entirely, and the recorded escapee is the whole
// argument: VO₂ max has a curated canonical entry AND age/sex fitness norms, but no
// metric slug, so nothing in the build could notice whether anything judged it. That
// is the pre-#1996 shape (knowledge existing, readings unjudged) recurring one layer
// out — an enum boundary is not a domain boundary.
//
// So the domain is JUDGED QUANTITIES, keyed by #482 identity, and the second half of
// it is declared here: the quantities the app renders a judgement for that have no
// metric slug to hang a declaration on.
//
// THE MEMBERSHIP BOUNDARY, written down (the doctrine question #2085 §2 asks). This is
// NOT a second copy of the canonical vocabulary. An ordinary lab analyte is judged BY
// its canonical row on the surface that reads that row — knowledge and reading arrive
// together, and nothing can go missing. A quantity needs a declaration here exactly
// when its READINGS and its KNOWLEDGE are reached through different keys, so one can
// exist without the other:
//
//   • the metric slugs above — readings keyed by slug, knowledge keyed by canonical
//     name (the #1996 defect);
//   • the functional-fitness markers below — readings keyed by canonical name,
//     knowledge keyed by a separate norms dataset (the #2086 defect).
//
// The enumeration source is the REGISTRIES, never a hand-list:
// `lib/__tests__/judged-quantities.test.ts` derives the domain from
// `TREND_METRIC_SLUGS`, `FITNESS_NORM_MARKERS` and `READING_IDENTITY_MAP`, so a marker
// added to the norms dataset with no declaration here is a build failure.
//
// WIDENING THE GUARD MUST NOT WIDEN THE VOCABULARY (#482). Nothing below invents a
// mapping or borrows a band: every entry names the norms marker that was already
// curated for exactly that quantity, and the surface that already renders it.
export const QUANTITY_KNOWLEDGE: Record<string, MetricKnowledge> = {
  // VO₂ MAX — the acceptance case (#2086, owner ruling 2026-08-05). Its knowledge is
  // the FRIEND registry percentile for the subject's age and sex, and the surface that
  // renders it is the reading detail page's fitness-percentile card (#158) — which is
  // where the #1932 cadence audit puts it and keeps it: an annual-at-best physical test
  // is read against its population curve, not charted as a daily trend.
  //
  // Its curated canonical entry states a single adult optimal FLOOR (≥45 mL/kg/min)
  // with no age or sex banding, which is why the percentile is named here as the
  // knowledge that answers: judging a 70-year-old against an adult-athlete floor is the
  // borrowed-band failure this registry exists to prevent, while the FRIEND curve says
  // what 32 mL/kg/min actually means for her.
  "VO2 Max": {
    source: "fitness-norms",
    marker: "VO2 Max",
    renderedBy:
      "the fitness-percentile card on the reading detail page (components/FitnessPercentile.tsx) and the Longevity fitness pillar",
  },
  // Its three siblings from the same #158 battery. Each has a canonical entry that
  // curates NO band at all — the entry's own note says "interpreted by age/sex
  // percentile, not a fixed cutoff" — so the percentile is not merely the better
  // answer here, it is the only one.
  "Grip Strength": {
    source: "fitness-norms",
    marker: "Grip Strength",
    renderedBy:
      "the fitness-percentile card on the reading detail page (components/FitnessPercentile.tsx)",
  },
  "30-Second Chair Stand": {
    source: "fitness-norms",
    marker: "30-Second Chair Stand",
    renderedBy:
      "the fitness-percentile card on the reading detail page (components/FitnessPercentile.tsx)",
  },
  "Single-Leg Balance": {
    source: "fitness-norms",
    marker: "Single-Leg Balance",
    renderedBy:
      "the fitness-percentile card on the reading detail page (components/FitnessPercentile.tsx)",
  },
  // The Fitness-check battery's remaining norms-tier tests (#834). They carry norms
  // and are scored in the check's own outcome card; they have no canonical entry, so
  // their readings live on the assessment rather than in the clinical record — which
  // is precisely why they need a declaration rather than inheriting one.
  "Max Push-Ups": {
    source: "fitness-norms",
    marker: "Max Push-Ups",
    renderedBy: "the Fitness check's outcome card (/training?tab=fitness)",
  },
  "Sit-and-Reach": {
    source: "fitness-norms",
    marker: "Sit-and-Reach",
    renderedBy: "the Fitness check's outcome card (/training?tab=fitness)",
  },
  "30-Second Arm Curl": {
    source: "fitness-norms",
    marker: "30-Second Arm Curl",
    renderedBy: "the Fitness check's outcome card (/training?tab=fitness)",
  },
  "2-Minute Step": {
    source: "fitness-norms",
    marker: "2-Minute Step",
    renderedBy: "the Fitness check's outcome card (/training?tab=fitness)",
  },
  "Timed Up-and-Go": {
    source: "fitness-norms",
    marker: "Timed Up-and-Go",
    renderedBy: "the Fitness check's outcome card (/training?tab=fitness)",
  },
};

// Every judged quantity's knowledge, keyed by #482 IDENTITY — the two halves folded
// into the one lookup a surface makes whatever key its readings arrived under.
//
// A slug whose knowledge is `none` or `growth-percentile` contributes nothing: it has
// no canonical identity by construction (that is what `none` MEANS here, and the growth
// charts are keyed by measurement, not by a biomarker name).
const KNOWLEDGE_BY_IDENTITY = new Map<string, MetricKnowledge>([
  ...Object.values(METRIC_KNOWLEDGE).flatMap((k) =>
    // Both the sources that NAME a canonical entry. A `personal-best` quantity has a
    // real identity (that is how its readings resolve a unit, a panel and a
    // placement); what it lacks is a range. Leaving it out here would make the
    // completeness guard report it as a quantity nobody declared knowledge for —
    // exactly backwards, since it is the one whose knowledge is argued at length.
    k.source === "canonical" || k.source === "personal-best"
      ? ([[readingIdentity(k.canonical).toLowerCase(), k]] as const)
      : []
  ),
  ...Object.entries(QUANTITY_KNOWLEDGE).map(
    ([name, k]) => [readingIdentity(name).toLowerCase(), k] as const
  ),
]);

/**
 * The knowledge system that answers for an identity, or null when no registered
 * quantity claims it.
 *
 * Null is NOT "unjudged": most identities are ordinary lab analytes judged by their
 * own canonical row on the surface that reads it (see the membership boundary above).
 * This answers the narrower question the completeness guard is about — which of the
 * quantities whose readings and knowledge are reached through DIFFERENT keys is this,
 * and which system was declared for it.
 */
export function quantityKnowledge(
  identity: string | null | undefined
): MetricKnowledge | null {
  const key = readingIdentity(identity ?? "").toLowerCase();
  return key ? (KNOWLEDGE_BY_IDENTITY.get(key) ?? null) : null;
}

/** Every identity the widened completeness domain covers, for the guards. */
export const JUDGED_QUANTITY_IDENTITIES: readonly string[] = [
  ...KNOWLEDGE_BY_IDENTITY.keys(),
];

/**
 * The metric slugs that resolve to a canonical IDENTITY, for the sweeps.
 *
 * "Identity", not "band": a `personal-best` metric belongs here because it names a
 * canonical entry and therefore has a placement, a unit and a panel — the facts the
 * sweeps check. Whether a RANGE resolves is a separate question each sweep asks for
 * itself (the placement table pins where its readings land; the judgement test skips
 * it, because there is deliberately no band to name).
 */
export const JUDGED_METRIC_SLUGS: TrendMetricSlug[] = TREND_METRIC_SLUGS.filter(
  (slug) => metricIdentity(slug) != null
);

/**
 * The #482 identity a metric's readings carry, or null when the metric has no
 * canonical identity (which is most of the stream vocabulary — see the registry).
 */
export function metricIdentity(slug: TrendMetricSlug): string | null {
  const knowledge = METRIC_KNOWLEDGE[slug];
  return knowledge.source === "canonical" ||
    knowledge.source === "personal-best"
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
  slug: TrendMetricSlug
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
  /**
   * The subject's menstrual-cycle phase ON the reading's date (#718), when the
   * cycle log covers it. It is the HIGHEST-precedence axis in `referenceRange` —
   * above the coarse reproductive-status proxy and above the age band — so a
   * mid-luteal progesterone is read against its luteal range. Threading it here is
   * what lets a row STATE the band its stored flag came from: `reconciledFlag`
   * already takes the phase, so a judgement that could not would answer the same
   * reading with a different band, which is precisely the #2315 defect one level
   * down. Absent/null → unchanged behavior for every caller that has no cycle log.
   */
  cyclePhase?: CyclePhase | null;
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
// (`CanonicalResultDefinition`, which carries every column). One judgement, two
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
  const ref = referenceRange(
    entry,
    subject.sex,
    subject.age,
    subject.status,
    subject.cyclePhase
  );
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
      subject.status,
      subject.cyclePhase
    ),
    knowledge: "canonical",
  };
}

/**
 * The judgement for a metric SLUG — the registry lookup composed with the identity
 * one, so a surface keyed by slug asks exactly one question.
 */
export function metricJudgmentForSlug(
  slug: TrendMetricSlug,
  subject: JudgmentSubject = {},
  entries?: readonly JudgmentEntry[]
): MetricJudgment | null {
  const identity = metricIdentity(slug);
  return identity ? metricJudgment(identity, subject, entries) : null;
}
