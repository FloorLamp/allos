import type {
  AgeBandedRange,
  BiomarkerDirection,
  CanonicalResultDefinition,
  CyclePhaseRanges,
  MedicalFlag,
  ReproductiveStatus,
  ReproductiveStatusRange,
  ReproductiveStatusRanges,
  Sex,
} from "../types";
import type { CyclePhase } from "../cycle";
import { qualitativeClassForLoinc } from "../biomarker-loinc";
import {
  parseLeadingNumeric,
  parseReferenceRange,
  referenceStatus,
} from "./parsing";
import { isNormalFlag, isOutOfRange } from "./flags";
import { daysBetween, retestIntervalDays } from "./retest";
import { freshnessState, type FreshnessState } from "../freshness";
// --- Durable-immunity antibody titers (issue #516) --------------------------
//
// A documented POSITIVE/immune antibody titer for a vaccine-preventable disease is
// durable evidence of immunity — conceptually like genomics, it isn't a value you
// re-draw on a yearly clock (hepatitis A/B immunity is durable for decades). So an
// immune-positive titer should never nag "retest overdue" on the flat 365-day clock.
// Only the vaccine-preventable durable-immunity titers named in the issue qualify —
// hepatitis A immunity, hepatitis B SURFACE antibody (vaccine immunity), and the MMR +
// varicella IgGs. Infection/exposure markers are DELIBERATELY excluded: hep B surface
// ANTIGEN (active infection) and core antibody (past infection), and hep C / HIV
// antibodies (a positive is disease, not immunity) all keep the normal clock.
export function isDurableImmunityTiter(
  name: string | null | undefined
): boolean {
  const s = (name ?? "").trim().toLowerCase();
  if (!s) return false;
  // Exclude infection/antigen markers first — these are NOT vaccine-immunity titers.
  if (
    /antigen|hbsag|core antibody|core ab|anti-?hbc|hbcab|hepatitis c|\bhcv\b|\bhiv\b/.test(
      s
    )
  )
    return false;
  // Hepatitis A immunity (IgG / total antibody).
  if (
    /hepatitis a\b/.test(s) &&
    /\b(ig[gm]|ab|antibody|immunity|total)\b/.test(s)
  )
    return true;
  if (/\bhav\s*(ab|igg|antibody)\b/.test(s)) return true;
  // Hepatitis B SURFACE antibody (anti-HBs) — vaccine immunity (antigen excluded above).
  if (/hepatitis b surface a|hbs\s*ab|anti-?hbs|hbsab/.test(s)) return true;
  // Measles / Rubeola, Mumps, Rubella IgG.
  if (
    /\b(measles|rubeola|mumps|rubella)\b/.test(s) &&
    /\b(ig[gm]|ab|antibody|immunity|titer|titre)\b/.test(s)
  )
    return true;
  // MMR combined titer.
  if (/\bmmr\b/.test(s) && /\b(titer|titre|igg|immunity|antibody)\b/.test(s))
    return true;
  // Varicella / VZV / chickenpox IgG.
  if (
    /varicella|\bvzv\b|chicken\s?pox/.test(s) &&
    /\b(ig[gm]|ab|antibody|immunity|titer|titre)\b/.test(s)
  )
    return true;
  return false;
}

// The immunity-result fields the durability decision reads: the derived flag, the
// stored value (numeric OR qualitative "Immune"/"Positive"), the freeform notes
// (where a qualitative interpretation is sometimes recorded), and the reference range
// (to judge a numeric titer against its positivity threshold).
export interface ImmunityResult {
  name?: string | null;
  flag?: string | null;
  value?: string | null;
  notes?: string | null;
  reference?: string | null;
  // The reading's stored LOINC, when known — lets the staleness check reach the
  // classifier's deterministic class hint instead of only its name regexes (#910).
  // Without it an immutable attribute whose name the regex misses (Epic's "ABORh
  // Interpretation") keeps getting retest-nudged for a value that cannot change.
  loinc?: string | null;
}

// Qualitative result vocabulary. A negative/equivocal titer legitimately warrants
// follow-up, so it is NOT durable — the negative check runs first because "non-immune"
// / "non-reactive" contain the positive words.
const NEGATIVE_TITER =
  /\b(non[-\s]?immune|not immune|negative|non[-\s]?reactive|not detected|undetected|equivocal|indeterminate|borderline|non[-\s]?protective|susceptible|below|deficient)\b/i;
const POSITIVE_TITER =
  /\b(immune|positive|reactive|detected|present|adequate|protective)\b/i;

// Whether an immunity titer reading is IMMUNE-POSITIVE — the condition on which
// durability turns (issue #516). Conservative: it returns true only on an AFFIRMATIVE
// positivity signal, so an ambiguous/uninterpretable reading keeps the normal retest
// clock rather than being silently exempted. Signals, in order:
//   1. a deficient standard flag (low / abnormal / non-optimal-low)      → NOT positive
//   2. a negative qualitative result in flag/value/notes                 → NOT positive
//   3. a positive qualitative result in flag/value/notes                 → positive
//   4. an in-range standard flag (normal / high / non-optimal-high)      → positive
//   5. a numeric value at/above its reference threshold (referenceStatus
//      "in"/"above"; "below" = deficient)                                → positive/NOT
//   6. no positivity signal at all                                       → NOT positive
export function isImmunePositiveResult(r: ImmunityResult): boolean {
  const flag = (r.flag ?? "").trim().toLowerCase();
  const value = r.value ?? "";
  const notes = r.notes ?? "";

  // 1 — a standard reference/optimal flag saying the value is deficient.
  if (flag === "low" || flag === "abnormal" || flag === "non-optimal-low")
    return false;
  // 2 — an explicit negative/equivocal qualitative result anywhere.
  if (
    NEGATIVE_TITER.test(flag) ||
    NEGATIVE_TITER.test(value) ||
    NEGATIVE_TITER.test(notes)
  )
    return false;
  // 3 — an explicit positive/immune qualitative result anywhere.
  if (
    POSITIVE_TITER.test(flag) ||
    POSITIVE_TITER.test(value) ||
    POSITIVE_TITER.test(notes)
  )
    return true;
  // 4 — an in-range standard flag (a titer inside its lab range is immune).
  if (flag === "normal" || flag === "high" || flag === "non-optimal-high")
    return true;
  // 5 — a numeric titer judged against a parseable reference threshold.
  const num = Number(String(value).trim());
  const ref = parseReferenceRange(r.reference);
  if (Number.isFinite(num) && ref && (ref.low != null || ref.high != null)) {
    return referenceStatus(num, ref.low, ref.high) !== "below";
  }
  // 6 — nothing affirmative → keep the clock.
  return false;
}

// Whether an immunity titer is BOTH a durable-immunity analyte AND immune-positive —
// the combined condition under which #516 exempts it from staleness. Keyed on
// immune-positive (not just the analyte name) so a negative/equivocal titer keeps its
// retest clock; the at-risk-group revaccination nuance lives in the risk layer
// (lib/risk-stratification.ts), which tightens the clock on the non-exempt readings.
// A positive result satisfies its #482 biomarker family the way a fresh reading does.
export function isDurableImmunePositive(r: ImmunityResult): boolean {
  return isDurableImmunityTiter(r.name) && isImmunePositiveResult(r);
}

// ---------------------------------------------------------------------------
// Qualitative-result classifier (issue #549). The QUALITATIVE mirror of the
// numeric path's parseLooseValue (extract a number) + reconciledFlag (judge it
// against curated ranges). Non-numeric lab values ("Positive", "Reactive", "A+",
// "YELLOW", "e3/e3") have NO shared choke-point, so the extractor's one-shot
// abnormal/normal guess — never reconciled afterward (reconciledFlag bails on both
// `flag === "abnormal"` and `value_num == null`) — drives every surface, wrongly.
// classifyQualitativeResult is that missing choke-point: given the analyte name and
// the reading's value/notes/reference it resolves what the value MEANS, so the flag
// chip, the staleness clock, the notification digest, and the chart timeline agree.
//
// Exclusion discipline — the mirror of the #482 "distinct assays stay apart"
// identity-family rule: the SAME word "positive" means opposite things by class, so
// the CLASS is resolved from the NAME and the PRESENCE from the value/notes vocab —
//   • infection-positive (HBsAg, anti-HBc, HCV, HIV, culture growth) → polarity BAD
//   • immune-positive     (durable-immunity titers, #516)            → polarity GOOD
//   • attribute-positive  (blood type, genotype, urinalysis color…)  → polarity NEUTRAL
// Returns null when neither the name nor the value is recognized — exactly like
// parseLooseValue returning null on a non-numeric string — so callers leave the
// existing extractor/numeric behavior UNTOUCHED rather than guessing (never quiet an
// unrecognized result). It reuses the #516 seeds (isDurableImmunityTiter /
// isImmunePositiveResult / the POSITIVE/NEGATIVE vocab) rather than forking them.
// ---------------------------------------------------------------------------

export type QualitativePresence = "positive" | "negative" | "neutral";

// Infection / active-disease markers — a POSITIVE here is genuinely bad and MUST keep
// flagging (never quieted). Mirrors the exclusion set isDurableImmunityTiter uses to
// hold antigen/infection markers OUT of the immunity family.
const INFECTION_MARKER =
  /antigen|hbsag|core antibody|core ab|anti-?hbc|hbcab|hepatitis c|\bhcv\b|\bhiv\b|\brpr\b|treponema|syphilis|\bvdrl\b|chlamydia|gonorrh|\bculture\b/i;

// Immutable identity attributes — a value that never changes and is never "abnormal":
// blood group/type, Rh factor, and genotype/allele strings (#548 §2).
const IMMUTABLE_ATTRIBUTE =
  /blood\s*(?:type|group)|\babo\b|rh\s*type|rh\s*factor|rh\s*\(?d\)?\b|\bgenotype\b|\ballele\b|\bhaplotype\b/i;

// Context-neutral (but mutable) descriptive attributes — urinalysis color/appearance/
// clarity and morphology "pattern" — neither good nor bad, so never "abnormal" (#548 §1).
const NEUTRAL_ATTRIBUTE =
  /\bcolou?r\b|appearance|clarity|\bpattern\b|morphology/i;

// A culture that GREW something is positive; "no growth" is negative. Small extra
// vocab beyond the titer words, only meaningful on a culture/infection result.
const CULTURE_NEGATIVE = /\bno growth\b|\bnone\b/i;
const CULTURE_POSITIVE = /\bgrowth\b/i;

// Prenatal / genetic risk SCREENS — NIPT trisomy 13/18/21 and the like (#687). A
// screen result is a low/high-RISK call, a genuinely new axis the presence model
// (positive/negative) doesn't express; recognized by NAME when no LOINC hint is
// present. Fetal fraction is DELIBERATELY excluded here (it's a QC metric, matched
// separately by QC_METRIC and checked first) so it never resolves to a risk verdict.
const SCREENING_RISK =
  /\btrisomy\b|\bnipt\b|non[-\s]?invasive prenatal|cell[-\s]?free (?:fetal )?dna|\baneuploid(?:y|ies)?\b|\bt(?:13|18|21)\b|\bpatau\b|\bedwards?\b|down syndrome/i;

// QC metrics that are not a health signal — fetal fraction (the proportion of cell-
// free DNA that is fetal, a run-quality gate on a NIPT draw). Never flags, never
// ranges, never nudges (#687). Checked BEFORE the screen regex so a fetal-fraction
// row (which also mentions cell-free DNA) is exempted rather than risk-classified.
const QC_METRIC = /fetal\s*fraction/i;

// The risk axis a prenatal/genetic screen asserts, from the reading's value + notes.
// Ordered most-specific/neutral first: indeterminate (no-call/inconclusive), then the
// reassuring LOW-risk vocab (which contains "not detected"/"no aneuploidy" that would
// otherwise trip the high-risk words), then HIGH-risk last — the same
// negative-before-positive discipline qualitativePresence uses. Null when nothing
// recognized is said (→ no fabricated verdict, like the presence path).
const SCREEN_INDETERMINATE =
  /\b(indeterminate|inconclusive|no[-\s]?call|no result|not reportable|equivocal|borderline)\b/i;
const SCREEN_LOW_RISK =
  /\b(low[-\s]?risk|screen(?:ing)?[-\s]?negative|not detected|no aneuploid\w*|euploid|reassuring|normal|negative)\b/i;
const SCREEN_HIGH_RISK =
  /\b(high[-\s]?risk|increased risk|at[-\s]?risk|screen(?:ing)?[-\s]?positive|aneuploid|abnormal|detected|positive)\b/i;

export type ScreeningRisk = "low_risk" | "high_risk" | "indeterminate";

export function screeningRisk(
  ...texts: Array<string | null | undefined>
): ScreeningRisk | null {
  const s = texts.filter(Boolean).join(" ").trim();
  if (!s) return null;
  if (SCREEN_INDETERMINATE.test(s)) return "indeterminate";
  if (SCREEN_LOW_RISK.test(s)) return "low_risk";
  if (SCREEN_HIGH_RISK.test(s)) return "high_risk";
  return null;
}

// The presence a qualitative value asserts, from the reading's value + notes, using
// the SAME #516 vocabulary (NEGATIVE checked first — "non-reactive"/"non-immune"
// contain the positive words). Neutral when nothing recognized is said.
export function qualitativePresence(
  ...texts: Array<string | null | undefined>
): QualitativePresence {
  const s = texts.filter(Boolean).join(" ").trim();
  if (!s) return "neutral";
  if (NEGATIVE_TITER.test(s) || CULTURE_NEGATIVE.test(s)) return "negative";
  if (POSITIVE_TITER.test(s) || CULTURE_POSITIVE.test(s)) return "positive";
  return "neutral";
}

export interface QualitativeClassification {
  presence: QualitativePresence;
  // Clinical sense of the presence FOR THIS ANALYTE CLASS: good (reassuring, e.g. an
  // immunity titer that's positive or an infection marker that's negative), bad (an
  // infection marker that's positive), or neutral (an identity/descriptive attribute).
  polarity: "good" | "bad" | "neutral";
  // The value never meaningfully changes (blood type, genotype) → exempt from retest,
  // like genomics + durable immunity already are (#548 §2).
  immutable: boolean;
  // The screening/RISK axis for a prenatal/genetic screen (NIPT trisomy) — a
  // low/high-risk call that presence positive/negative can't express (#687). Present
  // ONLY on a screen-class result; absent (undefined) for every other class, so the
  // non-screen classifications stay byte-identical. High-risk carries polarity "bad"
  // (flags like an infection-positive), low-risk polarity "good" (reassuring, never
  // flags), indeterminate polarity "neutral" (neutral-but-visible).
  risk?: ScreeningRisk;
  // A quality-control metric, not a health signal — fetal fraction (#687). Never
  // flags, never ranges, and (via isBiomarkerStale) never nudges. Absent on every
  // other class.
  qc?: boolean;
}

// A screen-class classification from its resolved risk axis (#687), or null when the
// value asserts no recognizable risk (defer, like the other classes on an ambiguous
// reading — never fabricate a verdict). Shared by the LOINC-hinted and name-based
// screen branches so both yield the identical verdict.
function screenClassification(
  risk: ScreeningRisk | null
): QualitativeClassification | null {
  if (!risk) return null;
  const polarity =
    risk === "high_risk" ? "bad" : risk === "low_risk" ? "good" : "neutral";
  return { presence: "neutral", polarity, immutable: false, risk };
}

export function classifyQualitativeResult(
  name: string | null | undefined,
  value?: string | null,
  notes?: string | null,
  reference?: string | null,
  loinc?: string | null
): QualitativeClassification | null {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return null;
  const presence = qualitativePresence(value, notes);

  // LOINC-hinted class (#684) takes precedence over the name regexes below —
  // deterministic across EHR naming variance (a positive HPV genotype, culture
  // organism, or influenza PCR the name regexes don't recognize still classifies).
  // Falls through to the name-based resolution when the LOINC is unknown. These
  // branches mirror the name-based infection/immunity cases exactly.
  switch (qualitativeClassForLoinc(loinc)) {
    case "infection":
      if (presence === "positive")
        return { presence, polarity: "bad", immutable: false };
      if (presence === "negative")
        return { presence, polarity: "good", immutable: false };
      return null;
    case "immunity":
      if (isImmunePositiveResult({ name, value, notes, reference }))
        return { presence: "positive", polarity: "good", immutable: false };
      return null;
    case "screen":
      // Prenatal/genetic risk screen (NIPT trisomy) — resolve the low/high-risk
      // axis (#687) from the value/notes. High-risk flags like an infection-
      // positive, low-risk is reassuring, indeterminate is neutral-but-visible;
      // an unrecognized value defers (null), like the other classes.
      return screenClassification(screeningRisk(value, notes));
    case "qc":
      // A QC metric (fetal fraction) — not a health signal (#687). Never flags
      // (neutral polarity), never nudges (qc → isBiomarkerStale exemption).
      return {
        presence: "neutral",
        polarity: "neutral",
        immutable: false,
        qc: true,
      };
    case "identity":
      // An immutable identity attribute — a blood type / genotype. Same verdict the
      // name path gives "Blood Type"/"ABO Blood Group" (#548), but resolved from the
      // LOINC so a source that spells it "ABORh Interpretation" — which the
      // `\babo\b` regex can't match — is judged identically (#910): never abnormal,
      // never stale. The presence is carried through only for display; polarity is
      // what stops the flag.
      return { presence, polarity: "neutral", immutable: true };
    default:
      break; // unknown LOINC → name-based resolution below
  }

  // 1. Immutable identity attributes (blood type, genotype) — never abnormal, never stale.
  if (IMMUTABLE_ATTRIBUTE.test(n))
    return { presence, polarity: "neutral", immutable: true };

  // 1a. QC metric (fetal fraction) — a run-quality percentage, not a health signal
  //     (#687). Checked before the screen regex (fetal fraction also mentions cell-
  //     free DNA). Never flags (neutral), never nudges (qc → staleness exemption).
  if (QC_METRIC.test(n))
    return {
      presence: "neutral",
      polarity: "neutral",
      immutable: false,
      qc: true,
    };

  // 1b. Prenatal/genetic risk SCREEN (NIPT trisomy) — a low/high-risk call, a new
  //     axis distinct from presence (#687). High-risk flags like an infection-
  //     positive, low-risk is reassuring (never flags), indeterminate is neutral-
  //     but-visible; an unrecognized value defers (null).
  if (SCREENING_RISK.test(n))
    return screenClassification(screeningRisk(value, notes));

  // 2. Infection / active-disease markers — positive is BAD (keep flagging), negative
  //    is reassuring. An ambiguous reading yields null (don't fabricate a verdict).
  if (INFECTION_MARKER.test(n) && !isDurableImmunityTiter(name)) {
    if (presence === "positive")
      return { presence, polarity: "bad", immutable: false };
    if (presence === "negative")
      return { presence, polarity: "good", immutable: false };
    return null;
  }

  // 3. Durable-immunity titers (#516) — an immune-POSITIVE titer is GOOD. Judged from
  //    the value/notes/reference (NOT any stored flag — the blunt "abnormal" is exactly
  //    what we're reconsidering). A negative/equivocal titer keeps its own flag + clock.
  if (isDurableImmunityTiter(name)) {
    if (isImmunePositiveResult({ name, value, notes, reference }))
      return { presence: "positive", polarity: "good", immutable: false };
    return null;
  }

  // 4. Context-neutral descriptive attributes (urinalysis color, morphology pattern).
  if (NEUTRAL_ATTRIBUTE.test(n))
    return { presence, polarity: "neutral", immutable: false };

  // 5. Unrecognized analyte — no confident qualitative interpretation (leave as-is).
  return null;
}

// The stored flag a qualitative reading should carry, given its classifier verdict
// and current flag (issue #549, routing #544 + #548 §1; #629). The qualitative
// counterpart of reconciledFlag: "immune" for a good durable-immunity titer,
// "abnormal" for a bad-polarity positive the extractor left unflagged, null (clear to
// normal) for a neutral attribute or good non-immunity result that a blunt "abnormal"
// mis-flagged, and undefined (leave unchanged) otherwise. Never touches a flag it
// can't confidently reclassify.
export function qualitativeFlagResolution(
  name: string | null | undefined,
  value: string | null | undefined,
  notes: string | null | undefined,
  reference: string | null | undefined,
  currentFlag: string | null | undefined,
  loinc?: string | null
): "immune" | "abnormal" | null | undefined {
  const c = classifyQualitativeResult(name, value, notes, reference, loinc);
  if (!c) return undefined; // unrecognized → leave the extractor/existing flag
  if (c.polarity === "bad") {
    // A bad-polarity positive (positive HBsAg/HCV/HIV, a positive culture) that the
    // extractor left null/normal would otherwise display as "Normal" and never reach
    // the attention hero (#629). #549 established the extractor's qualitative flag is
    // NOT trusted, so we can't rely on it having set a red flag here — the
    // highest-stakes category. Given the harm asymmetry (a positive infection marker
    // shown as Normal vs. a false red on a benign qualitative), set "abnormal" when
    // the row is currently unflagged/normal; leave an already-flagged row alone —
    // never override the extractor's specific verdict (high/low/abnormal/immune).
    return isNormalFlag(currentFlag) ? "abnormal" : undefined;
  }
  // Immune promotion: an immune-positive durable-immunity titer resolves to
  // "immune". Recognize it by NAME (isDurableImmunityTiter) OR by the LOINC immunity
  // class (#684) — a titer whose printed name the regex misses still promotes
  // correctly instead of falling through to a flag-clear. An infection-negative is
  // also polarity:"good" but is NOT immunity, so it stays out of this branch.
  if (
    c.polarity === "good" &&
    (isDurableImmunityTiter(name) ||
      qualitativeClassForLoinc(loinc) === "immunity")
  )
    return currentFlag === "immune" ? undefined : "immune";
  // Neutral attribute, or good non-immunity: never "abnormal". Clear an out-of-range
  // flag the extractor guessed; leave an already-neutral flag alone.
  return isOutOfRange(currentFlag) ? null : undefined;
}

// Whether a biomarker's latest reading is past its retest window. `retestDays` is
// the analyte's curated cadence (null → the flat DEFAULT_RETEST_DAYS), so e.g. a
// quarterly HbA1c goes stale at 90 days while an uncurated lab still goes stale at
// 365. Genomics never go stale (genetics don't change). An immune-POSITIVE durable-
// immunity titer never goes stale either (issue #516), and — via the shared
// qualitative classifier (#549) — neither does an IMMUTABLE-attribute result (blood
// type, genotype), the same "the value can't change" exemption (#548 §2), nor a QC
// metric like fetal fraction (#687, `qc`). All use the optional `immunity` context
// (the reading's name/flag/value/notes/reference).
// Boundary: stale strictly AFTER the window (age > interval), matching the original.
//
// #2023/#2025 — this is now the BIOMARKER ADAPTER over the shared freshness vocabulary
// (lib/freshness): the domain grammar below (which categories carry a retest clock at all,
// which results are exempt) stays here, and the age-vs-interval verdict is the one shared
// `freshnessState`. `BiomarkerRetestStatus` is an alias of `FreshnessState`, so a caller
// can tally biomarker readings and fitness tests with the same counter.
export type BiomarkerRetestStatus = FreshnessState;

// The complete retest-clock verdict. `isBiomarkerStale` remains the boolean
// compatibility wrapper; relevance pickers consume `current` to form a due-soon
// bucket without accidentally treating immutable/QC/durable-immunity results as
// merely "not due yet."
export function biomarkerRetestStatus(
  latestDate: string | null | undefined,
  category: string | null | undefined,
  today: string,
  retestDays?: number | null,
  immunity?: ImmunityResult
): BiomarkerRetestStatus {
  if (!latestDate) return "not-applicable";
  if (category === "genomics") return "not-applicable"; // genetics don't change
  // The retest clock is a LAB grammar (#1076). The non-lab analyte classes never
  // carry one: immutable facts ('reference') can't change; physiologic vitals
  // ('vitals' — BP/SpO2/temperature/resting HR) are monitored, not redrawn on a
  // yearly cadence ("you don't schedule a temperature retest"); screening
  // instruments ('instrument') and derived composites ('derived') re-administer /
  // recompute on their own domain logic, never a lab retest nudge. A `lab` reading —
  // or a legacy null category — keeps the cadence below.
  if (
    category === "reference" ||
    category === "vitals" ||
    category === "instrument" ||
    category === "derived"
  )
    return "not-applicable";
  if (immunity) {
    if (isDurableImmunePositive(immunity)) return "not-applicable"; // durable immunity (#516)
    const c = classifyQualitativeResult(
      immunity.name,
      immunity.value,
      immunity.notes,
      immunity.reference,
      // The LOINC hint, so the exemption below survives a name the regexes miss
      // (#910). Callers that don't carry one fall back to name-based recognition.
      immunity.loinc
    );
    if (c?.immutable) return "not-applicable"; // immutable attribute — never stale (#548 §2)
    if (c?.qc) return "not-applicable"; // QC metric (fetal fraction) — never nudged (#687)
  }
  // The shared decision (#2023/#2025). `daysBetween` keeps this domain's long-standing
  // unparseable-date behavior (0 days ⇒ current), so the verdict is byte-for-byte the
  // prior one; only the age > interval comparison moved.
  return freshnessState(
    daysBetween(latestDate, today),
    retestIntervalDays(retestDays)
  );
}

export function isBiomarkerStale(
  latestDate: string | null | undefined,
  category: string | null | undefined,
  today: string,
  retestDays?: number | null,
  immunity?: ImmunityResult
): boolean {
  return (
    biomarkerRetestStatus(latestDate, category, today, retestDays, immunity) ===
    "due"
  );
}
