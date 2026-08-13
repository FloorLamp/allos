// The visit-diagnosis names an encounter carries, as ONE list (issue #2589).
//
// `encounters.diagnoses` is a "; "-joined summary column, and every producer — the CCD
// nested-problem walk, the standalone Visit Diagnoses section, the FHIR
// Encounter.diagnosis references, the AI extractor, the hand-typed textarea on the visit
// form — hands the persist layer a bare `string[]` of display names. Those producers dedup
// by BYTE equality, which is exactly what a source system defeats when it bakes the
// diagnosis RANK into the display name:
//
//   "Encounter for genetic carrier testing"
//   "Encounter for genetic carrier testing - Primary"
//
// is one diagnosis listed twice, and the pair renders as two full-width chips claiming
// two separate findings.
//
// ── Why the suffix alone is NOT evidence ──────────────────────────────────────────────
//
// "Primary" and "Secondary" are not only rank words. They are two of the most common
// CLINICAL distinguishing clauses in diagnosis names, and they arrive in the very same
// "<name> - <clause>" shape:
//
//   "Hyperparathyroidism - Primary"     vs  "Hyperparathyroidism - Secondary"
//   "Amyloidosis - Primary"             vs  "Amyloidosis - Secondary"
//   "Multiple sclerosis - Primary"      vs  "Multiple sclerosis - Secondary"
//   "Adrenal insufficiency - Secondary"
//
// Those are DIFFERENT DISEASES with different management — primary hyperparathyroidism is
// a parathyroid adenoma, secondary is a response to renal failure; AL and AA amyloidosis
// are unrelated; PPMS and SPMS are distinct courses. A rule that strips the word because
// it recognises it collapses two diagnoses into one and deletes an etiology off a lone
// row, in a column nothing else records the rank in. That is worse than the duplicate it
// was written to fix, and it is unrecoverable: the summary is rewritten in place.
//
// So the qualifier is never stripped on the strength of the WORD. It is stripped only
// against EVIDENCE, found inside the same summary:
//
//   a ranked entry collapses only when its stripped base name exactly matches
//   another entry in the SAME summary that carries no qualifier at all.
//
// That plain twin is what makes "- Primary" a rank here: the source stated the diagnosis
// once bare, so the ranked copy is the same finding wearing its rank. With no twin there
// is no evidence, and the suffix is part of the name, full stop.
//
//   ["X", "X - Primary"]             → ["X"] (rank primary recovered) — the motivating case
//   ["X - Primary", "X - Secondary"] → both survive, byte-identical — two diagnoses
//   ["X - Secondary"]                → survives, byte-identical — a lone etiology
//   ["C", "B", "A - Primary", "D"]   → unchanged, IN ORDER — nothing was deduped
//
// One further guard, in the same direction: a base name that carries two DIFFERENT
// recognized qualifiers in one summary is clinical even if a plain twin is also present.
// A visit does not rank one finding both primary and secondary, so "X; X - Primary;
// X - Secondary" reads as a bare mention plus two etiologies, and all three are kept.
// Failing to dedup costs a repeated chip; deduping wrongly costs a diagnosis.
//
// ── Order ─────────────────────────────────────────────────────────────────────────────
//
// Source order is information, and re-sorting a list nothing was removed from needs a
// reason better than "the algorithm sorts". Entries come back in the source's own order,
// EXCEPT that a recovered primary is hoisted to the front — and a rank is only ever
// recovered where a collapse actually happened, so a summary that deduped nothing is
// returned in exactly the order it arrived. Hoisting is how the rank survives at all:
// the column has no rank field, so position is the only place left to state it.
//
// Pure, so the import seam (lib/import-persist.ts), its diff-side mirror
// (lib/import-diff.ts) and both display splitters ask the SAME rule. The one-shot
// migration that heals already-stored summaries deliberately does NOT import from here —
// see the frozen copy in lib/migrations/versions/20260812-visit-diagnosis-rank-dedupe.ts
// and the reason written above it.

export const DIAGNOSIS_RANKS = ["primary", "secondary"] as const;
export type DiagnosisRank = (typeof DIAGNOSIS_RANKS)[number];

export interface VisitDiagnosis {
  // The name to store and render. A qualifier is removed ONLY where the summary carried
  // the evidence to call it a rank; with no evidence this is the raw name in full,
  // qualifier included.
  name: string;
  // The rank recovered from the summary, or null when none was evidenced. Non-null
  // implies a collapse happened for this entry — the plain twin it merged with is what
  // proved the suffix was a rank.
  rank: DiagnosisRank | null;
}

// Built FROM the closed list above, so the vocabulary has exactly one definition: a
// rank word, preceded by a spaced hyphen, at the very end of the name.
const RANK_SUFFIX_RE = new RegExp(
  `\\s+-\\s+(${DIAGNOSIS_RANKS.join("|")})\\s*$`,
  "i"
);

// Higher wins when the same diagnosis arrives twice with different ranks: an explicit
// "primary" outranks "secondary", and both outrank a name that stated no rank at all.
function rankStrength(rank: DiagnosisRank | null): number {
  if (rank === "primary") return 2;
  if (rank === "secondary") return 1;
  return 0;
}

// The CANDIDATE split of one raw display name: the base name a recognized trailing
// qualifier would leave behind, and the qualifier itself. This is a question about the
// STRING and nothing more — it decides nothing. Whether that candidate is a rank or part
// of the diagnosis is decided by normalizeVisitDiagnoses, against the rest of the
// summary, because a single name can never carry that evidence on its own.
export function parseVisitDiagnosis(raw: string): VisitDiagnosis {
  const trimmed = raw.trim();
  const m = RANK_SUFFIX_RE.exec(trimmed);
  if (!m) return { name: trimmed, rank: null };
  const name = trimmed.slice(0, m.index).trim();
  // A name that is ONLY the qualifier ("- Primary") names no diagnosis; keep it verbatim
  // rather than reducing it to an empty chip.
  if (!name) return { name: trimmed, rank: null };
  return { name, rank: m[1].toLowerCase() as DiagnosisRank };
}

// The encounter's diagnoses as an evidence-deduplicated, rank-aware list. See the header:
// a qualifier is read as a rank only where the same summary also carries the bare name,
// and only where that base is not also wearing a second, different qualifier.
export function normalizeVisitDiagnoses(
  raw: readonly string[]
): VisitDiagnosis[] {
  const parsed = raw
    .map((r) => ({
      full: (r ?? "").trim(),
      candidate: parseVisitDiagnosis(r ?? ""),
    }))
    .filter((p) => p.full !== "");

  // The bare names the summary states with no qualifier at all — the evidence set.
  const plainKeys = new Set(
    parsed
      .filter((p) => p.candidate.rank === null)
      .map((p) => p.candidate.name.toLowerCase())
  );
  // Base names wearing more than one DISTINCT qualifier: clinical variants, not a rank.
  const qualifiersByBase = new Map<string, Set<DiagnosisRank>>();
  for (const p of parsed) {
    if (p.candidate.rank === null) continue;
    const key = p.candidate.name.toLowerCase();
    const seen = qualifiersByBase.get(key) ?? new Set<DiagnosisRank>();
    seen.add(p.candidate.rank);
    qualifiersByBase.set(key, seen);
  }

  const byKey = new Map<string, VisitDiagnosis>();
  const order: string[] = [];
  for (const p of parsed) {
    const base = p.candidate.name.toLowerCase();
    const evidenced =
      p.candidate.rank !== null &&
      plainKeys.has(base) &&
      (qualifiersByBase.get(base)?.size ?? 0) < 2;
    // With evidence the qualifier is a rank and comes off; without it the qualifier is
    // part of the diagnosis and the raw name is kept whole.
    const entry: VisitDiagnosis = evidenced
      ? { name: p.candidate.name, rank: p.candidate.rank }
      : { name: p.full, rank: null };

    const key = entry.name.toLowerCase();
    const prev = byKey.get(key);
    if (prev == null) {
      byKey.set(key, entry);
      order.push(key);
      continue;
    }
    // A byte-equal repeat, or the plain twin meeting its ranked copy. The FIRST spelling
    // is the one kept — a source that repeats a name inconsistently gets its own first
    // answer, not ours — and the strongest rank any copy stated wins.
    if (rankStrength(entry.rank) > rankStrength(prev.rank)) {
      byKey.set(key, { name: prev.name, rank: entry.rank });
    }
  }

  const entries = order.map((k) => byKey.get(k) as VisitDiagnosis);
  // Source order, except that a RECOVERED primary leads. `rank` is non-null only where a
  // collapse happened, so a summary that deduped nothing is returned untouched.
  return [
    ...entries.filter((e) => e.rank === "primary"),
    ...entries.filter((e) => e.rank !== "primary"),
  ];
}

// The stored summary column for a list of raw display names: normalized, deduped,
// joined with "; ". Empty string when nothing survives — the persist seam stores NULL
// for that, the diff seam stores "".
export function joinVisitDiagnoses(raw: readonly string[]): string {
  return normalizeVisitDiagnoses(raw)
    .map((d) => d.name)
    .join("; ");
}

// The stored summary column split back into individual names. Splits on the delimiter
// with any surrounding whitespace, so it matches the join exactly (the same split the
// Visits list and the full-account export already do).
export function splitVisitDiagnosisSummary(
  summary: string | null | undefined
): string[] {
  if (!summary) return [];
  return summary
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A stored summary re-normalized in place — the migration's whole job. Null when the
// summary holds no diagnosis at all, so an empty column stays empty rather than
// becoming "".
export function normalizeVisitDiagnosisSummary(
  summary: string | null | undefined
): string | null {
  const joined = joinVisitDiagnoses(splitVisitDiagnosisSummary(summary));
  return joined === "" ? null : joined;
}
