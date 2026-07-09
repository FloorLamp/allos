// Educational biomarker descriptions lookup. Reads the committed
// lib/biomarker-descriptions.json — a plain-language "what is this / why it
// matters" entry for every canonical biomarker — and exposes a pure accessor
// keyed by canonical name. No DB or network: it's a map over a bundled asset,
// so pages can surface an explainer next to a biomarker's chart without any
// schema change. INFORMATIONAL, NOT MEDICAL ADVICE.

import descriptionsJson from "./biomarker-descriptions.json";

export interface BiomarkerInfo {
  // Short abbreviation (e.g. "RDW"), when the marker has a well-known one.
  abbreviation?: string;
  // Human-readable expansion of the name (e.g. "Red Cell Distribution Width").
  full_name: string;
  // 1-3 plain-language sentences: what it measures and why it generally matters.
  description: string;
}

const DESCRIPTIONS: Record<string, BiomarkerInfo> =
  (descriptionsJson as { descriptions?: Record<string, BiomarkerInfo> })
    .descriptions ?? {};

// Case-insensitive index: lowercased canonical name → info. Built once at load.
const BY_LOWER: Map<string, BiomarkerInfo> = (() => {
  const map = new Map<string, BiomarkerInfo>();
  for (const [name, info] of Object.entries(DESCRIPTIONS)) {
    map.set(name.toLowerCase(), info);
  }
  return map;
})();

// The educational description for a canonical biomarker name, or null when none
// is curated. Tries an exact key match first, then a case-insensitive fallback,
// matching how the canonical_biomarkers name is treated elsewhere.
export function getBiomarkerInfo(
  canonicalName: string | null | undefined
): BiomarkerInfo | null {
  if (!canonicalName) return null;
  const exact = DESCRIPTIONS[canonicalName];
  if (exact) return exact;
  const trimmed = canonicalName.trim();
  if (DESCRIPTIONS[trimmed]) return DESCRIPTIONS[trimmed];
  return BY_LOWER.get(trimmed.toLowerCase()) ?? null;
}
