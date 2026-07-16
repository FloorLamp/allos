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
import type { FoodTiming } from "./types";
import type { TimeBucket } from "./supplement-schedule";

// Curated, CITED "typical use" conventions for a medication (issue #846) — the
// label-standard defaults the selection-prefill resolver suggests when this med is
// picked on the form (asNeeded/foodTiming/timeOfDay). ONLY encode label-standard,
// citable conventions here (NSAIDs → with food; statins → evening; levothyroxine →
// empty stomach, morning); absent fields mean NO suggestion, never a guess. Every
// entry carries a `source` (the cited-dataset discipline, mirroring prn-defaults).
// INFORMATIONAL — a suggestion the user confirms/edits, never applied silently.
export interface MedicationTypical {
  // Commonly taken "as needed" (PRN) rather than on a fixed schedule.
  asNeeded?: boolean;
  // The label's standard food relationship (e.g. NSAIDs with food).
  foodTiming?: FoodTiming;
  // The label's standard time of day (e.g. statins in the evening).
  timeOfDay?: TimeBucket;
  // Citation for the convention (a public label / prescribing-information figure).
  source: string;
}

export interface MedicationInfo {
  // Canonical generic display name (e.g. "Ibuprofen").
  generic: string;
  // Well-known brand names for this generic (also serve as lookup aliases).
  brand_names?: string[];
  // Drug class / category (e.g. "NSAID", "SSRI (antidepressant)").
  drug_class?: string;
  // Neutral 1-3 sentence explanation: what it is and what it's commonly used for.
  description: string;
  // Label-standard "typical use" conventions for selection prefill (#846). Absent
  // for entries with no strong, citable convention.
  typical?: MedicationTypical;
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

// ---- Medication name combobox source (issue #817) ----

// The sorted, de-duplicated list of catalog medication names for the med form's name
// combobox: every curated entry's generic DISPLAY name plus each of its brand names
// (208 generics + their brands). So adding a medication suggests "Ibuprofen"/"Advil"
// rather than the supplement catalog; the RxNorm lookup stays the long tail for any
// drug not in this set. Pure over the bundled asset — the derived list is pinned by
// lib/__tests__/medication-descriptions.test.ts.
export function medicationCatalogNames(): string[] {
  const names = new Set<string>();
  for (const info of Object.values(MEDICATIONS)) {
    if (info.generic) names.add(info.generic);
    for (const brand of info.brand_names ?? []) {
      if (brand) names.add(brand);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ---- Collapsed catalog options: one entry per med (issue #851 item 14) ----

// How many brand names to show in a collapsed catalog label before eliding with "…".
const CATALOG_BRAND_CAP = 2;

// The collapsed combobox label for one med: "Acetaminophen (Tylenol, Panadol)". Caps
// at ~2 brands + "…" for a long brand list; a med with no brands is just the generic.
// The FULL label is what the combobox filters over (a fuzzy subsequence match), so
// typing "tyle" surfaces the Acetaminophen entry via its brand in the label.
export function medicationCatalogLabel(
  generic: string,
  brands: string[]
): string {
  const shown = brands.slice(0, CATALOG_BRAND_CAP);
  if (shown.length === 0) return generic;
  const suffix =
    brands.length > CATALOG_BRAND_CAP
      ? `${shown.join(", ")}, …`
      : shown.join(", ");
  return `${generic} (${suffix})`;
}

// The med-name combobox source as ONE option per medication (issue #851 item 14),
// replacing the former flat generics+brands list where each med appeared several
// times. Each option is the collapsed "Generic (Brand, Brand)" label; the brands ride
// IN the label so the combobox's fuzzy filter still matches a typed brand token.
// Sorted by label. Pure over the bundled asset; pinned by the descriptions test.
export function medicationCatalogOptions(): string[] {
  const opts: string[] = [];
  for (const info of Object.values(MEDICATIONS)) {
    if (!info.generic) continue;
    opts.push(medicationCatalogLabel(info.generic, info.brand_names ?? []));
  }
  return opts.sort((a, b) => a.localeCompare(b));
}

// Strip the "(Brand, …)" parenthetical from a collapsed catalog label → the generic.
// A label with no parenthetical (a brandless med, or a free-text name) passes through.
export function catalogLabelGeneric(label: string): string {
  const m = label.match(/^(.*?)\s*\([^()]*\)\s*$/);
  return (m ? m[1] : label).trim();
}

// Resolve a combobox pick from the collapsed catalog (issue #851 item 14). `picked` is
// the option label the user chose; `query` is the text they typed before picking (it
// may be a brand token). Returns the generic as `name`; prefills `brand` ONLY when the
// typed query matched a brand of that med ("tylenol" → { name: "Acetaminophen", brand:
// "Tylenol" }). A generic-matched pick (or no query) leaves brand null so the
// Generic/brand_names picker (#851 item 3) owns it. A free-text pick outside the
// catalog falls back to splitMedicationName. Pure; pinned by the descriptions test.
export function resolveMedicationPick(
  picked: string,
  query?: string
): { name: string; brand: string | null } {
  const generic = catalogLabelGeneric(picked);
  const info = getMedicationInfo(generic);
  if (!info) return splitMedicationName(picked);
  const qn = normalizeMedName(query ?? "");
  let brand: string | null = null;
  // Only treat the query as a brand match when it does NOT already match the generic
  // (a generic-matched pick leaves brand for the #851-item-3 picker).
  if (qn && !normalizeMedName(info.generic).includes(qn)) {
    const match = (info.brand_names ?? []).find((b) => {
      const bn = normalizeMedName(b);
      return bn.includes(qn) || qn.includes(bn);
    });
    if (match) brand = match;
  }
  return { name: info.generic, brand };
}

// The sorted, de-duplicated list of catalog BRAND names — the medication form's brand
// combobox source (#846), so a med's brand field suggests "Advil"/"Motrin" rather than
// the supplement brands ("Thorne"). After a specific med is picked, the form narrows
// this to that entry's own brand_names (via the prefill resolver). Pure over the
// bundled asset.
export function medicationBrandNames(): string[] {
  const brands = new Set<string>();
  for (const info of Object.values(MEDICATIONS)) {
    for (const brand of info.brand_names ?? []) {
      if (brand) brands.add(brand);
    }
  }
  return [...brands].sort((a, b) => a.localeCompare(b));
}

// The store-brand option offered FIRST in the brand combobox (issue #851 item 3):
// generic (store-brand) ibuprofen is the most common OTC purchase, so "Generic" leads
// the list, stored literally in the `brand` column. A distinct sentinel, not a real
// manufacturer.
export const GENERIC_BRAND_OPTION = "Generic";

// The brand combobox options with "Generic" prepended (issue #851 item 3). `specific`
// is a picked med's own brand_names (narrowed by the prefill resolver); when empty the
// full catalog brand list is used. "Generic" always leads and is never duplicated.
export function medicationBrandOptions(specific?: string[]): string[] {
  const base = specific && specific.length ? specific : medicationBrandNames();
  return [
    GENERIC_BRAND_OPTION,
    ...base.filter((b) => b !== GENERIC_BRAND_OPTION),
  ];
}

// Split a picked catalog name into { name (generic), brand } for the med form (#817).
// Picking a BRAND ("Tylenol") resolves to its generic ("Acetaminophen") with the
// brand preserved for the `brand` column (the split the alias index already knows);
// picking a generic keeps it as the name with no brand. An explicit alias that is a
// generic SYNONYM ("Paracetamol"), not a brand, resolves to the generic with no
// brand. An unmatched free-text pick passes through unchanged. Pure; pinned by the
// descriptions test.
export function splitMedicationName(picked: string | null | undefined): {
  name: string;
  brand: string | null;
} {
  const raw = (picked ?? "").trim();
  if (!raw) return { name: "", brand: null };
  const key = normalizeMedName(raw);
  // A generic key hit → it's already the generic; no brand.
  const direct = MEDICATIONS[key];
  if (direct) return { name: direct.generic, brand: null };
  // A brand/alias hit → the generic display name, keeping the brand ONLY when the
  // picked token is truly one of that entry's brand names (an alias/salt-form
  // synonym is not a brand — it becomes the generic name with no brand).
  const target = ALIAS_INDEX.get(key);
  const info = target ? MEDICATIONS[target] : undefined;
  if (info) {
    const isBrand = (info.brand_names ?? []).some(
      (b) => normalizeMedName(b) === key
    );
    return { name: info.generic, brand: isBrand ? raw : null };
  }
  return { name: raw, brand: null };
}
