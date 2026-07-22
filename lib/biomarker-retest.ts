// Per-biomarker retest cadence lookup. Reads the curated
// `retest_days` off the committed canonical dataset — the same static JSON the
// flags-signature module imports — and exposes it keyed by canonical name. No DB
// or network: it's a pure map over a bundled asset, so the Upcoming retest signal
// can pick a per-analyte cadence (HbA1c quarterly, TSH every 6 months, lipids
// annual) without a schema change to the canonical_biomarkers table. AI-discovered
// analytes and uncurated rows carry no retest_days and fall back to the flat
// DEFAULT_RETEST_DAYS in lib/reference-range.retestIntervalDays.

import { CANONICAL_BIOMARKERS } from "./datasets/canonical-biomarkers";
import { RETEST_WORTHY } from "./curated-biomarkers";
import { biomarkerRetestIdentity } from "./canonical-name";

// Lowercased canonical name → curated retest_days. Built once at module load over the
// framework read layer (the same committed rows the boot task seeds).
const RETEST_BY_NAME: Map<string, number> = (() => {
  const map = new Map<string, number>();
  const rows = CANONICAL_BIOMARKERS;
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

// The retest-WORTHY families (issue #546): the RETEST-clock identity of every curated
// RETEST_WORTHY analyte, so the vitamin-D 25-OH isoforms (D2/D3/total) all inherit
// "Vitamin D, 25-Hydroxy"'s worthiness — matching how the retest signal groups. Keyed
// on biomarkerRetestIdentity (the BROAD vitamin-D scope, #1193) rather than the now-
// narrowed biomarkerFamily, so a D2/D3 fraction — its own IDENTITY series but a shared
// retest clock — stays worthy. Most analytes are their own family (keyed by canonical
// name), so this behaves like an exact-name set for everything except the
// interchangeable families.
const WORTHY_FAMILIES: Set<string> = new Set(
  RETEST_WORTHY.map((n) => biomarkerRetestIdentity(n))
);

// Whether a biomarker is on the curated recurring-monitoring tier (issues #546 /
// #587). An analyte NOT on the tier is an incidental one-off — unless it is
// risk-elevated, the Upcoming retest signal drops it from the nudge entirely rather
// than nagging it with a lipid panel's standing (a flagged one-off still surfaces on
// the Biomarkers flag/trajectory path). Family-aware (see WORTHY_FAMILIES) and case-
// insensitive on the canonical name.
export function isRetestWorthy(name: string | null | undefined): boolean {
  if (!name) return false;
  return WORTHY_FAMILIES.has(biomarkerRetestIdentity(name));
}
