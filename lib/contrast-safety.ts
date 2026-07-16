// Pure contrast-safety cross-check (issue #701) — the imaging twin of the drug–drug
// interaction (lib/drug-interactions.ts) and pharmacogenomics (lib/pgx.ts) safety
// cross-checks. No DB, no network: given a profile's PLANNED contrast studies (an
// ordered care_plan_items row, a scheduled appointment, or a future-dated
// imaging_studies row, #702) and its recorded allergens + active conditions, it
// returns the matched pre-procedure notes — a contrast/iodine/gadolinium ALLERGY, or
// a renal (CKD) contraindication — each with the required framing and an ACR citation.
//
// The DB gather lives in lib/queries/intake/warnings.ts (getContrastSafetyWarnings),
// which reads the profile's planned studies + the ONE shared safety-context gather
// (getIntakeSafetyContext, #661 — allergens + active conditions) and calls the pure
// functions here, so the care-plan inline notice and the dismissible Upcoming finding
// are BOTH formatters over ONE computation (AGENTS.md "one question, one computation").
//
// PLANNED-STUDY SIGNAL (issue #701): the PRIMARY trigger is a future/ordered study,
// detected from FREE TEXT — a care-plan item's description or an appointment's title/
// notes that indicates contrast ("CT abdomen with contrast", "MRI with gadolinium",
// "contrast-enhanced"). A completed imaging_studies row is NOT a trigger (the
// pre-procedure window has passed); a FUTURE-dated imaging_studies row with the
// structured contrast flag set IS also consumed (structured is stronger than text).
// The contrast CLASS is parsed from the text/modality: CT/CTA → iodinated,
// MRI/MRA + gadolinium → gadolinium. A "without/non-contrast" study never triggers.
//
// CKD recognition REUSES lib/risk-stratification.ts (conditionsToRiskFactors →
// "chronic-kidney-disease") rather than a bespoke parse; the advanced-CKD gate for
// the gadolinium/NSF note is the one contrast-specific extension (there is no
// existing "advanced CKD" recognizer).
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A note flags a conversation
// to have with the care team; it never blocks a study, never advises for or against
// it, and the ABSENCE of a flag is NOT clearance (a curated subset; an unparsed study
// carries no flag). Fully OFFLINE — no study text/allergy/condition leaves the box.

import data from "./contrast-safety.json";
import { conditionsToRiskFactors } from "./risk-stratification";

export type ContrastClass = "iodinated" | "gadolinium";
export type ContrastGate = "allergy" | "renal";
export type ContrastStudySource = "careplan" | "appointment" | "imaging";
type RenalLevel = "any" | "advanced";

interface RawClass {
  class: ContrastClass;
  label: string;
  modalities: string[];
  agents: string[];
}
interface RawAllergyGate {
  class: ContrastClass;
  allergens: string[];
  note: string;
  source: string;
}
interface RawRenalGate {
  class: ContrastClass;
  level: RenalLevel;
  note: string;
  source: string;
}

const CLASSES = data.classes as RawClass[];
const ALLERGY_GATES = data.allergyGates as RawAllergyGate[];
const RENAL_GATES = data.renalGates as RawRenalGate[];

const CLASS_LABEL: Record<ContrastClass, string> = Object.fromEntries(
  CLASSES.map((c) => [c.class, c.label])
) as Record<ContrastClass, string>;

// The brand/generic AGENT names per class (omnipaque, optiray, gadavist, omniscan, …).
// These already detect contrast INTENT in study text; issue #829 (Finding 1) also folds
// them into the ALLERGY match so a brand-specific record ("Allergic to Omnipaque")
// screens too. Derived from the CLASSES table in code — not hand-copied into the gate
// JSON — so the intent list and the allergy list can never drift apart.
const CLASS_AGENTS: Record<ContrastClass, string[]> = Object.fromEntries(
  CLASSES.map((c) => [c.class, c.agents])
) as Record<ContrastClass, string[]>;

// The informational guardrail appended to every note (issue #701's required framing:
// never prescriptive; the absence of a flag is not clearance).
const GUARDRAIL =
  "Informational — this flags a conversation to have with your care team; it does " +
  "not advise for or against the study, and the absence of a flag is not clearance.";

// ---- Inputs ---------------------------------------------------------------

// A candidate planned study before parsing — the free-text (+ optional structured
// imaging hints) the gather passes in. `text` is what we parse for contrast intent +
// class; `label` (when given) is the display string, else the trimmed text.
export interface PlannedStudyInput {
  source: ContrastStudySource;
  sourceId: number;
  text: string;
  label?: string;
  date: string | null;
  // Structured imaging_studies hints (#702): a modality + the stored contrast flag +
  // the named agent. A true `contrastFlag` bypasses text contrast-intent detection.
  modality?: string | null;
  contrastAgent?: string | null;
  contrastFlag?: boolean;
}

// A parsed planned contrast study: class resolved, ready for the cross-check.
export interface PlannedContrastStudy {
  source: ContrastStudySource;
  sourceId: number;
  contrastClass: ContrastClass;
  label: string;
  date: string | null;
}

// One matched note: a planned study's class meets an allergy or renal gate.
export interface ContrastHit {
  source: ContrastStudySource;
  sourceId: number;
  contrastClass: ContrastClass;
  studyLabel: string;
  gate: ContrastGate;
  // The allergen substance or condition phrase that matched (display context).
  matchedOn: string;
  note: string;
  citation: string;
  // The stable suppression/identity key — `contrast:<source>:<sourceId>:<gate>:<class>`.
  // Keyed on the study ROW (ids never recycle — AGENTS.md #203) + the gate + class, so
  // a dismiss follows the specific study-and-finding and doesn't drift.
  dedupeKey: string;
}

// ---- Text parsing ---------------------------------------------------------

function normalize(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Whether normalized text NEGATES contrast ("without contrast", "non-contrast",
// "no contrast", "w/o contrast" → "w o contrast"). Structured overrides this.
function negatesContrast(t: string): boolean {
  return /\b(?:without|non|no|w o)\s+contrast\b/.test(t);
}

// Whether normalized text INDICATES a contrast study: an explicit contrast phrase, or
// the presence of any named contrast agent (naming an agent implies contrast).
function indicatesContrast(t: string): boolean {
  // "with contrast" / "with IV contrast" / "post contrast".
  if (/\b(?:with|post)\s+(?:iv\s+)?contrast\b/.test(t)) return true;
  if (/contrast\s+enhanced\b/.test(t)) return true;
  if (/\bwith\s+(?:iv\s+)?(?:iodine|gadolinium)\b/.test(t)) return true;
  if (/\bcontrast\s+administered\b/.test(t)) return true;
  for (const c of CLASSES) {
    if (c.agents.some((a) => t.includes(a))) return true;
  }
  return false;
}

// The contrast class implied by a modality word (structured imaging path).
function classFromModality(
  modality: string | null | undefined
): ContrastClass | null {
  const m = normalize(modality);
  if (!m) return null;
  for (const c of CLASSES) {
    if (c.modalities.some((mod) => m === mod || m.includes(mod)))
      return c.class;
  }
  return null;
}

// The contrast class implied by free text: a named AGENT wins (most specific), else a
// modality word. Gadolinium is checked with the same precedence as iodinated — the
// agent/modality vocabularies are disjoint, so at most one class matches.
function classFromText(t: string): ContrastClass | null {
  for (const c of CLASSES) {
    if (c.agents.some((a) => t.includes(a))) return c.class;
  }
  for (const c of CLASSES) {
    if (c.modalities.some((mod) => new RegExp(`\\b${mod}\\b`).test(t)))
      return c.class;
  }
  return null;
}

// Parse a candidate into a PlannedContrastStudy, or null when it isn't a (parseable)
// contrast study. A structured imaging row (contrastFlag true) is a contrast study by
// construction; a free-text candidate must indicate contrast and not be negated.
export function parsePlannedStudy(
  input: PlannedStudyInput
): PlannedContrastStudy | null {
  const t = normalize(`${input.text} ${input.contrastAgent ?? ""}`);
  const structured = input.contrastFlag === true;
  if (!structured) {
    if (!indicatesContrast(t)) return null;
    if (negatesContrast(t)) return null;
  }
  const contrastClass =
    classFromModality(input.modality) ??
    classFromText(t) ??
    classFromText(normalize(input.contrastAgent));
  if (!contrastClass) return null;
  const label =
    (input.label ?? input.text).trim() || CLASS_LABEL[contrastClass];
  return {
    source: input.source,
    sourceId: input.sourceId,
    contrastClass,
    label,
    date: input.date,
  };
}

// ---- CKD recognition ------------------------------------------------------

// The first active condition (original label) that maps to CKD via the shared
// risk-stratification recognizer, or null. Reuses conditionsToRiskFactors per
// condition so the CKD stem table stays in one place (AGENTS.md — no bespoke parse).
function ckdCondition(conditions: string[]): string | null {
  for (const c of conditions) {
    if (conditionsToRiskFactors([c]).has("chronic-kidney-disease")) return c;
  }
  return null;
}

// The first active condition that indicates ADVANCED CKD (ESRD / dialysis / stage 4–5
// / eGFR < 30) — the gadolinium/NSF gate. This narrow "advanced" recognition is the
// one contrast-specific extension (risk-stratification recognizes CKD but not its
// stage). Matched over normalized text so "CKD stage 5" / "ESRD on dialysis" hit.
function advancedCkdCondition(conditions: string[]): string | null {
  for (const c of conditions) {
    const n = normalize(c);
    // Must first be a recognized CKD/renal condition, then carry an advanced marker.
    if (!conditionsToRiskFactors([c]).has("chronic-kidney-disease")) continue;
    if (
      /\besrd\b/.test(n) ||
      /\bdialysis\b/.test(n) ||
      /end stage/.test(n) ||
      /stage (?:4|5|iv|v|g4|g5)\b/.test(n)
    )
      return c;
  }
  return null;
}

// ---- Cross-check ----------------------------------------------------------

export function contrastSignalKey(
  source: ContrastStudySource,
  sourceId: number,
  gate: ContrastGate,
  contrastClass: ContrastClass
): string {
  return `contrast:${source}:${sourceId}:${gate}:${contrastClass}`;
}

// Whether a recorded allergen (already normalized) satisfies a gate keyword.
// SINGLE-word keywords keep the robust substring test — unchanged — so a stored agent
// name ("omnipaque") hits "allergic to omnipaque" and "iodine" hits "iodine allergy".
// MULTI-word keywords (issue #829, Finding 2) use an order/adjacency-insensitive
// token-set test: EVERY word of the keyword must appear as a whole token of the
// allergen, in any order — so "iv contrast" also matches "Contrast, IV" / "Contrast —
// IV", and "contrast dye" matches "Dye (Contrast)". Requiring EVERY word (not any one)
// preserves precision: an unrelated "Yellow dye 5" never satisfies "contrast dye"
// (no "contrast" token) and "IV antibiotics" never satisfies "iv contrast"/"iv dye".
function allergenMatchesKeyword(
  allergenNorm: string,
  keyword: string
): boolean {
  const kwTokens = keyword.split(" ").filter(Boolean);
  if (kwTokens.length <= 1) return allergenNorm.includes(keyword);
  const allergenTokens = new Set(allergenNorm.split(" ").filter(Boolean));
  return kwTokens.every((t) => allergenTokens.has(t));
}

// Detect every contrast-safety note between the profile's planned contrast studies and
// its recorded allergens + active conditions. Each (study, gate) yields at most one
// hit. Result is deterministically ordered (source, id, gate, class).
export function crossCheckContrast(
  studies: PlannedContrastStudy[],
  ctx: { allergens: string[]; conditions: string[] }
): ContrastHit[] {
  const allergensNorm = ctx.allergens.map((a) => ({
    original: a,
    norm: normalize(a),
  }));
  const hits: ContrastHit[] = [];

  for (const study of studies) {
    // Allergy gate.
    const allergyGate = ALLERGY_GATES.find(
      (g) => g.class === study.contrastClass
    );
    if (allergyGate) {
      // Match against the gate's generic keywords UNION the class's brand/generic agent
      // names (#829 Finding 1), using the order-insensitive keyword matcher (#829
      // Finding 2). The agents are all single-token, so they match by substring exactly
      // as they do for study-intent detection.
      const keywords = [
        ...allergyGate.allergens,
        ...CLASS_AGENTS[study.contrastClass],
      ];
      const matched = allergensNorm.find((a) =>
        keywords.some((kw) => allergenMatchesKeyword(a.norm, kw))
      );
      if (matched) {
        hits.push({
          source: study.source,
          sourceId: study.sourceId,
          contrastClass: study.contrastClass,
          studyLabel: study.label,
          gate: "allergy",
          matchedOn: matched.original,
          note: allergyGate.note,
          citation: allergyGate.source,
          dedupeKey: contrastSignalKey(
            study.source,
            study.sourceId,
            "allergy",
            study.contrastClass
          ),
        });
      }
    }

    // Renal gate.
    const renalGate = RENAL_GATES.find((g) => g.class === study.contrastClass);
    if (renalGate) {
      const matched =
        renalGate.level === "advanced"
          ? advancedCkdCondition(ctx.conditions)
          : ckdCondition(ctx.conditions);
      if (matched) {
        hits.push({
          source: study.source,
          sourceId: study.sourceId,
          contrastClass: study.contrastClass,
          studyLabel: study.label,
          gate: "renal",
          matchedOn: matched,
          note: renalGate.note,
          citation: renalGate.source,
          dedupeKey: contrastSignalKey(
            study.source,
            study.sourceId,
            "renal",
            study.contrastClass
          ),
        });
      }
    }
  }

  return hits.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.sourceId - b.sourceId ||
      a.gate.localeCompare(b.gate) ||
      a.contrastClass.localeCompare(b.contrastClass)
  );
}

// ---- Formatting (shared by every surface) ---------------------------------

// The note title: "Iodinated contrast — CT abdomen with contrast".
export function contrastTitle(hit: ContrastHit): string {
  const label = CLASS_LABEL[hit.contrastClass];
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  return `${cap} — ${hit.studyLabel}`;
}

// The informational, never-prescriptive detail: the required framing note, the fixed
// guardrail sentence, and the ACR citation.
export function contrastDetail(hit: ContrastHit): string {
  return `${hit.note} ${GUARDRAIL} Source: ${hit.citation}.`;
}
