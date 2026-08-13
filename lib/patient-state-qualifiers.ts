// Patient-state guard on canonical-name resolution (#2338).
//
// The AI import path resolves a reading's identity from a NAME, and the model is
// asked to recover qualifiers the document encodes STRUCTURALLY — the specimen, the
// panel/section it sits under, laterality, method. That inference is correct and
// necessary: a row inside a urinalysis section really is urine, so a second bare
// "GLUCOSE" row legitimately lands on "Glucose, Urine". Those are properties of the
// SAMPLE or the PROCEDURE, and the layout carries them.
//
// A PATIENT-STATE condition is a different kind of fact. Fasting/post-prandial,
// pre-/post-dose, supine/standing, at-rest/post-exercise are properties of the
// patient's PREPARATION: a report either states one or it does not. Inferring one
// asserts a fact nobody wrote down — and it is not a cosmetic error, because the
// canonical name selects the reference band and the fasting and non-fasting frames
// are incompatible (normal glucose tops out at 99 fasting, ~140 otherwise). Two real
// reports printed a bare "GLUCOSE" and the model filed both as "Glucose, Fasting":
// contextually a good guess, but it decided whether the reading was flagged, and it
// forked the analyte's series across two canonical names by document — which is what
// silently disabled a derived index (#2334).
//
// So: where the printed text does not carry the condition, the UNQUALIFIED entry is
// the correct landing. Nothing is lost — `medical_records.name` keeps the printed
// name verbatim, and the row's own `fasting` column keeps what the report said about
// the draw. A qualifier the document DID state can always be recovered; one it did
// not state was never ours to add.
//
// EVIDENCE IS VERBATIM PRINTED TEXT ONLY — the row's printed name and its panel /
// section heading. Deliberately NOT the row's own `fasting` field: that field is the
// MODEL's answer, produced by the same judgment that over-qualified the name, so a
// model that inferred "fasting" into the identity would have inferred it there too
// and the guard would be a no-op on exactly the documents that motivated it. It is
// also not needed as a rescue: the attribute is stored on its own column either way.
//
// Scope discipline, the mirror of lib/canonical-unit-guard's: this only ever REMOVES
// a state qualifier the printed text does not support. A document that genuinely
// prints "fasting" still lands on "Glucose, Fasting", and specimen / laterality /
// method inference is untouched.

import { normalizeCanonicalKey, snapCanonicalName } from "./canonical-name";

export interface PatientStateQualifier {
  // Stable key for the condition family.
  key: string;
  // Human phrase, for docs and test failure messages.
  label: string;
  // The printed/canonical spellings that name this condition. ONE pattern serves
  // both questions the guard asks — "does this canonical name CARRY the condition?"
  // and "does the document's printed text STATE it?" — because they are the same
  // question about two strings, and a single pattern cannot drift between them.
  // Case-insensitive, NON-global (a /g regex carries lastIndex between .test calls).
  //
  // TIGHTNESS IS THE WHOLE GAME. Each pattern names the condition EXPLICITLY and
  // never a word that is intrinsic to an analyte's own identity: no bare "rest"
  // (Resting Heart Rate is its own curated analyte), no bare "peak" (Peak Expiratory
  // Flow, LDL Peak Size), no "random" (random vs 24-hour urine is a COLLECTION
  // protocol — structural, and the prompt tells the model to keep it).
  pattern: RegExp;
}

export const PATIENT_STATE_QUALIFIERS: readonly PatientStateQualifier[] = [
  {
    key: "fasting",
    label: "fasting / non-fasting",
    // The word plus the three near-universal print abbreviations for a fasting
    // glucose (FBG / FBS / FPG), which a report may print INSTEAD of the word.
    pattern: /\bfast(?:ing|ed)\b|\bfbg\b|\bfbs\b|\bfpg\b/i,
  },
  {
    key: "prandial",
    label: "post-prandial / pre-prandial",
    pattern:
      /\b(?:post|pre)[\s-]?prandial\b|\bpp(?:bs|bg|g)\b|\b(?:post|pre)[\s-]?meal\b/i,
  },
  {
    key: "dose-timing",
    label: "pre-dose / post-dose (trough / peak level)",
    pattern: /\b(?:pre|post)[\s-]?dose\b|\btrough\b/i,
  },
  {
    key: "posture",
    label: "supine / standing / seated",
    pattern: /\bsupine\b|\bstanding\b|\bseated\b|\bupright\b|\brecumbent\b/i,
  },
  {
    key: "exertion",
    label: "at rest / post-exercise",
    pattern:
      /\bat[\s-]rest\b|\b(?:post|during)[\s-]?exercise\b|\b(?:post|during)[\s-]?exertion\b/i,
  },
  {
    key: "time-of-day",
    label: "morning / evening draw",
    // #2526's addition. A diurnal analyte's published band belongs to ONE point in
    // the rhythm — a morning cortisol tops out near 18 µg/dL and the same person's
    // evening value is normal at a third of that — so the time of the draw is a
    // patient-state condition in exactly the sense fasting is: the report either
    // prints it or it does not, and inferring it selects a band.
    //
    // The clock alternative is the tight one a lab actually prints beside an analyte
    // ("CORTISOL, AM", "8 AM"), not a bare hour. A bare "am" between word boundaries
    // is essentially always that marker in the short text this sees — a row's printed
    // name and its section heading — and a false POSITIVE here is the harmless
    // direction anyway: it only declines to demote a qualifier the model already
    // chose. The dangerous direction is a false negative, which lands the reading on
    // the unqualified entry and shows it unflagged, which is the #2338 posture.
    pattern:
      /\bmorning\b|\bevening\b|\bmidnight\b|\bbedtime\b|\bdiurnal\b|\ba\.?m\.?\b|\bp\.?m\.?\b/i,
  },
];

// The patient-state conditions a name asserts (usually none, occasionally one).
export function patientStateQualifiersIn(
  name: string | null | undefined
): PatientStateQualifier[] {
  if (!name) return [];
  return PATIENT_STATE_QUALIFIERS.filter((q) => q.pattern.test(name));
}

// Whether a piece of verbatim document text states this condition.
export function statesPatientState(
  text: string | null | undefined,
  qualifier: PatientStateQualifier
): boolean {
  return !!text && qualifier.pattern.test(text);
}

// Re-join a name after a qualifier was cut out of it: drop the emptied comma
// segments and parentheticals, collapse whitespace. "Glucose, Fasting" → "Glucose",
// "Fasting Glucose" → "Glucose", "Glucose (Fasting)" → "Glucose".
function tidyName(name: string): string {
  return name
    .replace(/\(\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    .split(",")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(", ")
    .trim();
}

// The name with these conditions removed, or "" when nothing recognizable is left.
export function withoutPatientState(
  name: string,
  qualifiers: readonly PatientStateQualifier[]
): string {
  let out = name;
  for (const q of qualifiers) {
    out = out.replace(new RegExp(q.pattern.source, "gi"), " ");
  }
  return tidyName(out);
}

// Demote `snapped` (the canonical name AFTER snapping and unit arbitration) to its
// unqualified form when it asserts a patient-state condition the document's printed
// text does not state. Returns a vocabulary-resolved name, or `snapped` unchanged
// when the condition IS stated, when the name carries none, or when stripping leaves
// nothing to land on.
//
// `printedText` is the verbatim document evidence — the row's printed name and its
// panel/section heading. Both are what the report actually put on the page; a panel
// literally headed "FASTING LIPID PANEL" states the condition, while one headed
// "Diabetes Panel" merely makes it likely, and likely is not stated.
export function stateAwareCanonical(
  snapped: string,
  printedText: readonly (string | null | undefined)[],
  vocabularyIndex: Map<string, string>
): string {
  const carried = patientStateQualifiersIn(snapped);
  if (!carried.length) return snapped;
  const evidence = printedText.filter(Boolean).join(" | ");
  const unstated = carried.filter((q) => !statesPatientState(evidence, q));
  if (!unstated.length) return snapped;
  const stripped = withoutPatientState(snapped, unstated);
  // Nothing left, or the qualifier is inseparable from the name — keep the model's
  // resolution rather than coining a fragment.
  if (!stripped || normalizeCanonicalKey(stripped) === "") return snapped;
  if (normalizeCanonicalKey(stripped) === normalizeCanonicalKey(snapped))
    return snapped;
  return snapCanonicalName(stripped, vocabularyIndex);
}
