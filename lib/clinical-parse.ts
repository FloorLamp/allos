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

// ---- imported-condition status/date intelligence (issue #590) ----
//
// CCD/FHIR imports routinely leave the problem list polluted with permanently
// "active" non-conditions: a "Fever" visit diagnosis from a years-old urgent-care
// visit, "Single liveborn, born in hospital" (a birth EVENT), etc. The document's
// status fallbacks default to "active" (a missing clinical status, and Epic's
// concern-act tracking statusCode which stays "active" even for long-past problems),
// and a standalone visit diagnosis is inherently episodic yet lands as a permanent
// active condition.
//
// The rule here only ever moves a condition in ONE direction — active → resolved —
// and never invents an active status. It fires for three families, and an EXPLICIT
// clinical-status observation is always authoritative (never downgraded):
//   (b) birth-event / episodic codes (ICD-10 Z38.*, SNOMED liveborn findings,
//       leaked "encounter for…" Z-codes) — an event, not an ongoing condition.
//   (c) a conservatively-curated self-limited/acute name past a ~90-day horizon
//       (problem-list) or unconditionally (an episodic visit diagnosis).
// This is INFORMATIONAL curation (same precedent as RETEST_WORTHY / RISK_RULES), and
// import-path only — a manual/user-entered condition is never touched.

const SELF_LIMITED_HORIZON_DAYS = 90;

// ICD-10 chapter Z38 = "liveborn infants according to place of birth and type of
// delivery" — a birth event recorded on the newborn's chart, never a condition.
const BIRTH_EVENT_ICD10 = /^z38(?:[.a-z0-9]*)?$/i;

// SNOMED findings that assert a liveborn birth event ("Single liveborn", "Liveborn
// born in hospital", …). The coded identity is the reliable signal; the name check
// (below) is the backstop for narrative-only rows.
const LIVEBORN_SNOMED = new Set([
  "281050002", // Liveborn
  "442311008", // Born in hospital
  "169826009", // Single live birth
  "3950001", // Birth
]);

// A birth event / episodic-encounter code that should never sit on the active
// problem list. Detects Z38.* (ICD-10), liveborn SNOMED findings, and — by name —
// the "encounter for…" Z-codes and liveborn narratives that leak into problem lists.
export function isBirthEventOrEpisodic(input: {
  name: string;
  code?: string | null;
}): boolean {
  const code = (input.code ?? "").trim();
  if (code && BIRTH_EVENT_ICD10.test(code)) return true;
  if (code && LIVEBORN_SNOMED.has(code)) return true;
  const n = input.name.toLowerCase();
  if (/\blive\s?born\b/.test(n)) return true;
  if (/\bsingle liveborn\b/.test(n)) return true;
  // Leaked "encounter for …" Z-codes (e.g. "Encounter for immunization",
  // "Encounter for screening") — the encounter is the event, not a condition.
  if (/^encounter for\b/.test(n.trim())) return true;
  return false;
}

// Chronic-capable / recurrent condition families that must NEVER be treated as
// self-limited, even when a substring would match the acute list ("chronic
// sinusitis" contains "sinusitis"; "allergic rhinitis" contains "rhinitis"). This
// is the exclusion discipline — the guard wins over any acute match.
const CHRONIC_CAPABLE =
  /\b(?:chronic|hypertension|hypertensive|asthma|diabet|copd|emphysema|heart failure|\bchf\b|cardiomyopathy|coronary|chronic kidney|\bckd\b|allergic|migraine|hyperlipidemia|hypercholesterol|dyslipidemia|hypothyroid|hyperthyroid|depress|anxiety|arthritis|\bgerd\b|gastroesophageal reflux|epilepsy|seizure disorder|cancer|malignan|neoplasm|obesity|osteoporosis|osteoarthritis|fibromyalgia|apnea|eczema|psoriasis|recurrent)\b/;

// Curated acute / self-limited condition names (conservative — matches the issue's
// exemplars plus the common acute infections). Kept deliberately tight; the
// CHRONIC_CAPABLE guard above excludes any chronic-capable relative first.
const SELF_LIMITED_NAME =
  /\b(?:fever|febrile|acute upper respiratory|upper respiratory (?:tract )?infection|viral (?:syndrome|infection|illness)|otitis media|influenza|\bflu\b|cough|pharyngitis|sore throat|strep(?:tococcal)? throat|tonsillitis|bronchitis|sinusitis|nasopharyngitis|common cold|laryngitis|croup|conjunctivitis|rhinitis|gastroenteritis|\bnausea\b|vomiting|diarrhea)\b/;

// ICD-10 code prefixes for the same acute set — a backstop when the narrative name
// is unusual. Deliberately excludes chronic siblings (no J41 chronic bronchitis /
// J44 COPD; only J20 acute bronchitis).
const SELF_LIMITED_ICD10 =
  /^(?:R05|R11|R50|J00|J01|J02|J03|J04|J06|J10|J11|J20|H65|H66|H10|A08|A09|B34)(?:[.a-z0-9]*)?$/i;

// Whether a condition is on the curated self-limited/acute list. The chronic-capable
// guard is applied first so a chronic relative never qualifies.
export function isSelfLimitedCondition(input: {
  name: string;
  code?: string | null;
}): boolean {
  const n = input.name.toLowerCase();
  if (CHRONIC_CAPABLE.test(n)) return false;
  if (SELF_LIMITED_NAME.test(n)) return true;
  const code = (input.code ?? "").trim();
  if (code && SELF_LIMITED_ICD10.test(code)) return true;
  return false;
}

// Whether an ISO date (YYYY-MM-DD) is older than the horizon relative to `now`.
// A null/unparseable date is NOT stale (we can't age it — "undated keeps today's
// behavior"): the self-limited horizon downgrade needs a real date to fire.
function isOlderThanHorizon(
  onsetDate: string | null,
  now: Date,
  horizonDays: number
): boolean {
  if (!onsetDate) return false;
  const t = Date.parse(onsetDate);
  if (Number.isNaN(t)) return false;
  const ageMs = now.getTime() - t;
  return ageMs > horizonDays * 24 * 60 * 60 * 1000;
}

// The pure import-time decision: given a mapped condition's status/onset and its
// provenance, return the possibly-DOWNGRADED status + dates. Only ever active →
// resolved; an explicit clinical-status observation is authoritative and passes
// through untouched. `episodic` marks a standalone visit diagnosis (a snapshot of a
// past visit): a self-limited episodic dx is resolved unconditionally, while a
// problem-list entry is only downgraded once its onset is older than the horizon.
export function decideImportedConditionStatus(input: {
  name: string;
  code: string | null;
  status: ConditionStatus;
  onsetDate: string | null;
  resolvedDate: string | null;
  explicitStatus: boolean;
  episodic?: boolean;
  now?: Date;
  horizonDays?: number;
}): {
  status: ConditionStatus;
  onset_date: string | null;
  resolved_date: string | null;
} {
  const passthrough = {
    status: input.status,
    onset_date: input.onsetDate,
    resolved_date: input.resolvedDate,
  };
  // Explicit clinical-status observations and anything not currently "active" are
  // left exactly as the document asserted — we never fabricate active, and never
  // override a source that took a real position.
  if (input.explicitStatus || input.status !== "active") return passthrough;

  const horizonDays = input.horizonDays ?? SELF_LIMITED_HORIZON_DAYS;
  const now = input.now ?? new Date();
  const key = { name: input.name, code: input.code };

  const isBirthEvent = isBirthEventOrEpisodic(key);
  const selfLimited = !isBirthEvent && isSelfLimitedCondition(key);
  const downgrade =
    isBirthEvent ||
    (selfLimited &&
      (input.episodic
        ? true
        : isOlderThanHorizon(input.onsetDate, now, horizonDays)));

  if (!downgrade) return passthrough;
  return {
    status: "resolved",
    onset_date: input.onsetDate,
    // We don't know a resolution date for a downgraded row; keep any the document
    // supplied, else leave it null (resolved_date null is the documented shape).
    resolved_date: input.resolvedDate,
  };
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
