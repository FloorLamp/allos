// Educational medication descriptions lookup. Reads the committed
// lib/medication-descriptions.json — a neutral "what it is / drug class / what
// it's commonly used for" entry for a broad set of common medications — and
// exposes a pure accessor. No DB or network: it's a map over a bundled asset,
// so the /medicine cards can surface an explainer without any schema change.
//
// Keys are the NORMALIZED generic name (lowercase). Input is normalized the SAME
// way stored medication names are grouped elsewhere — lib/prescription-parse's
// cleanMedicationName (strips a trailing strength/form) plus lowercasing — so a
// stored intake_items/medication_courses name resolves to the right entry.
// Brand names double as aliases (auto-indexed), and an explicit alias map covers
// alternate spellings, abbreviations, and common salt forms.
// INFORMATIONAL, NOT MEDICAL ADVICE.

import { cleanMedicationName } from "./prescription-parse";
import medsJson from "./medication-descriptions.json";

export interface MedicationInfo {
  // Canonical generic display name (e.g. "Ibuprofen").
  generic: string;
  // Well-known brand names for this generic (also serve as lookup aliases).
  brand_names?: string[];
  // Drug class / category (e.g. "NSAID", "SSRI (antidepressant)").
  drug_class?: string;
  // Neutral 1-3 sentence explanation: what it is and what it's commonly used for.
  description: string;
}

const MEDICATIONS: Record<string, MedicationInfo> =
  (medsJson as { medications?: Record<string, MedicationInfo> }).medications ??
  {};

const ALIASES: Record<string, string> =
  (medsJson as { aliases?: Record<string, string> }).aliases ?? {};

// Normalize a raw medication name to the lookup key form: strip a trailing
// strength/form via cleanMedicationName (the same grouping used for stored meds),
// then lowercase and collapse whitespace.
export function normalizeMedName(raw: string | null | undefined): string {
  if (!raw) return "";
  return cleanMedicationName(raw).toLowerCase().replace(/\s+/g, " ").trim();
}

// Alias index built from each entry's brand_names (normalized → generic key),
// merged with the explicit alias map. Entry keys always win over brand aliases.
const ALIAS_INDEX: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [genericKey, info] of Object.entries(MEDICATIONS)) {
    for (const brand of info.brand_names ?? []) {
      const b = normalizeMedName(brand);
      if (b && !map.has(b)) map.set(b, genericKey);
    }
  }
  // Explicit aliases (alternate spellings / salt forms) take precedence.
  for (const [alias, target] of Object.entries(ALIASES)) {
    const a = normalizeMedName(alias);
    if (a) map.set(a, target);
  }
  return map;
})();

// The educational description for a medication name, or null when the drug is not
// in the curated set. Resolves by: normalized generic key, then the alias index
// (brand names + explicit aliases). Case-insensitive; unmatched names return null.
export function getMedicationInfo(
  name: string | null | undefined
): MedicationInfo | null {
  const key = normalizeMedName(name);
  if (!key) return null;
  const direct = MEDICATIONS[key];
  if (direct) return direct;
  const aliasTarget = ALIAS_INDEX.get(key);
  if (aliasTarget && MEDICATIONS[aliasTarget]) return MEDICATIONS[aliasTarget];
  return null;
}
