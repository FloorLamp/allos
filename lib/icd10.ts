// ICD-10-CM condition-code suggestion + the read-layer de-dup collapse key (#155).
//
// Pure: no DB, no network. Reads the committed lib/icd10-common.json (a curated
// COMMON-conditions subset of public-domain ICD-10-CM codes — see scripts/gen-icd10.ts)
// and offers a best-effort code SUGGESTION for a free-text condition name, which the
// user CONFIRMS at entry (the condition form). Imported conditions already carrying a
// coded identity keep it — this only fills a code-less row.

import icd10 from "./icd10-common.json";
import { fuzzyScore } from "./fuzzy";

// The stored code_system for every suggestion. Matches lib/fhir/common.ts's
// systemLabel() so an exported condition's coding re-imports as this same label,
// and lib/fhir-export.ts emits the canonical http://hl7.org/fhir/sid/icd-10-cm URI.
export const ICD10_SYSTEM = "ICD-10-CM";

// A shorter query is too ambiguous to suggest from (2-char abbreviations like "MI"
// or "MS" would match dozens of rows), so the matcher returns nothing below this.
const MIN_QUERY_LENGTH = 3;

// An exact (case-insensitive) name/synonym hit is a far stronger signal than any
// subsequence score, so it's boosted above every fuzzy match.
const EXACT_BOOST = 1000;

export interface Icd10Entry {
  code: string;
  name: string;
  synonyms: string[];
}

export interface Icd10Suggestion {
  code: string;
  name: string;
  score: number;
}

const ENTRIES = icd10.conditions as Icd10Entry[];

// Rank the curated ICD-10-CM entries against a free-text condition name and return
// the best few, highest score first. Each entry is scored by the BEST fuzzy match
// over its display name AND its synonyms (so "high blood pressure" finds I10 via a
// synonym even though the name is "Essential (primary) hypertension"); an exact
// name/synonym match is boosted above every fuzzy one. A query shorter than
// MIN_QUERY_LENGTH, or one that subsequence-matches nothing, yields [].
export function suggestIcd10(query: string, limit = 5): Icd10Suggestion[] {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];
  const ql = q.toLowerCase();

  const out: Icd10Suggestion[] = [];
  for (const e of ENTRIES) {
    let best: number | null = null;
    for (const term of [e.name, ...e.synonyms]) {
      const s = fuzzyScore(term, q);
      if (s == null) continue;
      const score = term.toLowerCase() === ql ? s + EXACT_BOOST : s;
      if (best == null || score > best) best = score;
    }
    if (best != null) out.push({ code: e.code, name: e.name, score: best });
  }
  // Highest score first; ties break by code for a stable, deterministic order.
  out.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return out.slice(0, limit);
}

// The single best suggestion for a name, or null when nothing matches. The condition
// form shows this as the confirm-to-apply chip.
export function bestIcd10Suggestion(query: string): Icd10Suggestion | null {
  return suggestIcd10(query, 1)[0] ?? null;
}

// The set of curated ICD-10-CM codes (uppercased), built once. Used by the
// coverage-gap check (#550) to tell whether a condition's existing code is one the
// curated catalog actually knows.
const CODE_SET: Set<string> = new Set(
  ENTRIES.map((e) => e.code.trim().toUpperCase())
);

// Whether a code is present in the curated ICD-10-CM subset (case-insensitive).
export function hasIcd10Code(code: string | null | undefined): boolean {
  const c = (code ?? "").trim().toUpperCase();
  return c ? CODE_SET.has(c) : false;
}

// The read-layer condition de-dup collapse key (#134, strengthened by #155). A row
// that carries a code collapses on its CODE identity ('code:<code>'); an uncoded row
// falls back to its normalized NAME ('name:<lower name>'). The 'code:'/'name:'
// prefixes keep the two namespaces from ever colliding. Code beats name: two rows
// that share a code collapse even if their display names differ (e.g. "Type 2
// diabetes" vs "T2DM" both coded E11.9), and a coded row never collapses with an
// uncoded same-name row (conservative — they may be genuinely distinct).
//
// This is the PURE mirror of the COALESCE key built inline in
// lib/queries/clinical.ts's conditionRepresentativeIds() SQL; a db-tier test asserts
// the SQL groups rows the same way this function keys them, so the two can't drift.
export function conditionCollapseKey(row: {
  code?: string | null;
  name: string;
}): string {
  const code = (row.code ?? "").trim();
  if (code) return `code:${code}`;
  return `name:${row.name.trim().toLowerCase()}`;
}
