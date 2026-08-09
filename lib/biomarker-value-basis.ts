// WHAT A COLOURED BIOMARKER VALUE CAN POINT AT (#2340).
//
// THE DEFECT. The biomarker detail page colours its latest value from the stored
// flag, but builds its range display — `referenceEntries` — exclusively from the
// CURATED catalog entry. When the catalog carries no band that list is empty and no
// range renders at all, while the flag itself came from the source document's own
// printed range, stored on the row (`medical_records.reference_range`) and never
// consulted by that surface. The result is an alarming red value with nothing on
// screen saying what it is alarming against. For a health app that is the wrong
// direction to fail in, and it is worst exactly where it is most likely: an analyte
// the catalog DELIBERATELY declines to band, because that is when the curated list is
// guaranteed empty while the lab's own range sits on the row.
//
// THE RULE. A value may be coloured only when the page can SHOW what judged it. So
// this module answers one question — what basis does this surface have — and returns
// both halves of the answer at once: what to render as the basis, and the flag the
// value is allowed to carry. A caller cannot take one without the other.
//
// The bases, in the order they are preferred:
//
//   • `curated`     — the app's own band(s) are on screen. Unchanged behavior.
//   • `reported`    — no curated band, but the row carries the source's printed
//                     range. Render it ATTRIBUTED (`Reference range (as reported)`).
//                     The attribution is load-bearing: this is the lab's band for
//                     THAT draw, not a population band the app endorses. Two readings
//                     of one such analyte in a single database can carry DIFFERENT
//                     source ranges — labs band leptin by sex and body composition —
//                     which is precisely why the catalog declines to publish one.
//   • `qualitative` — the reading states its own verdict in words ("Detected",
//                     "Reactive", "Non-Reactive"), and that word IS the value the
//                     surface renders. A positive infection screen is flagged
//                     `abnormal` by `qualitativeFlagResolution` against the
//                     classifier, never against a range; its basis is displayable and
//                     displayed, so decolouring it would hide a true positive to
//                     satisfy a rule about ranges. The caller supplies this from the
//                     SAME `classifyQualitativeResult` the flag came from.
//   • `none`        — nothing displayable. The value renders NEUTRAL.
//
// `none` suppresses only a flag that would COLOUR the value (`flagTone` bad or warn).
// A neutral-toned flag makes no claim the page must support: `immune` renders its own
// emerald status, and a normal/absent flag colours nothing to begin with. Suppressing
// those would delete an honest label rather than an unsupported one.
//
// AND THE SUPPRESSION REACHES THE WORD, not only the colour. #2343 gave `MedicalValue`
// a `showFlagLabel` mode that renders the severity ("High", "Low") as visible text
// instead of an `sr-only` span. Handing that mode a flag with no displayable basis
// would replace an unexplained red with an unexplained red PLUS the word "Low" — a
// louder version of the same unsupported claim. Because the suppression happens at the
// flag, one decision covers the colour, the caret and the word together.
//
// PURE: no DB, no React. The caller resolves the curated entries, the row's printed
// range and the qualitative classification; `lib/__tests__/biomarker-value-basis.test.ts`
// proves the decision, and `lib/__db_tests__/biomarker-value-basis.test.ts` proves it
// over stored rows whose flags `reconcileFlags` derived.

import { flagTone } from "./reference-range";

/** Which basis the surface has for the colour it is about to apply. */
export type ValueBasisKind = "curated" | "reported" | "qualitative" | "none";

/**
 * The attribution on a source-supplied range. It names the LAB, not the app: the
 * app publishes no band for this analyte and this label must not imply it does.
 */
export const REPORTED_RANGE_LABEL = "Reference range (as reported)";

export interface ValueBasisInput {
  /** The reading's stored flag. */
  flag: string | null | undefined;
  /**
   * True when the surface is actually RENDERING at least one curated band —
   * reference or optimal. Not "a catalog entry exists": an entry with a note and no
   * numbers displays nothing, which is the case this module exists for.
   */
  hasCuratedBand: boolean;
  /** The reading's own `medical_records.reference_range`, as the document printed it. */
  reportedRange: string | null | undefined;
  /**
   * True when `classifyQualitativeResult` recognized this reading's value — i.e. the
   * value states its own verdict and the surface is showing that word.
   */
  qualitative?: boolean;
}

export interface ValueBasis {
  kind: ValueBasisKind;
  /**
   * The attributed range entry to render, or null. Present only for `reported` —
   * the curated entries are the caller's own, and the other two bases have no range.
   */
  reportedEntry: { label: string; range: string } | null;
  /**
   * The flag the value may be rendered with. Identical to the input flag except
   * when a colouring flag has no basis, where it is null so the value, its caret
   * and its severity word all go neutral together.
   */
  displayFlag: string | null;
}

/** The basis a surface has for colouring one reading, and the flag it may use. */
export function biomarkerValueBasis(input: ValueBasisInput): ValueBasis {
  const reported = input.reportedRange?.trim() || null;
  const kind: ValueBasisKind = input.hasCuratedBand
    ? "curated"
    : reported
      ? "reported"
      : input.qualitative
        ? "qualitative"
        : "none";
  // Only a flag that paints the value red or amber is a claim needing a basis.
  const colours = flagTone(input.flag) !== "default";
  return {
    kind,
    reportedEntry:
      kind === "reported"
        ? { label: REPORTED_RANGE_LABEL, range: reported as string }
        : null,
    displayFlag: kind === "none" && colours ? null : (input.flag ?? null),
  };
}

// ---------------------------------------------------------------------------
// WHY THIS ANALYTE HAS NO BAND (#2340 part 2).
//
// The curated `note` and the curated `description` are two datasets, and the detail
// page printed both — the note in the PageHeader subtitle beside the reading count,
// the description in the explainer card fifteen lines below. For at least one analyte
// they are near-paraphrases, so the reader got the same fact twice in slightly
// different words, which reads as a mistake.
//
// They are not equivalent, though, and that is the part to get right: the note carries
// a clause the description does not — WHY the analyte has no reference band. That
// clause is the single most useful sentence on the page for the case above, and it was
// buried in a header subtitle. One prose surface per fact: the explainer card keeps the
// educational description, and this extracts the band clause so it can be rendered
// where the missing band is.
// ---------------------------------------------------------------------------

// A clause boundary is a sentence terminator or a semicolon, EXCEPT after an
// abbreviation — "Dodds et al. 2014" and "e.g. 20/20" are one clause, not two.
const ABBREVIATION_END =
  /(?:^|[\s(])(?:[A-Za-z]|e\.g|i\.e|al|vs|cf|approx|etc|Dr|No|St|Fig)\.$/;

// A clause is band-related when it NEGATES a band/range/cutoff ("no numeric band",
// "not a fixed cutoff", "carries NO population band"), states what a band does or
// does not do ("no reference band applies", "no band is set here"), or stands in for
// one with an explicit table ("Severity bands: 0–4 minimal, …"). Deliberately not a
// bare /band/: "Immature (band) neutrophils" is a cell type, and matching it would
// re-import the description this change exists to stop duplicating.
const BAND_CLAUSE_PATTERNS = [
  /\b(?:no|not|never|without|rather than)\b[^;]{0,80}?\b(?:bands?|reference ranges?|cut-?offs?)\b/i,
  /\b(?:bands?|reference ranges?|cut-?offs?)\b[^;]{0,80}?\b(?:not|of its own|applies|apply|is set|are set)\b/i,
  /\bbands?\b\s*(?:\([^)]*\))?\s*:/i,
];

function clauses(note: string): string[] {
  const out: string[] = [];
  for (const part of note.split(/(?<=[.;!?])\s+/)) {
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBREVIATION_END.test(prev))
      out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out;
}

/**
 * The band-related clause(s) of a curated `note`, or null when it has none.
 *
 * A clause lifted out of the middle of a sentence starts lower-case and can end on
 * the semicolon it was split at; both are normalized so it reads as a sentence under
 * its own heading. Nothing else about the curated wording is touched.
 */
export function bandNoteClause(note: string | null | undefined): string | null {
  const text = note?.trim();
  if (!text) return null;
  const found = clauses(text).filter((c) =>
    BAND_CLAUSE_PATTERNS.some((p) => p.test(c))
  );
  if (found.length === 0) return null;
  const joined = found.map((c) => c.replace(/;$/, ".")).join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
