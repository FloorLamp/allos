// The STRUCTURED rank a source states about one visit diagnosis (#2589 half 1).
//
// WHY THIS EXISTS. `encounters.diagnoses` is a "; "-joined summary of display
// names, so when a source system says "this one is the primary diagnosis" the
// only place that fact could land was list position — or, as the CCD in #2589
// did, welded into the display name itself (" - Primary"). Reading it back out
// of the name is the inference that was refuted twice: `X - Primary` and
// `Hyperparathyroidism - Secondary` are the same string shape and only clinical
// knowledge separates a rank from an etiology.
//
// FHIR states it as DATA. R4 `Encounter.diagnosis` carries `rank` (positiveInt,
// "ranking of the diagnosis (for each role type)", 1 = primary) and `use` (a
// CodeableConcept from http://terminology.hl7.org/CodeSystem/diagnosis-role)
// beside `condition`. That is evidence, not spelling, so it is captured, stored
// beside the summary (never inside it) and shown as its own badge.
//
// C-CDA gets NOTHING here, and that is a finding rather than an omission: C-CDA
// R2.1's Encounter Diagnosis act (2.16.840.1.113883.10.20.22.4.80) defines no
// rank or priority element, which is precisely why Epic flattened the word into
// the displayName. There was nowhere structured to put it. A CDA-sourced
// encounter therefore stores no ranks at all — an absence, never a guess.

// One diagnosis's structured rank, keyed by the display name exactly as it
// appears in the encounter's "; "-joined summary.
export interface VisitDiagnosisRank {
  name: string;
  // FHIR R4 Encounter.diagnosis.rank. 1 is the primary diagnosis. Absent when
  // the source stated a role but no ordering (and always absent from R5, which
  // removed the element).
  rank?: number;
  // diagnosis-role codes: AD admission, DD discharge, CC chief complaint,
  // CM comorbidity, pre-op, post-op, billing. Lower-cased on capture.
  use?: string[];
}

// diagnosis-role → the words a card shows. An unlisted code renders nothing
// rather than being echoed raw, so a source's private code cannot leak into the
// UI as though it meant something.
const USE_LABELS: Record<string, string> = {
  ad: "Admission",
  dd: "Discharge",
  cc: "Chief complaint",
  cm: "Comorbidity",
  "pre-op": "Pre-op",
  "post-op": "Post-op",
  billing: "Billing",
};

// The badge for one diagnosis, or null when the source stated nothing about it.
//
// Rank 1 is "Primary" — the one word FHIR's own definition licenses. A rank
// ABOVE 1 renders as "#2", never as "Secondary": FHIR rank 2 means "second in
// this list", while "secondary" in a diagnosis name means an etiology, and
// spending the clinical word on the ordinal one is exactly the conflation that
// sank the withdrawn work.
export function diagnosisRankBadge(entry: VisitDiagnosisRank): string | null {
  if (typeof entry.rank === "number" && Number.isInteger(entry.rank)) {
    if (entry.rank === 1) return "Primary";
    if (entry.rank > 1) return `#${entry.rank}`;
  }
  for (const u of entry.use ?? []) {
    const label = USE_LABELS[u];
    if (label) return label;
  }
  return null;
}

function normalizeEntry(raw: unknown): VisitDiagnosisRank | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;
  const out: VisitDiagnosisRank = { name };
  const rank = r.rank;
  if (typeof rank === "number" && Number.isInteger(rank) && rank >= 1)
    out.rank = rank;
  const use = Array.isArray(r.use)
    ? r.use
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean)
    : [];
  if (use.length) out.use = Array.from(new Set(use));
  // An entry that states neither is not evidence about anything; drop it rather
  // than store a row that can only ever render nothing.
  return out.rank !== undefined || out.use !== undefined ? out : null;
}

// Serialize for the encounters.diagnosis_ranks column. Null when there is
// nothing structured to say, so the column stays empty for every CDA row and
// every manually entered visit.
export function encodeDiagnosisRanks(
  entries: readonly VisitDiagnosisRank[] | null | undefined
): string | null {
  const kept = (entries ?? [])
    .map(normalizeEntry)
    .filter((e): e is VisitDiagnosisRank => e !== null);
  return kept.length ? JSON.stringify(kept) : null;
}

// Read the column back. Tolerant by construction: this is imported data that a
// user may since have edited the diagnoses text of, so a malformed or stale
// payload answers "no ranks" instead of throwing on a page render.
export function decodeDiagnosisRanks(
  json: string | null | undefined
): VisitDiagnosisRank[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(normalizeEntry)
    .filter((e): e is VisitDiagnosisRank => e !== null);
}

// Look one diagnosis name up in the decoded ranks. Matching is on the name as
// stored, case-insensitively; a name the user has since edited simply finds
// nothing, which is why a stale row is inert rather than wrong.
export function rankForDiagnosis(
  entries: readonly VisitDiagnosisRank[],
  name: string
): VisitDiagnosisRank | null {
  const key = name.trim().toLowerCase();
  return entries.find((e) => e.name.trim().toLowerCase() === key) ?? null;
}
