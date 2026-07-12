// Coverage-gap detection + fill decisions (issue #550), PURE — no DB, no network.
//
// A "coverage gap" is a biomarker / medication / condition a profile has on file
// that the app's CURATED catalogs don't cover, so the app can't provide context
// (reference range, flag, retest cadence, interactions, description) and silently
// degrades to defaults. This module derives the gap set from a profile's stored
// names + the curated catalogs, keys each gap on a stable REUSABLE identity, and
// builds the two fill artifacts — the de-identified maintainer catalog-request and
// the AI-enrichment prompt. It imports only other pure modules (the canonical-name
// family folder and the bundled med/condition catalogs), so it's unit-tested in
// the pure suite; the DB read/write half lives in lib/queries/coverage.ts and the
// AI call in lib/coverage-enrich.ts.
//
// AI-FILL SAFETY BOUNDARY (issue #550 decision A): the AI fill path produces
// DESCRIPTIVE context ONLY — what the analyte/med/condition is and its general
// purpose — and MUST NOT synthesize reference ranges, flag thresholds, retest
// cadences, or interaction severities. Those drive the flag/retest/interaction
// engines and stay CURATED. The AI system prompt below enforces the line, and the
// stored text is always labeled "AI-generated, unverified — not curated."

import { biomarkerFamily } from "./canonical-name";
import { getMedicationInfo } from "./medication-info";
import { bestIcd10Suggestion, hasIcd10Code } from "./icd10";

export type CoverageGapKind = "biomarker" | "medication" | "condition";

export const COVERAGE_GAP_KINDS: readonly CoverageGapKind[] = [
  "biomarker",
  "medication",
  "condition",
];

// A registry row (a gap the user opted in to track), enriched with the live
// "covered now?" verdict the query layer computes against the current catalogs.
export interface CoverageGap {
  id: number;
  kind: CoverageGapKind;
  itemKey: string;
  label: string;
  aiDescription: string | null;
  aiSource: string | null;
  aiGeneratedAt: string | null;
  createdAt: string;
  // Set by the query layer: true once the current curated catalog covers this
  // item (the "now available" state). Persisted registry row + live verdict.
  covered: boolean;
}

// A derivable gap candidate not yet in the registry — offered for opt-in.
export interface CoverageGapCandidate {
  kind: CoverageGapKind;
  itemKey: string;
  label: string;
}

// ---- Stable identity keys ---------------------------------------------------

// The biomarker coverage key is the #482 FAMILY identity (lowercased), so all
// spellings of one analyte (every Vitamin-D / A1c variant) share one gap and the
// curated-vs-used comparison folds the same way the retest/star keys do.
export function biomarkerCoverageKey(name: string): string {
  return biomarkerFamily(name).toLowerCase().trim();
}

// The medication coverage key is the normalized generic name — the SAME key
// getMedicationInfo() looks up, so a covered check and the key agree.
export function medicationCoverageKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// The condition coverage key is the ICD-10 code when coded, else the lowercased
// name (codes and names both recycle, but this is only an identity for the
// user's own registry, re-derived on read).
export function conditionCoverageKey(
  name: string | null | undefined,
  code: string | null | undefined
): string {
  const c = (code ?? "").trim();
  if (c) return c.toUpperCase();
  return (name ?? "").trim().toLowerCase();
}

// ---- Per-item "is it covered by a curated catalog?" predicates --------------

// Biomarker coverage is DB-derived (the curated canonical_biomarkers rows), so the
// caller passes the set of curated family keys (curatedBiomarkerFamilyKeys below).
export function isBiomarkerCovered(
  name: string,
  curatedFamilyKeys: ReadonlySet<string>
): boolean {
  return curatedFamilyKeys.has(biomarkerCoverageKey(name));
}

export function isMedicationCovered(name: string): boolean {
  return getMedicationInfo(name) != null;
}

// A condition is "covered" when we can attach an ICD-10 code — either it already
// carries a valid code in the curated set, or its name resolves to a suggestion.
export function isConditionCovered(
  name: string | null | undefined,
  code: string | null | undefined
): boolean {
  const c = (code ?? "").trim();
  if (c && hasIcd10Code(c)) return true;
  return bestIcd10Suggestion(name ?? "") != null;
}

// Fold a list of curated canonical biomarker names into the set of family keys
// used by isBiomarkerCovered. Pass ONLY curated (source='seed') names — an
// AI-coined ('ai') canonical row is itself an uncovered gap, so including it
// would mask the very gaps this feature surfaces.
export function curatedBiomarkerFamilyKeys(
  curatedNames: readonly string[]
): Set<string> {
  const set = new Set<string>();
  for (const n of curatedNames) {
    const k = biomarkerCoverageKey(n);
    if (k) set.add(k);
  }
  return set;
}

// ---- Detection --------------------------------------------------------------

// Given a profile's stored biomarker names and the curated family-key set, the
// uncovered ones as gap candidates (one per family, first spelling wins as the
// label). De-duped by family key so two spellings of one uncovered analyte fold
// to a single candidate.
export function detectBiomarkerGaps(
  usedNames: readonly string[],
  curatedFamilyKeys: ReadonlySet<string>
): CoverageGapCandidate[] {
  const seen = new Set<string>();
  const out: CoverageGapCandidate[] = [];
  for (const name of usedNames) {
    const label = name.trim();
    if (!label) continue;
    const key = biomarkerCoverageKey(label);
    if (!key || curatedFamilyKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "biomarker", itemKey: key, label });
  }
  return out;
}

// ---- The de-identified maintainer catalog-request (issue #550 decision B) ----
//
// User-mediated ONLY: never an automatic POST. This builds the text the user
// reviews and files (copy-to-clipboard or a prefilled GitHub-issue link). It
// carries the canonical NAME/CODE of the missing item ONLY — never the user's
// values, dates, or any profile identifier — matching the repo's never-auto-egress
// ethos (phi-scan, gitignored /data). A canonical biomarker name / drug name /
// ICD-10 code is not PHI: it's the label of a public clinical concept.

const REPO_SLUG = "FloorLamp/allos";

const KIND_NOUN: Record<CoverageGapKind, string> = {
  biomarker: "biomarker / lab analyte",
  medication: "medication",
  condition: "condition",
};

export interface CatalogRequest {
  title: string;
  body: string;
  // A prefilled "new issue" URL the user reviews then submits themselves.
  issueUrl: string;
}

export function buildCatalogRequest(
  kind: CoverageGapKind,
  label: string,
  itemKey: string
): CatalogRequest {
  const noun = KIND_NOUN[kind];
  const cleanLabel = label.trim();
  const title = `Catalog coverage: add ${noun} "${cleanLabel}"`;
  const body = [
    `The Allos curated ${noun} catalog does not cover the following item, so the`,
    `app can't provide reference context for it:`,
    ``,
    `- Kind: ${kind}`,
    `- Name: ${cleanLabel}`,
    `- Identity key: ${itemKey}`,
    ``,
    `Please consider adding it to the curated catalog. This request contains only`,
    `the item's public clinical name/code — no personal values, dates, or profile`,
    `data.`,
  ].join("\n");
  const issueUrl =
    `https://github.com/${REPO_SLUG}/issues/new?` +
    `title=${encodeURIComponent(title)}` +
    `&body=${encodeURIComponent(body)}` +
    `&labels=${encodeURIComponent("catalog-coverage")}`;
  return { title, body, issueUrl };
}

// ---- The AI descriptive-enrichment prompt (issue #550 decision A) -----------

// The hard line: descriptive context ONLY, never clinical thresholds. Kept as an
// exported constant so a unit test can pin that the bar is present and the
// coverage-enrich caller and any future surface share ONE prompt.
export const COVERAGE_ENRICH_SYSTEM = [
  "You write brief, neutral, educational descriptions of clinical concepts for a",
  "personal health app. You are given the NAME of a biomarker, medication, or",
  "condition that the app's curated catalog does not yet cover.",
  "",
  "Write 1-3 plain-language sentences: what it is and, in general terms, why it",
  "matters or what it is commonly used for. Informational only.",
  "",
  "HARD RULES — you MUST follow these:",
  "- Do NOT state any reference range, normal range, cutoff, or numeric threshold.",
  "- Do NOT state a flag (high/low/abnormal) or how to interpret a specific value.",
  "- Do NOT state a retest cadence, dose, interaction, or interaction severity.",
  "- Do NOT give personal medical advice, diagnosis, or dosing.",
  "- End with a brief 'discuss with your provider' style pointer.",
  "If you cannot describe the item safely, return an empty description.",
].join("\n");

export function buildEnrichPrompt(
  kind: CoverageGapKind,
  label: string
): string {
  return `Describe this ${KIND_NOUN[kind]}: "${label.trim()}".`;
}

// Sanity clamp for a stored AI description (defense in depth against a runaway
// model): trim and cap length. Descriptive text is short by construction.
export function clampAiDescription(text: string): string {
  return text.trim().slice(0, 1200);
}
