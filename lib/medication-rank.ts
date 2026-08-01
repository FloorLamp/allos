// The medication name/brand picker ORDER (issue #1677). Pure — no DB, no network.
//
// `Combobox` shows 8 rows and an empty query keeps source order, so the first 8 entries
// of the options array ARE the picker. Alphabetical over 242 curated generics opens on
// Abacavir/Acarbose — a list nobody's medication is in. This module is the ONE ordering
// computation behind both medication name call sites (the full MedicationForm and the
// quick-add), fed by `lib/queries/intake-options.ts`.
//
// Three tiers, in the discipline `rank-core`/#1490 established (stable facts, bucketed
// presence, no raw-recency jitter):
//
//   1. what this profile actually takes — a CURRENT medication outranks a past one, and
//      a duplicate ledger row never inflates a rank (presence buckets, not counts)
//   2. a curated common-medications head, so a fresh profile opens on drugs people
//      actually take rather than on the alphabet's accidents
//   3. the rest of the catalog, A–Z
//
// ORDERING ONLY: membership never changes and everything stays reachable through the
// combobox's fuzzy search regardless of rank.

import {
  MED_DESCRIPTION_ENTRIES,
  medEntryForName,
} from "./datasets/medication-descriptions";
import {
  GENERIC_BRAND_OPTION,
  medicationBrandNames,
  medicationBrandOptions,
  medicationCatalogLabel,
} from "./medication-info";
import { rankByFrequency } from "./rank-by-frequency";

// One medication this profile has on its ledger. `current` is the STABLE FACT that
// buckets it: an active regimen row (or an open course) leads a stopped one. Nothing
// here is a raw timestamp — two people's pickers differ by what they take, not by which
// row was touched most recently.
export interface MedicationUsage {
  // The stored `intake_items.name` / course name, as typed or imported.
  name: string;
  current: boolean;
}

// Presence buckets, not occurrence counts. A medication on the regimen right now is
// worth more than one that was stopped; a second row for the same drug adds nothing
// (the weights are combined with MAX, not summed), so an import that split a course
// into three rows cannot outrank a genuinely different current medication.
export const CURRENT_MEDICATION_WEIGHT = 4;
export const PAST_MEDICATION_WEIGHT = 1;

// The curated common-medications head — the drugs a first-time picker should open on.
// A practical, hand-maintained ordering of the highest-volume US outpatient
// prescriptions plus the OTC aisle a household actually reaches for; NOT a clinical
// ranking and not advice. Every entry must resolve in the curated description set
// (pinned by lib/__tests__/medication-rank.test.ts), so a catalog rename can never
// leave a dangling head entry.
export const COMMON_MEDICATIONS: readonly string[] = [
  // The OTC shelf — the medications most likely to be logged first.
  "Acetaminophen",
  "Ibuprofen",
  "Aspirin",
  "Naproxen",
  "Cetirizine",
  "Loratadine",
  // Cardiometabolic maintenance — the highest-volume chronic prescriptions.
  "Atorvastatin",
  "Levothyroxine",
  "Lisinopril",
  "Metformin",
  "Amlodipine",
  "Metoprolol",
  "Losartan",
  "Rosuvastatin",
  "Hydrochlorothiazide",
  "Simvastatin",
  // Airway, gut, and pain.
  "Albuterol",
  "Montelukast",
  "Fluticasone",
  "Omeprazole",
  "Pantoprazole",
  "Gabapentin",
  "Meloxicam",
  "Prednisone",
  // Mental health.
  "Sertraline",
  "Escitalopram",
  "Fluoxetine",
  "Bupropion",
  "Duloxetine",
  "Trazodone",
  // Short courses.
  "Amoxicillin",
  "Azithromycin",
  "Doxycycline",
];

function labelFor(generic: string, brands: readonly string[]): string {
  return medicationCatalogLabel(generic, [...brands]);
}

// generic (lowercased) → the collapsed "Generic (Brand, Brand)" combobox label.
let labelByGeneric: Map<string, string> | null = null;
function genericLabels(): Map<string, string> {
  if (!labelByGeneric) {
    labelByGeneric = new Map(
      MED_DESCRIPTION_ENTRIES.filter((e) => e.generic).map((e) => [
        e.generic.toLowerCase(),
        labelFor(e.generic, e.brand_names ?? []),
      ])
    );
  }
  return labelByGeneric;
}

// The curated medication options with the common head in front and the remaining
// catalog A–Z behind it — the order a profile with NO medication history sees. Same
// membership as `medicationCatalogOptions()`, different order.
let curatedCache: string[] | null = null;
export function curatedMedicationOptions(): string[] {
  if (curatedCache) return curatedCache;
  const byGeneric = genericLabels();
  const head: string[] = [];
  const taken = new Set<string>();
  for (const generic of COMMON_MEDICATIONS) {
    const label = byGeneric.get(generic.toLowerCase());
    if (!label || taken.has(label)) continue;
    head.push(label);
    taken.add(label);
  }
  const tail = [...byGeneric.values()]
    .filter((label) => !taken.has(label))
    .sort((a, b) => a.localeCompare(b));
  curatedCache = [...head, ...tail];
  return curatedCache;
}

// The combobox label a stored medication name belongs to: the curated entry it resolves
// to under any of its names (generic, brand, salt-form alias), or the stored name itself
// when the drug is outside the curated set — so a profile's own free-text medication is
// still floated to the top of its own picker.
function optionForUsedName(name: string): string | null {
  const raw = name.trim();
  if (!raw) return null;
  const entry = medEntryForName(raw);
  if (!entry?.generic) return raw;
  return genericLabels().get(entry.generic.toLowerCase()) ?? raw;
}

// The medication name picker order for one profile (#1677). Usage beats the curated
// head beats A–Z; a current medication beats a past one; ties keep curated order, so a
// profile with no ledger gets `curatedMedicationOptions()` byte for byte.
export function rankedMedicationOptions(
  usage: readonly MedicationUsage[]
): string[] {
  const weights = new Map<string, { name: string; c: number }>();
  for (const row of usage) {
    const option = optionForUsedName(row.name);
    if (!option) continue;
    const weight = row.current
      ? CURRENT_MEDICATION_WEIGHT
      : PAST_MEDICATION_WEIGHT;
    const key = option.toLowerCase();
    const prev = weights.get(key);
    // MAX, not sum: presence in a bucket, so duplicate ledger rows don't inflate.
    if (!prev) weights.set(key, { name: option, c: weight });
    else if (weight > prev.c) prev.c = weight;
  }
  return rankByFrequency(curatedMedicationOptions(), [...weights.values()]);
}

// The BRAND picker order (#1677). Two states, and only the first one is new:
//
//   post-pick — once a medication is chosen the form narrows the field to that drug's
//   own brands (`specific`), which already leads correctly; this passes it through
//   unchanged so the #851-item-3 "Generic" sentinel keeps its place.
//
//   pre-pick — 311 catalog brands alphabetically is the broken state the issue names.
//   The profile's OWN brands lead instead (they are the brands it will type again),
//   then the catalog A–Z. The form already renders Name ABOVE Brand, so the natural
//   flow reaches the narrowed post-pick list; this fixes the person who jumps to Brand
//   first without reordering fields.
//
// `used` is the profile's recorded brands, most-relevant first (the query orders active
// rows ahead of retired ones); casing follows the catalog when it knows the brand.
export function rankedMedicationBrandOptions(
  used: readonly string[],
  specific?: readonly string[]
): string[] {
  if (specific && specific.length) return medicationBrandOptions([...specific]);
  const catalog = medicationBrandNames();
  const canonical = new Map(catalog.map((b) => [b.toLowerCase(), b]));
  const lead: string[] = [];
  const taken = new Set<string>([GENERIC_BRAND_OPTION.toLowerCase()]);
  for (const raw of used) {
    const brand = raw.trim();
    if (!brand) continue;
    const key = brand.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    lead.push(canonical.get(key) ?? brand);
  }
  return [
    GENERIC_BRAND_OPTION,
    ...lead,
    ...catalog.filter(
      (b) =>
        b !== GENERIC_BRAND_OPTION && !taken.has(b.toLowerCase())
    ),
  ];
}
