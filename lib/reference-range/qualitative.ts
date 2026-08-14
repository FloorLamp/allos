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

// ── A value that STATES NO RESULT (#2687) ───────────────────────────────────
//
// "See Note" is not a result. It is a POINTER to the narrative the document files
// the finding in, and a lab prints it in the value column exactly where a word like
// "Reactive" would otherwise go. So does "QNS", "Test not performed" and "Cancelled":
// the row exists, it is dated, its analyte is real — and it reports nothing.
//
// This matters because of what the flag resolver does with an unclassifiable value.
// `classifyQualitativeResult` returns null for these (correctly — the value MEANS
// nothing, so there is no class), and the resolver's response to null is "leave the
// existing flag alone", which is right when the extractor's flag encodes a verdict
// the app cannot re-derive and WRONG here, because there is no verdict: only the
// extractor's one-shot guess, comparing a non-matching value against a qualitative
// reference range. That guess is then permanent — no re-reconcile can ever reach it.
// A stored hepatitis A row carried `flag = 'abnormal'` on a value of "See Note" for
// exactly that reason, while the same non-value on a numerically-referenced row
// (`BUN/CREATININE RATIO`, "SEE NOTE", ref `6-22`) carried none. The difference was
// which reference-range shape the document happened to print.
//
// WHAT THIS IS NOT. It is not a claim about the ROW: the reading is real, keeps its
// analyte identity, its canonical name, its series, its Coverage candidacy and its
// retest clock — a test that produced no answer is if anything MORE worth redrawing.
// Nothing here hides or drops anything. Quantitation is not an identity axis
// (docs/internals/clinical-result-terminology.md); this is a property of the VALUE
// and its only consequence is the flag.
//
// THE LINE. "States no result" is narrower than the #687 SCREEN_INDETERMINATE
// vocabulary it neighbours, and deliberately excludes that vocabulary's core:
// `indeterminate` / `inconclusive` / `equivocal` / `borderline` are FINDINGS — the
// assay ran and reported an ambiguous one — and overriding a finding is the very
// thing #549 forbids. Only a pointer to a narrative, or a statement that no answer
// was produced, qualifies. (`no result` / `no call` / `not reportable` sit in both
// lists honestly: on the screening axis they are one of three risk verdicts, here
// they are the absence of one.) Grow this list on evidence from real exports, never
// on a synonym that could be a finding.
//
// Matched on the WHOLE value, never as a substring: "0.5 (see note)" states a result
// AND points at a note, and "Negative, see comment below" is a negative. Only a value
// that is nothing BUT the non-answer is one.
//
// `q.n.s.` is spelled with interior periods often enough to be worth its own
// alternation — the stripper only removes leading/trailing punctuation, so the dots
// survive into the match. Everything else here is the plain spelling.
const NO_RESULT_STATEMENT =
  /^(?:no results?|not reportable|unable to report|no[-\s]?call|not performed|test not performed|tnp|not done|not tested|(?:test )?cancell?ed(?: by (?:the )?(?:lab|laboratory|client|provider|physician|patient))?|pending|results? pending|in process|q\.?n\.?s|quantity not sufficient|insufficient (?:specimen|quantity|sample)|(?:specimen|sample) (?:unsatisfactory|rejected|not received)|unsatisfactory(?: for evaluation)?|not applicable|n\/a)$/;

// A pointer to where the finding actually lives — "See Note", "SEE COMMENT",
// "see scanned report", "please see note below", "Refer to note".
//
// Matched by CONSUMPTION, not by an anchored opening plus a keyword somewhere
// (#2712 R1). The first spelling anchored only the "see" and left the target word
// unanchored, so ANY value beginning with "see" that mentioned a target counted as
// stating no result — including a value that states its result immediately after the
// pointer ("See note: POSITIVE", "See below: 15.2 mg/dL"). Those are the rows where
// the out-of-range flag is least likely to be a guess: the extractor is instructed to
// copy the document's own H/L marker (lib/medical-extract/prompt.ts), and a value that
// prints a result beside that marker corroborates it. Clearing there deletes the lab's
// verdict, which is the one thing this transition must never do.
//
// So: EVERY word of the value must come from these sets, the value must OPEN with a
// pointer verb, and it must NAME something to go and read. The safety property is a
// property of the vocabulary — no finding word (positive, reactive, detected,
// abnormal, elevated, growth) and no digit is representable in it, so a value that
// survives the consumption check cannot be stating a result.
const POINTER_OPENERS = new Set(["see", "refer", "please", "pls"]);
// The thing being pointed AT. At least one is required: "see the attached" alone is
// not a pointer to anything nameable, and neither is a bare "see".
const POINTER_TARGETS = new Set([
  "note",
  "notes",
  "comment",
  "comments",
  "commentary",
  "report",
  "reports",
  "narrative",
  "interpretation",
  "interpretive",
  "text",
  "addendum",
  "addenda",
  "attachment",
  "attachments",
  "attached",
  "image",
  "images",
  "scan",
  "chart",
  "document",
  "footnote",
  "remark",
  "remarks",
  "description",
  "summary",
  "result",
  "results",
  "below",
  "above",
]);
// Words that carry no claim on their own and may appear anywhere in the phrase. The
// openers are repeated here so the consumption check passes over them too.
const POINTER_FILLERS = new Set([
  "see",
  "refer",
  "please",
  "pls",
  "to",
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "of",
  "in",
  "on",
  "this",
  "separate",
  "scanned",
  "additional",
  "further",
  "more",
  "full",
  "complete",
  "detailed",
  "detail",
  "details",
  "section",
  "page",
  "previous",
  "following",
]);

// Whether a reading's VALUE states no result at all: a pointer to the narrative, or
// a statement that the assay produced no answer. Case- and punctuation-insensitive
// ("SEE NOTE", "*See Note*", "(see comment)"), whole-value only.
export function statesNoResult(value: string | null | undefined): boolean {
  const s = String(value ?? "")
    .replace(/[*"'`]/g, "")
    .replace(/^[\s([{]+|[\s)\]}.,;:!-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!s || s.length > 48) return false;
  if (NO_RESULT_STATEMENT.test(s)) return true;
  // Split on everything that is not a word character, so punctuation cannot hide a
  // word from the consumption check ("see note:positive" is three words, not two) and
  // every digit run becomes a token no set contains.
  const words = s.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length || !POINTER_OPENERS.has(words[0])) return false;
  if (!words.some((w) => POINTER_TARGETS.has(w))) return false;
  return words.every((w) => POINTER_TARGETS.has(w) || POINTER_FILLERS.has(w));
}

// Whether the row's NOTES assert something the app's own vocabulary recognizes —
// a presence (positive/negative/reactive/no-growth) or a screening/risk call
// (abnormal, high-risk, indeterminate). #2712 R2.
//
// `statesNoResult` reads only the VALUE, and `classifyQualitativeResult` reads the
// notes only INSIDE its recognized-class branches: an unrecognized analyte returns
// null whatever its notes say. So on "Some Novel Assay", value "See Note", notes
// "REACTIVE", the finding was sitting one column over and the clear discarded it —
// and the same happened to a RECOGNIZED immunity titer whose value "See below" trips
// NEGATIVE_TITER's `\bbelow\b`, dropping it out of its own class.
//
// The rule the module claims is that a pointer is FOLLOWED, not overruled. This is
// what makes that true: the clear fires only when nothing recognizable is said
// anywhere on the row. Deliberately over-inclusive — a note saying "negative" or
// "within normal limits" also defers, though clearing there would have been correct —
// because a missed clear costs a stale guess and a wrong clear costs a verdict.
export function notesAssertFinding(notes: string | null | undefined): boolean {
  const s = (notes ?? "").trim();
  if (!s) return false;
  return qualitativePresence(s) !== "neutral" || screeningRisk(s) !== null;
}

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

// Facts about the stored ROW that the value/notes cannot tell the resolver (#2712).
// Optional everywhere: a caller that has no row — the reprocess preview, judging a
// freshly extracted record that nobody can have edited yet — passes nothing and gets
// the unlocked answer, which is the right one for a record that does not exist.
export interface QualitativeFlagContext {
  // `isEditLocked(medical_records.edited)` — a person has been in this row through
  // the record editor. Gates the two transitions that would DELETE a flag a person
  // chose: the #2687 no-result clear (#2712) and the #548 §1 clear on an IDENTITY-
  // class row (#2715). It reaches nothing else. In particular the #544 immune
  // promotion, the #629 bad-polarity promotion and the #548 §1 clear on a mutable
  // NEUTRAL attribute (urinalysis colour, morphology pattern) are unchanged — those
  // are separate claims about base behaviour and not these changes' to make.
  editLocked?: boolean;
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
  loinc?: string | null,
  opts?: QualitativeFlagContext
): "immune" | "abnormal" | null | undefined {
  const c = classifyQualitativeResult(name, value, notes, reference, loinc);
  if (!c) {
    // No classification. Two different reasons hide behind that, and they deserve
    // opposite answers (#2687). An UNRECOGNIZED value may still encode a verdict the
    // app cannot re-derive, so the extractor's flag stays — that conservatism is #549
    // and it is right. A value that states NO RESULT encodes nothing: there is no
    // verdict to preserve, only a guess, so an out-of-range flag on it is cleared
    // rather than frozen forever.
    //
    // Four conditions, and all four are load-bearing (#2712):
    //   • the VALUE is nothing but a non-answer — consumed whole, so it cannot be
    //     stating the result right after the pointer;
    //   • the current flag is out of range — this is the only transition, and a
    //     normal/immune/absent flag is left exactly as it is;
    //   • the NOTES assert nothing recognizable — the classifier reads notes only
    //     inside its recognized classes, so this is what makes "the pointer is
    //     followed, not overruled" true for the unrecognized analytes too;
    //   • the row is not EDIT-LOCKED — a flag a person chose in the record editor is
    //     not the extractor's guess, and #133's rule is that a derived pass never
    //     overwrites a hand-edited row.
    return statesNoResult(value) &&
      isOutOfRange(currentFlag) &&
      !notesAssertFinding(notes) &&
      !opts?.editLocked
      ? null
      : undefined;
  }
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
  // An IDENTITY-class row a person has edited by hand keeps the flag they set (#2715).
  // This branch's clear exists to delete an EXTRACTOR GUESS on a value that cannot be
  // abnormal (#548 §1), and on an edit-locked row the flag is not a guess — it is the
  // one thing in the row the app knows a human chose. #133's rule is that a derived
  // pass never overwrites a hand-edited row, and this is a derived pass; #2712 already
  // conceded the point for the no-result clear above, and a rule that holds on one
  // branch and not its neighbour reads as a bug either way.
  //
  // `c.immutable` is precisely the identity class and nothing else: it is set by the
  // LOINC `identity` branch and by the IMMUTABLE_ATTRIBUTE name branch, and every
  // other classification in this file answers false. That is what keeps the reach
  // narrow — a MUTABLE neutral attribute (urinalysis colour, morphology pattern) still
  // clears while edit-locked, because its extractor guess is still a guess and #2715
  // scoped itself to identity. The coupling is pinned by a test rather than assumed,
  // so a future class that answers `immutable` without being identity fails loudly.
  //
  // The two axes stay independent: the row is still exempt from the retest clock
  // (#548 §2 reads the same `immutable` in isBiomarkerStale), so the flag survives and
  // the nudge stays off. Nothing here writes, and nothing strips what is already
  // stored — a row whose flag past boots already cleared is simply left as it is.
  if (c.immutable && opts?.editLocked) return undefined;
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
