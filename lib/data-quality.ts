// Structural data-quality gaps (issue #1045). PURE, no DB/network.
//
// Dozens of engines silently degrade on a missing STRUCTURAL input — no birthdate
// hides every adult-population model (#494), an unset sex darkens sex-gated
// screenings and ranges, a name-only medication (no confirmed RxCUI) drops to
// name-only safety matching (#1032), a `failed` extraction contributes nothing. Each
// degradation is today invisible or scattered, and nothing tells the user WHAT turns
// on when they fix one. This module is the ONE gap model many surfaces format (the
// #221 "one question, one computation" rule): pure detectors over already-gathered
// inputs, each producing a typed gap whose whyLine NAMES the degraded consumer(s) and
// whose `leverage` (count of consumers unblocked) drives ranking.
//
// HARD SCOPE BOUNDARY — structural, ONE-TIME gaps ONLY. A gap is "set a field, confirm
// a match, reprocess a failed document": completable, and gone for good once fixed.
// This is NEVER behavioral/recurring nagging ("log more weigh-ins", "track your
// mood") — recurring-behavior prompts are the notification tiers' job. A detector only
// ships when the unlocked consumer is REAL and NAMEABLE; no speculative "complete your
// profile" filler. New detectors extend the table below, they never lower this bar.
//
// The detectors are pure functions of a gathered `DataQualityInputs` snapshot; the DB
// seam (lib/rule-findings buildDataQualityFindings) gathers the inputs and maps the
// gaps into the shared Finding envelope, and every surface (dashboard widget, coaching
// findings, household rollup) is a thin formatter over these results.

import { dataSectionHref, MEDICATIONS_HREF, type AppRoute } from "./hrefs";
import { isAdultForClinical } from "./life-stage";

// The dedupeKey namespace every data-quality finding keys under (registered in
// lib/rule-finding-prefixes). Kept here so the pure model owns its own identity.
export const DATA_QUALITY_PREFIX = "data-quality:";

// The stable key for one gap key → its bus dedupeKey. A dismiss under it silences the
// gap on BOTH the dashboard widget and the coaching surface (dismiss once, silence
// everywhere) — and, because it's keyed on the gap TYPE (not a row id), the dismissal
// naturally clears the day the field is filled (the gap stops firing, so it's no
// longer even offered — the "structural, gone-for-good" contract).
export function dataQualityDedupeKey(key: DataQualityGapKey): string {
  return `${DATA_QUALITY_PREFIX}${key}`;
}

// The perimenopausal-transition floor (whole years) at/above which an unset
// reproductive status is a real gap for a female profile: below it the age proxy is a
// safe default, but from ~45 on a woman may be pre- OR post-menopausal, and only an
// explicit status resolves the female-hormone reference ranges (the FSH false-flag
// rationale documented on getUserReproductiveStatus / types/medical.ts). This is the
// "female + age-band" gate the issue names.
export const REPRODUCTIVE_STATUS_BAND_MIN_AGE = 45;

// The pediatric age ceiling (whole years) below which a missing height blocks the
// pediatric blood-pressure percentile engine (AAP percentiles are height-indexed; the
// switch to adult static thresholds is at 13 — lib/life-stage PEDIATRIC_BP_MAX_AGE).
export const PEDIATRIC_HEIGHT_MAX_AGE = 13;

export type DataQualityGapKey =
  | "birthdate"
  | "sex"
  | "reproductive-status"
  | "pediatric-height"
  | "smoking-status"
  | "med-rxcui"
  | "prescriber-link"
  | "phenoage-inputs"
  | "failed-extractions"
  | "risk-attributes";

// One structural gap. `leverage` is the COUNT of consumers this fix unblocks — it
// drives ranking (birthdate first, ~6 engines), and it is exactly the number of
// consumers named in `whyLine`, so the rank and the copy can never disagree.
export interface DataQualityGap {
  key: DataQualityGapKey;
  // Short imperative label ("Set a birthdate").
  label: string;
  // Cite-your-consumer: names WHAT turns on when the gap is fixed.
  whyLine: string;
  // An EXISTING explicit-entry surface (never an auto-fix): Settings/Profile, the
  // #851 RxCUI confirm form, Data → reprocess.
  ctaHref: AppRoute;
  leverage: number;
}

// The gathered snapshot the detectors read. Booleans/counts only — every DB/settings
// read happens at the builder boundary, so the detectors stay pure and unit-testable.
export interface DataQualityInputs {
  // Age in whole years, or null when UNKNOWN (neither a birthdate nor a stored age
  // fallback is on file). The #494 null policy: an unknown age hides every
  // adult-population model, so it's the highest-leverage structural gap.
  age: number | null;
  // Whether the profile's biological sex is recorded.
  sexKnown: boolean;
  // "female" | "male" | null — needed for the female-only reproductive gate.
  sex: "female" | "male" | null;
  // Whether an explicit reproductive (menopausal) status is recorded.
  reproductiveStatusKnown: boolean;
  // Whether the profile has ANY recorded height reading (a height_cm sample).
  heightKnown: boolean;
  // Whether smoking status is resolvable (a structured record OR an imported
  // social-history smoking condition) — the tri-state the lung/AAA gates need.
  smokingKnown: boolean;
  // Count of ACTIVE medications with no confirmed RxCUI (name-only safety matching).
  medsMissingRxcui: number;
  // Count of medications with a free-text prescriber that near-misses an individual
  // provider (or matches an org-only row) but isn't linked (#1051). The exact backfill
  // can't claim these — a suggest-and-accept correction unlocks provider-centric views
  // and #1050's strong-tier visit suggestions.
  prescribersNeedingLink: number;
  // PhenoAge input completeness (reuses lib/bio-age — never a second computation):
  // how many of the nine analytes are present, and how many are still missing.
  phenoAgePresentCount: number;
  phenoAgeMissingCount: number;
  // Count of `failed`-extraction documents (imported but contributing nothing).
  failedExtractions: number;
  // Whether the self-declared risk attributes have ever been reviewed.
  riskAttributesReviewed: boolean;
}

// ── Detectors ─────────────────────────────────────────────────────────────────
// Each returns the gap when it fires, else null. A detector fires ONLY when the
// unlocked consumer is real for THIS profile (age/sex-gated where the consumer is),
// so a gap is never noise on a profile the consumer can't apply to.

function birthdateGap(i: DataQualityInputs): DataQualityGap | null {
  // The #494 gap: fire when age is UNKNOWN (no birthdate AND no stored age). A stored
  // age already unblocks the age-gated consumers, so an exact-birthdate refinement is
  // not a structural gap — only a genuinely unknown age is.
  if (i.age != null) return null;
  return {
    key: "birthdate",
    label: "Set a birthdate",
    whyLine:
      "Unlocks biological age, fitness percentiles, eGFR, strength standing, " +
      "age-based screening reminders, and life-stage-aware presentation.",
    ctaHref: "/settings/profile",
    leverage: 6,
  };
}

function sexGap(i: DataQualityInputs): DataQualityGap | null {
  if (i.sexKnown) return null;
  return {
    key: "sex",
    label: "Set a biological sex",
    whyLine:
      "Unlocks sex-gated screenings, sex-specific reference ranges, and cycle " +
      "relevance.",
    ctaHref: "/settings/profile",
    leverage: 3,
  };
}

function reproductiveStatusGap(i: DataQualityInputs): DataQualityGap | null {
  // Female-only, and only in the perimenopausal-and-up band where the age proxy is
  // ambiguous. Below the band the proxy is a safe default (not a gap); a male
  // profile's hormone ranges are unaffected regardless (never fire).
  if (i.sex !== "female" || i.age == null) return null;
  if (i.age < REPRODUCTIVE_STATUS_BAND_MIN_AGE) return null;
  if (i.reproductiveStatusKnown) return null;
  return {
    key: "reproductive-status",
    label: "Set reproductive status",
    whyLine:
      "Unlocks correct female-hormone reference ranges (Estradiol / FSH / LH) " +
      "instead of the age proxy.",
    ctaHref: "/settings/profile",
    leverage: 1,
  };
}

function pediatricHeightGap(i: DataQualityInputs): DataQualityGap | null {
  // Pediatric only (age < 13, the height-indexed BP-percentile regime) and only when
  // no height is on file. An unknown age never fires this (the birthdate gap covers
  // it) — hide on a positive under-age match, never on missing data.
  if (i.age == null || i.age >= PEDIATRIC_HEIGHT_MAX_AGE) return null;
  if (i.heightKnown) return null;
  return {
    key: "pediatric-height",
    label: "Add a height",
    whyLine:
      "Unlocks pediatric blood-pressure percentiles (they're height-indexed).",
    ctaHref: "/trends?tab=body",
    leverage: 1,
  };
}

function smokingStatusGap(i: DataQualityInputs): DataQualityGap | null {
  // Adult-only: the lung LDCT / AAA screening gates the status unblocks apply to
  // adults. An unknown or pediatric age never fires this (birthdate gap covers the
  // former; the consumer can't apply to the latter).
  if (!isAdultForClinical(i.age) || i.smokingKnown) return null;
  return {
    key: "smoking-status",
    label: "Record smoking status",
    whyLine:
      "Unlocks the lung-cancer LDCT and abdominal-aortic-aneurysm screening gates.",
    ctaHref: "/records",
    leverage: 2,
  };
}

function medRxcuiGap(i: DataQualityInputs): DataQualityGap | null {
  if (i.medsMissingRxcui <= 0) return null;
  const n = i.medsMissingRxcui;
  const noun = n === 1 ? "medication has" : "medications have";
  return {
    key: "med-rxcui",
    label: `Confirm ${n} RxNorm ${n === 1 ? "match" : "matches"}`,
    whyLine:
      `${n} ${noun} no confirmed RxNorm code, so their interaction, PGx, dental, ` +
      `and ototoxic safety checks match by name only.`,
    // The #851 confirm flow lives on the medication edit form (#1032's limited-
    // coverage chip points at the same place).
    ctaHref: MEDICATIONS_HREF,
    leverage: 4,
  };
}

function prescriberLinkGap(i: DataQualityInputs): DataQualityGap | null {
  if (i.prescribersNeedingLink <= 0) return null;
  const n = i.prescribersNeedingLink;
  const noun = n === 1 ? "medication's prescriber" : "medications' prescribers";
  return {
    key: "prescriber-link",
    label: `Link ${n} ${n === 1 ? "prescriber" : "prescribers"}`,
    whyLine:
      `${n} ${noun} ${n === 1 ? "is" : "are"} recorded as free text with a ` +
      `likely registry match — linking unlocks provider-centric views, propagates ` +
      `renames/merges, and strengthens visit-link suggestions.`,
    // The link is confirmed per-med on the medications surface.
    ctaHref: MEDICATIONS_HREF,
    leverage: 2,
  };
}

function phenoAgeGap(i: DataQualityInputs): DataQualityGap | null {
  // Adult-only (PhenoAge is an adult population model), and only the PARTIAL-panel
  // state — at least one of the nine inputs present but not all. A labs-empty profile
  // is not nagged (no inputs present → nothing to complete); a complete panel has no
  // gap. This mirrors the bio-age card's "checklist" surface exactly (#209), never a
  // second completeness computation.
  if (!isAdultForClinical(i.age)) return null;
  if (i.phenoAgePresentCount <= 0 || i.phenoAgeMissingCount <= 0) return null;
  const total = i.phenoAgePresentCount + i.phenoAgeMissingCount;
  return {
    key: "phenoage-inputs",
    label: "Complete the PhenoAge panel",
    whyLine:
      `${i.phenoAgePresentCount} of ${total} biological-age inputs are present — ` +
      `the remaining labs unlock your biological age.`,
    ctaHref: dataSectionHref("import"),
    leverage: 1,
  };
}

function failedExtractionsGap(i: DataQualityInputs): DataQualityGap | null {
  if (i.failedExtractions <= 0) return null;
  const n = i.failedExtractions;
  const noun = n === 1 ? "document" : "documents";
  return {
    key: "failed-extractions",
    label: `Reprocess ${n} failed ${noun}`,
    whyLine:
      `${n} uploaded ${noun} failed extraction — reprocessing unlocks everything ` +
      `${n === 1 ? "it" : "they"} would contribute.`,
    ctaHref: dataSectionHref("review"),
    leverage: 1,
  };
}

function riskAttributesGap(i: DataQualityInputs): DataQualityGap | null {
  // Adult-only: the risk-stratified screening cadence the review feeds is an adult
  // concern. Fires until the self-declared risk attributes have been reviewed once.
  if (!isAdultForClinical(i.age) || i.riskAttributesReviewed) return null;
  return {
    key: "risk-attributes",
    label: "Review risk factors",
    whyLine:
      "Unlocks risk-stratified screening cadence (occupational and immune-status " +
      "context).",
    ctaHref: "/records",
    leverage: 1,
  };
}

// The fixed detector order — the stable tie-break within a leverage tier.
const DETECTORS: ((i: DataQualityInputs) => DataQualityGap | null)[] = [
  birthdateGap,
  medRxcuiGap,
  prescriberLinkGap,
  sexGap,
  smokingStatusGap,
  reproductiveStatusGap,
  pediatricHeightGap,
  phenoAgeGap,
  failedExtractionsGap,
  riskAttributesGap,
];

// Every structural gap for a gathered snapshot, ranked by leverage DESCENDING (the
// count of consumers each fix unblocks), ties broken by the fixed detector order
// above. A structurally-complete profile yields [] regardless of logging behavior —
// the boundary the pure test pins. Deterministic and pure.
export function detectDataQualityGaps(
  inputs: DataQualityInputs
): DataQualityGap[] {
  const gaps = DETECTORS.map((d) => d(inputs)).filter(
    (g): g is DataQualityGap => g !== null
  );
  // Stable sort by leverage desc — JS sort is stable, so equal-leverage gaps keep
  // their DETECTORS order.
  return gaps.sort((a, b) => b.leverage - a.leverage);
}

// ── Household rollup formatter ──────────────────────────────────────────────────

// A compact one-line gaps summary for a household member card (the householdSickLine
// pattern): the top gap's short label plus the remaining count, or null when the
// member has no gaps. Reuses the SAME ranked gap model — never a second derivation.
// e.g. "No birthdate — bio-age & screenings off" / "3 data gaps — birthdate, sex, …".
export function householdDataQualityLine(
  gaps: readonly DataQualityGap[]
): string | null {
  if (gaps.length === 0) return null;
  const [top, ...rest] = gaps;
  if (rest.length === 0) return top.label;
  const names = gaps.map((g) => shortGapNoun(g.key));
  return `${gaps.length} data gaps — ${names.join(", ")}`;
}

// A terse noun for the compact household list ("birthdate", "sex", …).
function shortGapNoun(key: DataQualityGapKey): string {
  switch (key) {
    case "birthdate":
      return "birthdate";
    case "sex":
      return "sex";
    case "reproductive-status":
      return "reproductive status";
    case "pediatric-height":
      return "height";
    case "smoking-status":
      return "smoking status";
    case "med-rxcui":
      return "RxNorm codes";
    case "prescriber-link":
      return "prescriber links";
    case "phenoage-inputs":
      return "bio-age labs";
    case "failed-extractions":
      return "failed docs";
    case "risk-attributes":
      return "risk factors";
  }
}
