// Per-biomarker retest cadence lookup (issue #213, Phase 2). Reads the curated
// `retest_days` off the committed canonical dataset — the same static JSON the
// flags-signature module imports — and exposes it keyed by canonical name. No DB
// or network: it's a pure map over a bundled asset, so the Upcoming retest signal
// can pick a per-analyte cadence (HbA1c quarterly, TSH every 6 months, lipids
// annual) without a schema change to the canonical_biomarkers table. AI-discovered
// analytes and uncurated rows carry no retest_days and fall back to the flat
// DEFAULT_RETEST_DAYS in lib/reference-range.retestIntervalDays.

import canonicalSeed from "./canonical-biomarkers.json";

interface RetestRow {
  name?: string;
  retest_days?: number | null;
}

// Lowercased canonical name → curated retest_days. Built once at module load.
const RETEST_BY_NAME: Map<string, number> = (() => {
  const map = new Map<string, number>();
  const rows = (canonicalSeed as { biomarkers?: RetestRow[] }).biomarkers ?? [];
  for (const r of rows) {
    if (r?.name && typeof r.retest_days === "number" && r.retest_days > 0) {
      map.set(r.name.toLowerCase(), r.retest_days);
    }
  }
  return map;
})();

// The curated retest cadence (days) for a canonical biomarker name, or null when
// the analyte has no curated interval (the caller then falls back to the default).
// Case-insensitive on the canonical name, matching the canonical_biomarkers PK.
export function retestDaysForBiomarker(
  name: string | null | undefined
): number | null {
  if (!name) return null;
  return RETEST_BY_NAME.get(name.trim().toLowerCase()) ?? null;
}
