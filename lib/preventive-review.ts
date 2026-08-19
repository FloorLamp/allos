import type { MedicalCategory } from "./types";
import { matchRuleKeys, type InferenceRecord } from "./preventive-inference";
import { preventiveRuleByKey } from "./preventive-catalog";

// Preventive evidence policy for medical-record rows (issue #3025).
//
// STRUCTURED EVIDENCE DECIDES; PROSE ASKS (owner ruling, 2026-08-18). A medical
// record auto-satisfies a preventive screening only through an identity something
// curated authored: an exact code in the preventive concept map, a curated
// canonical result name, or an explicit stored link (a confirmed
// preventive_record_decisions row). Free text in a document title never changes
// due status on its own — three recorded attempts at title parsing failed in
// alternating directions (see the issue's comment) — it may only OFFER a
// review-and-confirm candidate that a person answers.
//
// THE CATEGORY CENSUS IS CLOSED (#2786 discipline). The old gate was an allowlist
// that silently dropped categories nobody listed — a Pap cytology filed as
// `report` satisfied nothing and a screened profile was nudged as overdue. Every
// importer-written category is now classified below, and an unclassified one
// fails loudly (a compile error via the Record key, and a thrown error at
// runtime), never silently in either direction.

export type PreventiveEvidenceClass =
  // Value-bearing RESULT rows (labs, vitals, screening-instrument scores): the
  // #86/#686/#1076 behavior, unchanged — code, curated canonical name, AND
  // whole-word name synonyms all match, exactly as on the day this census landed.
  | { evidence: "result" }
  // Document-class rows: a structured identity (exact concept-map code via the
  // row's LOINC, or a curated canonical name) auto-satisfies; the free-text title
  // NEVER does. Category membership alone proves nothing.
  | { evidence: "structured-only"; reason: string }
  // Never screening evidence, with the reason stated.
  | { evidence: "excluded"; reason: string };

// One entry per MedicalCategory — the closed census. Adding a category to
// MEDICAL_CATEGORIES without classifying it here is a compile error, and the
// runtime lookup throws for a category the census has never met (the guard the
// old Set failed silently).
export const PREVENTIVE_EVIDENCE_CENSUS: Record<
  MedicalCategory,
  PreventiveEvidenceClass
> = {
  lab: { evidence: "result" },
  vitals: { evidence: "result" },
  instrument: { evidence: "result" },
  report: {
    evidence: "structured-only",
    reason:
      "narrative documents (cytology/pathology/imaging reads) — the class that proves a screening happened, but whose titles also name orders, counseling notes, and refusals; identity satisfies, prose only offers a review candidate",
  },
  assessment: {
    evidence: "structured-only",
    reason:
      "scored questionnaires/assessments — free text names programs and instruments ambiguously; only a curated identity is completion evidence",
  },
  genomics: {
    evidence: "excluded",
    reason: "genetic results are risk inputs, never screening completions",
  },
  scan: {
    evidence: "excluded",
    reason:
      "imaging rows here are measurements extracted from studies; the study itself satisfies through procedures/imaging_studies",
  },
  prescription: {
    evidence: "excluded",
    reason: "a prescription is an intention, not a completed screening",
  },
  derived: {
    evidence: "excluded",
    reason:
      "computed indexes re-express other rows; crediting them would double-count their inputs",
  },
  reference: {
    evidence: "excluded",
    reason: "immutable reference facts (blood type…) are not events on a timeline",
  },
};

// The census class for a stored category string. Throws for a category the census
// has not classified — the loud failure the old silent allowlist lacked. (The
// schema CHECK constrains stored categories to MEDICAL_CATEGORIES, so this can
// only fire when a migration adds a category without classifying it here.)
export function preventiveEvidenceClass(
  category: string
): PreventiveEvidenceClass {
  const cls = (
    PREVENTIVE_EVIDENCE_CENSUS as Record<
      string,
      PreventiveEvidenceClass | undefined
    >
  )[category];
  if (!cls) {
    throw new Error(
      `Unclassified medical category for preventive evidence: "${category}" — classify it in PREVENTIVE_EVIDENCE_CENSUS (lib/preventive-review.ts)`
    );
  }
  return cls;
}

// The medical-record fields the evidence mapping reads. Matches the
// ClinicalObservation columns the query layer selects.
export interface PreventiveEvidenceObservation {
  category: MedicalCategory | null;
  name: string;
  canonical_name: string | null;
  loinc?: string | null;
  date: string;
}

// Map one medical-record row to the InferenceRecord the shared pure matcher
// consumes, per the census — or null when the row is not screening evidence.
//
//   result          → the unchanged #86 record shape (code:null, name, canonical),
//                     so a refusal-free title matches exactly as it does today.
//   structured-only → identity fields ONLY: the row's LOINC rides the exact-code
//                     path and its curated canonical name the canonical path; the
//                     free-text title is withheld (name:null), so no wording —
//                     order, counseling note, refusal, or genuine Pap — can
//                     auto-satisfy, and none can withhold a curated identity.
//   excluded / the #2877 NULL review state → nothing.
export function preventiveEvidenceRecord(
  r: PreventiveEvidenceObservation
): InferenceRecord | null {
  if (r.category === null) return null;
  const cls = preventiveEvidenceClass(r.category);
  if (cls.evidence === "excluded") return null;
  if (cls.evidence === "result") {
    return {
      code: null,
      name: r.name,
      canonicalName: r.canonical_name,
      date: r.date,
      allow: ["screening"],
    };
  }
  return {
    code: r.loinc ?? null,
    name: null,
    canonicalName: r.canonical_name,
    date: r.date,
    allow: ["screening"],
  };
}

// ---- Review candidates (the "prose asks" half) -----------------------------

// A report-category row considered for a review candidate.
export interface PreventiveReviewSource {
  id: number;
  category: string | null;
  name: string;
  date: string;
  value: string | null;
}

// One offered review candidate: "does this record show <rule> was completed?".
// Keyed by (recordId, ruleKey) — see preventiveReviewFactKey.
export interface PreventiveReviewCandidate {
  recordId: number;
  ruleKey: string;
  recordName: string;
  recordDate: string;
}

// Derive the review candidates from a profile's report rows. A VALUELESS report
// whose title matches exactly ONE screening rule through the existing whole-word
// concept map emits one candidate; zero matches make no claim and multiple
// matches are ambiguous — neither guesses. Value-bearing rows are results, not
// documents to review, and belong to the census's result path.
//
// Decision-blind on purpose: confirm/dismiss suppression is applied by the query
// layer, so the same derivation revalidates a confirmation (reconfirming stays
// idempotent — the pair still derives after its decision exists).
export function derivePreventiveReviewCandidates(
  reports: PreventiveReviewSource[]
): PreventiveReviewCandidate[] {
  const out: PreventiveReviewCandidate[] = [];
  for (const r of reports) {
    if (r.category !== "report") continue;
    if ((r.value ?? "").trim() !== "") continue;
    const keys = matchRuleKeys(
      { code: null, name: r.name, canonicalName: null },
      ["screening"]
    );
    if (keys.length !== 1) continue;
    out.push({
      recordId: r.id,
      ruleKey: keys[0],
      recordName: r.name,
      recordDate: r.date,
    });
  }
  return out;
}

// The candidate's stable fact key — `preventive-review:<recordId>:<ruleKey>` —
// used as the dashboard candidate/fact id so every surface names the same fact.
export function preventiveReviewFactKey(c: {
  recordId: number;
  ruleKey: string;
}): string {
  return `preventive-review:${c.recordId}:${c.ruleKey}`;
}

// The question the candidate asks, naming the rule in plain words. The date is
// rendered (and edited) by the control beside it in the viewer's date format.
export function preventiveReviewQuestion(ruleKey: string): string {
  const rule = preventiveRuleByKey(ruleKey);
  const name = rule
    ? rule.name.charAt(0).toLowerCase() + rule.name.slice(1)
    : "this screening";
  return `Does this record show that ${name} was completed? Confirm the date.`;
}
