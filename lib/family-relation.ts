// The genetic axis of a family-history relative (issue #1407). ONE pure layer: the
// coercions every write and import boundary runs, the GENETIC PREDICATE the risk /
// screening-cadence engine gates on, and the ONE relative label every surface
// renders.
//
// Why the predicate exists: `relation` is free text with no genetic axis, so before
// this an ADOPTED parent's coronary disease weighed exactly like a biological
// parent's. A genetic-risk read that treats an adopted parent's history as
// hereditary is not a rounding error — it is wrong, and it is the reason this
// module and not just the columns.
//
// The default: an UNSTATED relation_type (NULL) is read as GENETIC. Family history
// is hereditary by default (FHIR FamilyMemberHistory.relationship likewise), every
// row written before migration 144 is a genetic assertion, and only an EXPLICIT
// adopted/step marking excludes a relative. Absence stays absence — nothing here
// invents a discriminator the user never stated.
//
// PURE (no DB/network/clock): unit-tested in lib/__tests__/family-relation.test.ts.

import {
  FAMILY_LINEAGES,
  FAMILY_RELATION_TYPES,
  type FamilyLineage,
  type FamilyRelationType,
} from "./types/medical";

// Coerce a stated relation type onto the enum; anything off-vocabulary → null
// (unstated), so an odd import string can never fail the CHECK on insert.
export function toFamilyRelationType(raw: unknown): FamilyRelationType | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return FAMILY_RELATION_TYPES.find((v) => v === s) ?? null;
}

// Coerce a stated family side onto the enum; anything else → null.
export function toFamilyLineage(raw: unknown): FamilyLineage | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return FAMILY_LINEAGES.find((v) => v === s) ?? null;
}

// THE PREDICATE the risk engine gates on: does this relative's history carry
// hereditary weight? `genetic` and `half` do (a half-sibling shares half the genome
// a full sibling does — reduced weight, not zero); `adopted` and `step` do not.
// NULL/undefined → true, the hereditary-by-default reading documented above.
export function isGeneticRelative(
  relationType: FamilyRelationType | null | undefined
): boolean {
  return relationType !== "adopted" && relationType !== "step";
}

// HL7 v3 RoleCode values that carry the discriminator in the CODE itself — the CDA
// relatedSubject code and the FHIR FamilyMemberHistory.relationship coding. Only the
// codes whose meaning is unambiguous appear here; anything else stays unstated.
const ROLE_CODE_FACTS: Record<
  string,
  { relationType?: FamilyRelationType; lineage?: FamilyLineage }
> = {
  // Natural (biological) parents — an explicit genetic assertion.
  NMTH: { relationType: "genetic" },
  NFTH: { relationType: "genetic" },
  NPRN: { relationType: "genetic" },
  NSIS: { relationType: "genetic" },
  NBRO: { relationType: "genetic" },
  NSIB: { relationType: "genetic" },
  // Half siblings — genetic, at half weight.
  HSIS: { relationType: "half" },
  HBRO: { relationType: "half" },
  HSIB: { relationType: "half" },
  // Adoptive / step relatives — NOT genetic.
  ADOPTM: { relationType: "adopted" },
  ADOPTF: { relationType: "adopted" },
  ADOPTP: { relationType: "adopted" },
  STPMTH: { relationType: "step" },
  STPFTH: { relationType: "step" },
  STPPRN: { relationType: "step" },
  STPSIS: { relationType: "step" },
  STPBRO: { relationType: "step" },
  STPSIB: { relationType: "step" },
  // Lineage-bearing codes: which side of the family the relative sits on.
  MGRMTH: { lineage: "maternal" },
  MGRFTH: { lineage: "maternal" },
  MGRPRN: { lineage: "maternal" },
  MAUNT: { lineage: "maternal" },
  MUNCLE: { lineage: "maternal" },
  MCOUSN: { lineage: "maternal" },
  PGRMTH: { lineage: "paternal" },
  PGRFTH: { lineage: "paternal" },
  PGRPRN: { lineage: "paternal" },
  PAUNT: { lineage: "paternal" },
  PUNCLE: { lineage: "paternal" },
  PCOUSN: { lineage: "paternal" },
};

// Free-text relationship displays that state the discriminator in words, for the
// (common) source that sends a display name and no usable code. Word-boundary
// matched: "stepmother" must not be read off "Stepmother's mother" ambiguity, and a
// bare "mother" must never be read as a step relationship.
const TEXT_FACTS: {
  re: RegExp;
  relationType?: FamilyRelationType;
  lineage?: FamilyLineage;
}[] = [
  { re: /\bhalf[-\s]?(sister|brother|sibling)\b/i, relationType: "half" },
  { re: /\badopt(ed|ive)\b/i, relationType: "adopted" },
  {
    re: /\bstep[-\s]?(mother|father|parent|sister|brother|sibling)\b/i,
    relationType: "step",
  },
  { re: /\bmaternal\b/i, lineage: "maternal" },
  { re: /\bpaternal\b/i, lineage: "paternal" },
];

// What a source's relationship code and/or display name STATE about the genetic axis
// and the family side. Used by both importers (CDA relatedSubject, FHIR
// FamilyMemberHistory.relationship) so the two can't drift. Silent (both null) when
// the source says nothing — an unstated discriminator is left unstated.
export function familyRelationFacts(
  code: string | null | undefined,
  display?: string | null
): { relationType: FamilyRelationType | null; lineage: FamilyLineage | null } {
  let relationType: FamilyRelationType | null = null;
  let lineage: FamilyLineage | null = null;
  const key = typeof code === "string" ? code.trim().toUpperCase() : "";
  const byCode = key ? ROLE_CODE_FACTS[key] : undefined;
  if (byCode) {
    relationType = byCode.relationType ?? null;
    lineage = byCode.lineage ?? null;
  }
  const text = typeof display === "string" ? display : "";
  if (text) {
    for (const f of TEXT_FACTS) {
      if (!f.re.test(text)) continue;
      if (f.relationType && !relationType) relationType = f.relationType;
      if (f.lineage && !lineage) lineage = f.lineage;
    }
  }
  return { relationType, lineage };
}

// The fields the label builders read — a structural subset of FamilyHistory, so a
// stored row, an import projection and a test fixture all satisfy it directly.
export interface FamilyRelativeAttributes {
  relation?: string | null;
  relation_type?: FamilyRelationType | null;
  lineage?: FamilyLineage | null;
}

const TYPE_LABEL: Record<FamilyRelationType, string | null> = {
  // The default reading needs no qualifier — every unqualified relative is genetic.
  genetic: null,
  half: "half",
  adopted: "adopted",
  step: "step",
};

// The display name for a relative, discriminator included — the #531 rule applied to
// family history: "Father" and "Father (adopted)" are different clinical claims and
// must not render identically. A qualifier the `relation` text already carries
// ("Maternal grandmother", "Half-sister") is not repeated.
export function familyRelativeLabel(f: FamilyRelativeAttributes): string {
  const base = f.relation?.trim() || "Relative";
  const stated = familyRelationFacts(null, base);
  const quals: string[] = [];
  const typeLabel = f.relation_type ? TYPE_LABEL[f.relation_type] : null;
  if (typeLabel && stated.relationType !== f.relation_type)
    quals.push(typeLabel);
  if (f.lineage && stated.lineage !== f.lineage) quals.push(f.lineage);
  return quals.length ? `${base} (${quals.join(", ")})` : base;
}

// The death facts a family-history row states, as one calm line: "Died at 52 —
// Myocardial infarction". Null when the row asserts no death at all (`deceased` 0 or
// unknown AND no death fact recorded) — absence is never rendered as a claim. An
// age or a cause on their own each imply the death they describe.
export function familyDeathLabel(f: {
  deceased?: number | null;
  age_at_death?: number | null;
  cause_of_death?: string | null;
}): string | null {
  const cause = f.cause_of_death?.trim() || null;
  const age = f.age_at_death ?? null;
  const died = f.deceased === 1 || age != null || cause != null;
  if (!died) return null;
  const head = age != null ? `Died at ${age}` : "Deceased";
  return cause ? `${head} — ${cause}` : head;
}
