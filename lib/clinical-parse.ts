import type { AllergyStatus, ConditionStatus } from "./types";

// Pure, DB-free parsing/normalization for the CCD clinical-list domains —
// allergies and the problem list / conditions. The shared bits both
// extractors and the persist layer lean on live here so they stay unit-testable
// without any XML/DB: clinical-status normalization, the "no known allergies"
// negation guard, and the natural-key builders used for per-document dedup.

// ---- clinical status normalization ----

// C-CDA carries a clinical status in more than one shape: an HL7 ActStatus code on
// the concern act (active / completed / suspended / aborted), a SNOMED clinical
// status observation ("Active" 55561003, "Resolved" 413322009, "Inactive"
// 73425007), or a plain word. Collapse them all to our three-state vocabulary.
// `completed` on a *concern act* means the concern is closed → resolved.
export function normalizeClinicalStatus(
  raw: string | null | undefined
): "active" | "inactive" | "resolved" {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "active";
  if (/\bresolv/.test(v) || v === "completed" || v === "413322009")
    return "resolved";
  if (/\binactiv/.test(v) || v === "73425007") return "inactive";
  if (/\baborted\b/.test(v) || /\bsuspend/.test(v)) return "inactive";
  if (/\bactiv/.test(v) || v === "55561003") return "active";
  return "active";
}

export function toAllergyStatus(raw: string | null | undefined): AllergyStatus {
  return normalizeClinicalStatus(raw);
}

export function toConditionStatus(
  raw: string | null | undefined
): ConditionStatus {
  return normalizeClinicalStatus(raw);
}

// ---- "no known allergies" negation guard ----

// A CCD represents "no known allergies" as a NEGATED allergy assertion (an
// allergy observation with negationInd="true" and a nullFlavored/absent substance)
// and/or narrative text like "No known allergies" / "NKDA". Detect it so the
// extractor emits an explicit no-known-allergies state (an empty list) instead of
// a junk row for a substance that isn't there. `substanceName` is whatever the
// participant resolved to (null when nullFlavored).
export function isNoKnownAllergy(opts: {
  negated: boolean;
  substanceName: string | null;
  narrative: string | null;
}): boolean {
  if (opts.narrative && isNoKnownAllergyText(opts.narrative)) return true;
  // A negated assertion with no concrete substance is the "no known allergies"
  // sentinel; a negated assertion that names a substance ("no allergy to X") is
  // rare and still not a positive allergy, so we drop it too.
  if (opts.negated && !opts.substanceName?.trim()) return true;
  return false;
}

// Narrative phrasings that assert the absence of allergies (case/space tolerant).
export function isNoKnownAllergyText(text: string): boolean {
  const v = text.trim().toLowerCase();
  if (!v) return false;
  if (/^nk[dm]?a\b/.test(v)) return true; // NKA / NKDA / NKMA
  if (/\bno\s+known\b.*\ballerg/.test(v)) return true;
  if (/\bno\s+active\s+allerg/.test(v)) return true;
  if (/\bnone\b/.test(v) && /\ballerg/.test(v)) return true;
  return false;
}

// Narrative phrasings that assert the absence of problems (so a "No active
// problems" section produces no junk condition row).
export function isNoKnownProblemText(text: string): boolean {
  const v = text.trim().toLowerCase();
  if (!v) return false;
  if (/\bno\s+(known\s+)?(active\s+)?problem/.test(v)) return true;
  if (/\bnone\b/.test(v) && /\bproblem/.test(v)) return true;
  return false;
}

// ---- natural-key (external_id) builders ----

const slug = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// Stable dedup key for an allergy: the coded substance when present, else its
// name, plus the onset date. Two rows sharing this key collapse to one.
export function allergyExternalId(opts: {
  substance: string;
  substanceCode?: string | null;
  onsetDate?: string | null;
}): string {
  const id = slug(opts.substanceCode) || slug(opts.substance);
  return `ccda:allergy:${id}:${opts.onsetDate ?? ""}`;
}

// Stable dedup key for a condition: the code when present, else the name, plus
// the onset date.
export function conditionExternalId(opts: {
  name: string;
  code?: string | null;
  onsetDate?: string | null;
}): string {
  const id = slug(opts.code) || slug(opts.name);
  return `ccda:condition:${id}:${opts.onsetDate ?? ""}`;
}

// Stable dedup key for a medication: the RxNorm code when present, else the drug
// name, plus the (start) date. Shared by the CCD `<substanceAdministration>`
// extractor and the FHIR MedicationRequest/MedicationStatement mapper. Mirrors the
// historical inline `ccda:rx:` key. Reprocessing the same document is idempotent
// (the persist layer deletes the document's rows before re-inserting). Cross-format
// dedup (the same drug in a CCD and a FHIR bundle) holds only when BOTH sources key
// on a comparable date: the CDA path keys on the therapy `effectiveTime` and the
// FHIR mapper prefers the effective/therapy date, but a FHIR MedicationRequest that
// carries only an order-written `authoredOn` keys on a different instant than the
// CDA effectiveTime and so may NOT collapse — a deliberate best-effort, not a
// guarantee (semantic date reconciliation is out of scope).
export function medicationExternalId(opts: {
  name: string;
  code?: string | null;
  date: string;
}): string {
  const id = slug(opts.code) || slug(opts.name);
  return `ccda:rx:${id}:${opts.date}`;
}

// Stable dedup key for a procedure: the code when present, else the name, plus the
// performed date. Shared by the CCD Procedures extractor and the FHIR Procedure
// mapper so the same procedure carried in both formats collapses to one row.
export function procedureExternalId(opts: {
  name: string;
  code?: string | null;
  date?: string | null;
}): string {
  const id = slug(opts.code) || slug(opts.name);
  return `ccda:procedure:${id}:${opts.date ?? ""}`;
}

// Stable dedup key for a family-history entry: the relative plus the condition's
// code (else its name). One row per (relation, condition) pair — shared by the CCD
// Family History organizer walk and the FHIR FamilyMemberHistory mapper.
export function familyHistoryExternalId(opts: {
  relation?: string | null;
  condition: string;
  code?: string | null;
}): string {
  const id = slug(opts.code) || slug(opts.condition);
  return `ccda:famhx:${slug(opts.relation)}:${id}`;
}

// Stable dedup key for a care-plan item: the code when present, else the
// description, plus the planned date. Shared by the CCD Plan of Treatment / Care
// Plan extractor and the FHIR CarePlan mapper so the same planned activity carried
// in both formats collapses to one row.
export function carePlanExternalId(opts: {
  description: string;
  code?: string | null;
  plannedDate?: string | null;
}): string {
  const id = slug(opts.code) || slug(opts.description);
  return `ccda:careplan:${id}:${opts.plannedDate ?? ""}`;
}

// Stable dedup key for a care goal: the code when present, else the description,
// plus the target date. Shared by the CCD Goals extractor and the FHIR Goal mapper.
export function careGoalExternalId(opts: {
  description: string;
  code?: string | null;
  targetDate?: string | null;
}): string {
  const id = slug(opts.code) || slug(opts.description);
  return `ccda:caregoal:${id}:${opts.targetDate ?? ""}`;
}
