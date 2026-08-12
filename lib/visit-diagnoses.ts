// The visit-diagnosis names an encounter carries, as ONE list (issue #2589).
//
// `encounters.diagnoses` is a "; "-joined summary column, and every producer — the CCD
// nested-problem walk, the standalone Visit Diagnoses section, the FHIR
// Encounter.diagnosis references, the AI extractor — hands the persist layer a bare
// `string[]` of display names. Those producers dedup by BYTE equality, which is exactly
// what a source system defeats when it bakes the diagnosis RANK into the display name:
//
//   "Encounter for genetic carrier testing"
//   "Encounter for genetic carrier testing - Primary"
//
// is one diagnosis listed twice, and the pair renders as two full-width chips claiming
// two separate findings. The rank is real information; expressing it as a suffix on the
// NAME is the defect. So this module reads the suffix back off as a signal, dedups
// case-insensitively on what remains, and orders the primary diagnosis first — the
// summary states the rank by POSITION instead of by re-writing it into a name.
//
// The qualifier list is CLOSED (`- Primary`, `- Secondary`, any casing, any surrounding
// whitespace). It is deliberately not a general "strip anything after a trailing hyphen"
// guess: clinical names legitimately carry hyphenated clauses ("Type 2 diabetes mellitus
// - uncontrolled", "Fracture of tibia - closed"), and mangling one of those would lose
// the very distinction the name exists to draw. A suffix that is not on the list is part
// of the name, full stop.
//
// Pure, so the import seam (lib/import-persist.ts), its diff-side mirror
// (lib/import-diff.ts) and the one-shot migration that heals already-stored summaries
// all normalize through the SAME rule rather than three copies of it.

export const DIAGNOSIS_RANKS = ["primary", "secondary"] as const;
export type DiagnosisRank = (typeof DIAGNOSIS_RANKS)[number];

export interface VisitDiagnosis {
  // The display name with any recognized rank qualifier removed.
  name: string;
  // The rank the source expressed as a suffix, or null when it stated none.
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

// One raw display name split into its name and the rank the source baked into it.
// A name with no recognized qualifier comes back trimmed and otherwise untouched.
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

// The encounter's diagnoses as a deduplicated, rank-aware list. Duplicates collapse
// case-insensitively on the name (the FIRST spelling is the one kept — a source that
// repeats a name inconsistently gets its own first answer, not ours), taking the
// strongest rank any of the copies stated. Primary-ranked entries come first; everything
// else keeps the source's order.
export function normalizeVisitDiagnoses(
  raw: readonly string[]
): VisitDiagnosis[] {
  const byKey = new Map<string, VisitDiagnosis>();
  const order: string[] = [];
  for (const r of raw) {
    const parsed = parseVisitDiagnosis(r ?? "");
    if (!parsed.name) continue;
    const key = parsed.name.toLowerCase();
    const prev = byKey.get(key);
    if (prev == null) {
      byKey.set(key, parsed);
      order.push(key);
      continue;
    }
    if (rankStrength(parsed.rank) > rankStrength(prev.rank)) {
      byKey.set(key, { name: prev.name, rank: parsed.rank });
    }
  }
  const entries = order.map((k) => byKey.get(k) as VisitDiagnosis);
  return [
    ...entries.filter((e) => e.rank === "primary"),
    ...entries.filter((e) => e.rank !== "primary"),
  ];
}

// The stored summary column for a list of raw display names: normalized, deduped,
// primary first, joined with "; ". Empty string when nothing survives — the persist
// seam stores NULL for that, the diff seam stores "".
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
