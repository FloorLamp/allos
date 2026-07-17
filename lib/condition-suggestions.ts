// The condition-suggestion detector (issue #685). A qualitative lab result that the
// shared classifier (#549) resolves to a polarity:"bad" infection-POSITIVE (positive
// HBsAg / anti-HBc / HCV / HIV / RPR / chlamydia / gonorrhea) — or, per #687's
// cross-ref, a HIGH-RISK prenatal screen — is effectively a point-in-time finding the
// conditions/recommendation surfaces are blind to when it lives only as a flag chip.
//
// This routes such a result to a SUGGESTION the user confirms (never a silent
// problem-list insert — clinically loaded and dedup-risky against an existing Active
// Problem, #560's suggest-only discipline). The detector is PURE: it takes the
// profile's CURRENT qualitative readings + existing conditions and returns the
// concepts to suggest, deduped against the problem list.
//
// Identity discipline (#482): dedup reuses the EXISTING condition identity —
// conditionCollapseKey (lib/icd10.ts) — rather than inventing a second grouping, so a
// suggestion whose concept already collapses onto a stored condition is dropped. The
// marker→concept map is the one NEW thing (there's no existing "which condition does
// HBsAg suggest" table); it carries an exclusion discipline — a generic culture whose
// organism is unknown suggests NOTHING (over-suggesting a vague "infection" is worse
// than silence).
//
// NEGATIVE results are deliberately NOT conditions — a non-reactive HIV/HCV is a
// screening event (the preventive-cadence follow-up, #686), never a problem-list row.

import { conditionCollapseKey } from "./icd10";
import { classifyQualitativeResult } from "./reference-range";

// The dedupeKey namespace for a condition-review suggestion. Registered in
// RULE_FINDING_PREFIXES (#448) so the page's prefix-guarded dismiss action can match
// it and the reflection guard proves the keys are guardable. The key embeds the
// concept's conditionCollapseKey, so it's CONCEPT-keyed (not reading-id keyed) — a
// dismiss follows the concept and doesn't drift as which reading is newest (#203).
export const CONDITION_REVIEW_PREFIX = "condition-review:";

// The clinical class that TRIGGERED a suggestion: an infection-positive marker vs a
// high-risk genetic/prenatal screen. A concept is only matched against the trigger of
// its own kind, so an infection reading never cross-matches a screen concept.
type SuggestionKind = "infection" | "screen";

interface ConditionConcept {
  // Stable concept id (documentation/tests only — dedup keys off conditionCollapseKey).
  id: string;
  // The suggested Condition display name.
  label: string;
  // An optional ICD-10-CM code for the created condition. Left null where a positive
  // result doesn't pin ONE code (a positive HBsAg is acute OR chronic hep B) — coding
  // it precisely would be a wrong assertion; name-based collapse handles dedup.
  code: string | null;
  // Matches the analyte NAME of a result of this concept.
  analyte: RegExp;
  kind: SuggestionKind;
}

// The marker→concept map. Order matters: the FIRST matching concept wins for a
// reading, so the more specific hepatitis-C / hepatitis-B tests precede the generic
// ones. Only markers whose positive maps to ONE unambiguous condition are listed.
const CONCEPTS: ConditionConcept[] = [
  {
    id: "hiv",
    label: "HIV",
    code: null,
    analyte: /\bhiv\b/i,
    kind: "infection",
  },
  {
    id: "hepatitis-c",
    label: "Hepatitis C",
    code: null,
    analyte: /hepatitis\s*c\b|\bhcv\b/i,
    kind: "infection",
  },
  {
    id: "hepatitis-b",
    label: "Hepatitis B",
    code: null,
    // Surface ANTIGEN or CORE antibody — a positive is infection. The surface
    // ANTIBODY (immunity) never reaches here: the classifier resolves it polarity
    // "good", so it fails the infection trigger below.
    analyte:
      /hbsag|hepatitis\s*b\s*surface\s*ag|hepatitis\s*b\s*surface\s*antigen|hepatitis\s*b\s*core|anti-?hbc|hbcab|hepatitis\s*b\b/i,
    kind: "infection",
  },
  {
    id: "syphilis",
    label: "Syphilis",
    code: null,
    analyte: /\brpr\b|syphilis|treponema|\bvdrl\b/i,
    kind: "infection",
  },
  {
    id: "chlamydia",
    label: "Chlamydia infection",
    code: null,
    analyte: /chlamydia/i,
    kind: "infection",
  },
  {
    id: "gonorrhea",
    label: "Gonorrhea",
    code: null,
    analyte: /gonorrh/i,
    kind: "infection",
  },
  {
    id: "trisomy-21",
    label: "Trisomy 21 (Down syndrome)",
    code: null,
    analyte: /trisomy\s*21|down\s*syndrome|\bt21\b/i,
    kind: "screen",
  },
  {
    id: "trisomy-18",
    label: "Trisomy 18 (Edwards syndrome)",
    code: null,
    analyte: /trisomy\s*18|edwards|\bt18\b/i,
    kind: "screen",
  },
  {
    id: "trisomy-13",
    label: "Trisomy 13 (Patau syndrome)",
    code: null,
    analyte: /trisomy\s*13|patau|\bt13\b/i,
    kind: "screen",
  },
];

// A CURRENT qualitative reading the detector judges — the latest-in-group result for
// an analyte, with the value/notes/reference/loinc the classifier reads.
export interface QualitativeResultInput {
  id: number;
  name: string;
  value: string | null;
  notes: string | null;
  reference: string | null;
  loinc?: string | null;
  date: string;
}

// An existing problem-list row, for the concept dedup (name + optional code).
export interface ExistingConditionInput {
  name: string;
  code?: string | null;
}

export interface ConditionSuggestion {
  // The dedupeKey / shared-bus key: `condition-review:<conditionCollapseKey>`.
  key: string;
  // The suggested Condition (what "Add to conditions" would create).
  name: string;
  code: string | null;
  // The analyte + date that triggered it, for the review detail line.
  sourceName: string;
  date: string;
  kind: SuggestionKind;
}

// Which kind of suggestion a classified reading triggers, or null when it triggers
// none. Infection: a bad-polarity POSITIVE presence (the classifier already excludes
// immune-positive titers and negatives). Screen: a HIGH-risk verdict (#687).
function triggerKindFor(
  reading: QualitativeResultInput
): SuggestionKind | null {
  const c = classifyQualitativeResult(
    reading.name,
    reading.value,
    reading.notes,
    reading.reference,
    reading.loinc
  );
  if (!c) return null;
  if (c.risk === "high_risk") return "screen";
  if (c.polarity === "bad" && c.presence === "positive") return "infection";
  return null;
}

function conceptFor(
  name: string,
  kind: SuggestionKind
): ConditionConcept | null {
  for (const concept of CONCEPTS) {
    if (concept.kind === kind && concept.analyte.test(name)) return concept;
  }
  return null;
}

// The condition suggestions for a set of CURRENT qualitative readings, deduped both
// against the existing problem list and among themselves (one suggestion per concept;
// readings arrive newest-first so the newest triggering reading is kept). Pure — the
// builder owns the DB gather (readings + conditions) and the surfaces format over the
// result, so the same fixture yields the same suggestions everywhere (#221).
export function suggestConditionsFromResults(
  readings: QualitativeResultInput[],
  existing: ExistingConditionInput[]
): ConditionSuggestion[] {
  const existingKeys = new Set(
    existing.map((c) => conditionCollapseKey({ code: c.code, name: c.name }))
  );
  const seen = new Set<string>();
  const out: ConditionSuggestion[] = [];
  for (const r of readings) {
    const kind = triggerKindFor(r);
    if (!kind) continue;
    const concept = conceptFor(r.name, kind);
    if (!concept) continue; // exclusion discipline — no confident concept, no suggestion
    const collapseKey = conditionCollapseKey({
      code: concept.code,
      name: concept.label,
    });
    if (existingKeys.has(collapseKey)) continue; // already on the problem list
    if (seen.has(collapseKey)) continue; // one suggestion per concept
    seen.add(collapseKey);
    out.push({
      key: `${CONDITION_REVIEW_PREFIX}${collapseKey}`,
      name: concept.label,
      code: concept.code,
      sourceName: r.name,
      date: r.date,
      kind,
    });
  }
  return out;
}

// The review-item title + detail each surface renders (one computation). The detail
// stays informational — it states the observed result and asks the user to confirm;
// a screen result is explicitly framed as a screen positive to confirm, never a
// diagnosis the app asserts.
export function conditionSuggestionTitle(s: ConditionSuggestion): string {
  return `Add ${s.name} to conditions?`;
}

export function conditionSuggestionDetail(s: ConditionSuggestion): string {
  if (s.kind === "screen") {
    return `High-risk ${s.sourceName} screen (${s.date}) — a screen positive, not a diagnosis. Review and confirm with diagnostic testing before adding.`;
  }
  return `Positive ${s.sourceName} result (${s.date}) isn't on your problem list. Review to add it as a condition.`;
}
