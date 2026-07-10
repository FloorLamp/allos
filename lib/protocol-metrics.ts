// The outcome-metric vocabulary for N-of-1 protocols (issue #161). PURE — no DB,
// no network — so it's importable by both the server query seam (which resolves
// each key to a time-series) and the client protocol form (which offers the
// picker). A protocol declares a set of outcome-metric KEYS; a key is an opaque,
// namespaced string that names WHERE the series comes from:
//
//   biomarker:<canonical name>  — a canonical biomarker (medical_records value_num)
//   metric:resting_hr | weight | body_fat  — a body_metrics column
//   index:phenoage | sri        — a derived longevity index (PhenoAge / SRI)
//
// The FIXED metrics (body + indices) carry their label/unit/direction here;
// biomarker metrics resolve label/unit/direction from the canonical dataset at
// read time (they're per-analyte and open-ended), so they are NOT listed below.

// How "better" is judged for an outcome shift. `neutral` = goal-dependent (e.g.
// body weight can be a cut or a bulk), so the engine reports the shift without a
// good/bad verdict.
export type OutcomeDirection =
  "higher_better" | "lower_better" | "in_range" | "neutral";

export type OutcomeKind = "biomarker" | "body" | "index";

export interface OutcomeMetricDef {
  key: string;
  label: string;
  unit: string | null;
  direction: OutcomeDirection;
  kind: OutcomeKind;
}

// The fixed (non-biomarker) outcome metrics, offered in the picker alongside the
// profile's tracked biomarkers. Body-weight unit is resolved to the login's
// display preference at the query boundary (canonical storage is kg); the label
// here is the canonical fallback.
export const FIXED_OUTCOME_METRICS: OutcomeMetricDef[] = [
  {
    key: "metric:resting_hr",
    label: "Resting heart rate",
    unit: "bpm",
    direction: "lower_better",
    kind: "body",
  },
  {
    key: "metric:weight",
    label: "Body weight",
    unit: "kg",
    direction: "neutral",
    kind: "body",
  },
  {
    key: "metric:body_fat",
    label: "Body fat",
    unit: "%",
    direction: "lower_better",
    kind: "body",
  },
  {
    key: "index:phenoage",
    label: "Biological age (PhenoAge)",
    unit: "yrs",
    direction: "lower_better",
    kind: "index",
  },
  {
    key: "index:sri",
    label: "Sleep regularity (SRI)",
    unit: null,
    direction: "higher_better",
    kind: "index",
  },
];

const FIXED_BY_KEY = new Map(FIXED_OUTCOME_METRICS.map((m) => [m.key, m]));

export interface ParsedOutcomeKey {
  kind: OutcomeKind;
  // The identifier within the namespace: the canonical biomarker name, the body
  // metric column key, or the index key.
  id: string;
}

// Split a namespaced outcome key into its kind + identifier, or null when the key
// is malformed / unknown. `biomarker:` ids keep their full (possibly colon-free)
// remainder so canonical names are preserved verbatim.
export function parseOutcomeKey(key: string): ParsedOutcomeKey | null {
  const idx = key.indexOf(":");
  if (idx < 0) return null;
  const ns = key.slice(0, idx);
  const id = key.slice(idx + 1).trim();
  if (!id) return null;
  if (ns === "biomarker") return { kind: "biomarker", id };
  if (ns === "metric") {
    if (id === "resting_hr" || id === "weight" || id === "body_fat")
      return { kind: "body", id };
    return null;
  }
  if (ns === "index") {
    if (id === "phenoage" || id === "sri") return { kind: "index", id };
    return null;
  }
  return null;
}

// The display label for an outcome key. Fixed metrics use their catalog label; a
// biomarker key falls back to its canonical name (the part after "biomarker:").
export function outcomeMetricLabel(key: string): string {
  const fixed = FIXED_BY_KEY.get(key);
  if (fixed) return fixed.label;
  const parsed = parseOutcomeKey(key);
  if (parsed?.kind === "biomarker") return parsed.id;
  return key;
}

// The catalog def for a fixed key, or null for a biomarker key (resolved elsewhere).
export function fixedMetricDef(key: string): OutcomeMetricDef | null {
  return FIXED_BY_KEY.get(key) ?? null;
}

// Normalize + dedupe a user-selected set of outcome keys, dropping blanks and
// anything that doesn't parse. Order-preserving (first occurrence wins) so the
// stored set is stable. Shared by the create/update actions.
export function normalizeOutcomeKeys(keys: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    const k = (raw ?? "").trim();
    if (!k || seen.has(k)) continue;
    if (!parseOutcomeKey(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
