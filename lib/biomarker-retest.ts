// Per-biomarker retest cadence lookup. Reads the curated
// `retest_days` off the committed canonical dataset — the same static JSON the
// flags-signature module imports — and exposes it keyed by canonical name. No DB
// or network: it's a pure map over a bundled asset, so the Upcoming retest signal
// can pick a per-analyte cadence (HbA1c quarterly, TSH every 6 months, lipids
// annual) without a schema change to the canonical_biomarkers table. AI-discovered
// analytes and uncurated rows carry no retest_days and fall back to the flat
// DEFAULT_RETEST_DAYS in lib/reference-range.retestIntervalDays.
//
// Both exports key on the analyte's RETEST identity (biomarkerRetestIdentity), the
// same grouping the Upcoming retest generator partitions readings by — the cadence
// and the clock are one question and must not be computed two ways (#1394/#1395).

import { CANONICAL_BIOMARKERS } from "./datasets/canonical-biomarkers";
import { RETEST_WORTHY } from "./curated-biomarkers";
import { biomarkerRetestIdentity } from "./canonical-name";

// RETEST-clock identity → curated retest_days. Built once at module load over the
// framework read layer (the same committed rows the boot task seeds).
//
// Keyed on biomarkerRetestIdentity, NOT the raw canonical name (#1394/#1395). The
// retest CLOCK groups readings by that identity — the #482 family, widened for
// vitamin D — so the retest INTERVAL has to be looked up on the same key, or the
// one question ("when is this analyte due again?") gets two computations that
// disagree the moment the family's newest reading is a member the curated dataset
// doesn't name. That is exactly what happened for A1c: labs report HbA1c and its
// eAG re-expression on one draw, eAG lands with the higher id and becomes the
// family's representative, and the dataset has no "Estimated Average Glucose"
// row — so a diabetic's quarterly A1c silently fell to the flat 365-day default.
// The vitamin-D D2/D3 fractions were patched name-by-name against the same
// mechanism (curated-biomarkers.RETEST_DAYS); keying on the identity fixes the
// class instead of the instance, so a family member added later inherits the
// cadence without a second edit.
//
// A non-family analyte's retest identity IS its own trimmed name, so for every
// analyte outside a family this is byte-for-byte the old exact-name lookup.
// When several curated members share one identity the TIGHTEST (smallest) cadence
// wins: a family is one clock, and shortening it can only make the nudge earlier,
// never let a due redraw go unmentioned.
const RETEST_BY_IDENTITY: Map<string, number> = (() => {
  const map = new Map<string, number>();
  const rows = CANONICAL_BIOMARKERS;
  for (const r of rows) {
    if (!r?.name || typeof r.retest_days !== "number" || r.retest_days <= 0)
      continue;
    const key = biomarkerRetestIdentity(r.name).toLowerCase();
    const prev = map.get(key);
    if (prev === undefined || r.retest_days < prev) map.set(key, r.retest_days);
  }
  return map;
})();

// The curated retest cadence (days) for a biomarker name, or null when the analyte
// has no curated interval (the caller then falls back to the default). Resolved
// through the analyte's RETEST identity, so every member of a retest family
// inherits the family's curated cadence — the same identity the retest generator
// groups readings by. Case-insensitive, matching the canonical_biomarkers PK.
export function retestDaysForBiomarker(
  name: string | null | undefined
): number | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return (
    RETEST_BY_IDENTITY.get(biomarkerRetestIdentity(trimmed).toLowerCase()) ??
    null
  );
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
