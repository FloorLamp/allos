// Educational medication descriptions lookup — the DOMAIN accessor over the
// curated-dataset framework's medication-descriptions dataset (issue #860 Track B,
// wave 2). The data + matcher now live in lib/datasets/medication-descriptions.ts (a
// neutral "what it is / drug class / commonly used for" entry per medication, generated
// by scripts/gen-medication-descriptions.ts and validated by loadDataset); this module
// keeps the accessor surface every consumer already imports. No DB or network.
//
// Names are normalized the SAME way stored medication names are grouped elsewhere —
// cleanMedicationName (strips a trailing strength/form) plus lowercasing (normalizeMedName,
// re-exported from the dataset module) — so a stored intake_items/medication_courses name
// resolves to the right entry. Brand names + an explicit alias map fold into each entry's
// match_keys, so the framework's multi-value matcher finds one entry under any of its
// names. INFORMATIONAL, NOT MEDICAL ADVICE.

import {
  MED_DESCRIPTION_ENTRIES,
  medEntryForName,
  normalizeMedName,
  type MedDescriptionEntry,
  type MedicationTypical,
} from "./datasets/medication-descriptions";

// Re-export the normalization + typical-block type from their framework home so the
// existing consumer import paths (`@/lib/medication-info`) are unchanged.
export { normalizeMedName };
export type { MedicationTypical } from "./datasets/medication-descriptions";

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

// Project a framework entry down to the historical MedicationInfo shape (the public
// contract): generic / brand_names / drug_class / description / typical, WITHOUT the
// entry's internal key / synonyms / match_keys. Omits absent optionals so the returned
// object matches the pre-migration shape.
function toInfo(entry: MedDescriptionEntry): MedicationInfo {
  const info: MedicationInfo = {
    generic: entry.generic,
    description: entry.description,
  };
  if (entry.brand_names) info.brand_names = entry.brand_names;
  if (entry.drug_class) info.drug_class = entry.drug_class;
  if (entry.typical) info.typical = entry.typical;
  return info;
}

// The educational description for a medication name, or null when the drug is not in
// the curated set. Resolves by generic / brand / alias via the framework's multi-value
// matcher (behavior-identical to the former direct-key + alias-index lookup — the
// dataset's match keys are collision-free). Case-insensitive; unmatched names → null.
export function getMedicationInfo(
  name: string | null | undefined
): MedicationInfo | null {
  const entry = medEntryForName(name);
  return entry ? toInfo(entry) : null;
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
  for (const info of MED_DESCRIPTION_ENTRIES) {
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
  for (const info of MED_DESCRIPTION_ENTRIES) {
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
  for (const info of MED_DESCRIPTION_ENTRIES) {
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
  const entry = medEntryForName(raw);
  if (!entry) return { name: raw, brand: null };
  // A direct generic hit (the picked token IS this entry's generic key) → no brand.
  if (key === entry.key) return { name: entry.generic, brand: null };
  // Otherwise a brand/alias hit → the generic display name, keeping the brand ONLY
  // when the picked token is truly one of that entry's brand names (an alias/salt-form
  // synonym is not a brand — it becomes the generic name with no brand).
  const isBrand = (entry.brand_names ?? []).some(
    (b) => normalizeMedName(b) === key
  );
  return { name: entry.generic, brand: isBrand ? raw : null };
}
