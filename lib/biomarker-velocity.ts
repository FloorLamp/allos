// Per-biomarker velocity-threshold lookup (issue #41). Mirrors
// lib/biomarker-retest: reads the curated `velocity_per_year` off the committed
// canonical dataset — the same static JSON — keyed by canonical name. No DB or
// network: a pure map over a bundled asset, so the trajectory velocity rule can
// pick a per-analyte rate (eGFR decline, PSA rise) without a schema change to the
// canonical_biomarkers table. Analytes without a curated threshold (the vast
// majority) carry none and get no velocity rule.

import { CANONICAL_BIOMARKERS } from "./datasets/canonical-biomarkers";

// Lowercased canonical name → curated velocity_per_year (canonical units/year).
// Built once at module load over the framework read layer (the same committed rows
// the boot task seeds).
const VELOCITY_BY_NAME: Map<string, number> = (() => {
  const map = new Map<string, number>();
  const rows = CANONICAL_BIOMARKERS;
  for (const r of rows) {
    if (
      r?.name &&
      typeof r.velocity_per_year === "number" &&
      r.velocity_per_year > 0
    ) {
      map.set(r.name.toLowerCase(), r.velocity_per_year);
    }
  }
  return map;
})();

// The curated velocity threshold (canonical units/year) for a canonical biomarker
// name, or null when the analyte has no curated threshold (the caller then skips
// the velocity rule). Case-insensitive on the canonical name.
export function velocityPerYearForBiomarker(
  name: string | null | undefined
): number | null {
  if (!name) return null;
  return VELOCITY_BY_NAME.get(name.trim().toLowerCase()) ?? null;
}
