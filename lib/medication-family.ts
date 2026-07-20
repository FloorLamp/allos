// Pure medication INGREDIENT-FAMILY derivation (issue #1027) — the #482
// identity-family convention instantiated for intake items. A profile can track the
// same active ingredient as two items (the classic case: OTC ibuprofen 200 mg PRN
// alongside prescription ibuprofen 800 mg), and every name/id-keyed SAFETY signal
// must reach for this ONE identity function instead of treating the items as
// strangers: the PRN redose interval clock, the daily count, the over-max
// comparison, and the therapeutic-duplication note all key on the FAMILY.
//
// FAMILY RULE (exclusion-disciplined — never a guess):
//   • Two items share a family when their INGREDIENT-CUI identity matches — the
//     cached #279 `rxcuiIngredients` set when present, else the product/confirmed
//     `rxcui` as a one-element set — OR when their cleaned GENERIC NAME KEY matches
//     (cleanMedicationName strips strength/form, splitMedicationName collapses a
//     brand to its generic: "Advil" ≡ "Ibuprofen 800 mg" ≡ "ibuprofen"). The name
//     bridge is what lets a resolved item and a never-resolved (name-only) item
//     still family-match.
//   • A COMBINATION product's ingredient SET is its identity — a combo and a
//     single-ingredient item are NOT one family (a partial overlap is not "same
//     ingredient"; the pairwise interaction checker already sees ingredient
//     overlap).
//   • No resolution at all (no CUI, name cleans to nothing) ⇒ the item is its OWN
//     family — never guess.
//
// The FAMILY KEY is stable and derived (never stored): the lexicographically first
// ingredient-CUI key among members when any member carries one, else the first name
// key, else `item:<id>`. The duplication note's dedupeKey (`med-dup:<familyKey>`)
// is therefore name-keyed in the fallback case — per #203, a member rename/resolve
// re-keys the family and an old dismissal goes inert (it resurfaces once), which is
// the safe direction for a safety-adjacent note.
//
// No DB, no network — the gather that feeds this lives in
// lib/queries/intake/prn-family.ts. Unit-tested in
// lib/__tests__/medication-family.test.ts.

import { medNameKey } from "./medication-record-match";

// The findings-bus namespace for the coaching-tier therapeutic-duplication note
// (#1027 ask 3). Registered in RULE_FINDING_REGISTRY (coaching) + the intake
// dismiss guard via the registry-backed page guards.
export const MED_DUP_PREFIX = "med-dup:";

export function medDupSignalKey(familyKey: string): string {
  return `${MED_DUP_PREFIX}${familyKey}`;
}

// The minimal item shape family derivation needs.
export interface MedFamilyItem {
  id: number;
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}

// One derived family: its stable key and the member items (in input order).
export interface MedicationFamily<T extends MedFamilyItem = MedFamilyItem> {
  familyKey: string;
  members: T[];
}

// The ingredient-CUI identity key for one item, or null when it carries no code.
// The cached ingredient set is authoritative (a product CUI resolves through its
// ingredients); a bare confirmed rxcui stands in as a one-element set, so an item
// confirmed AT the ingredient level ("ibuprofen", CUI 5640) matches a product whose
// cached ingredients contain 5640.
export function ingredientCuiKey(item: {
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}): string | null {
  const ingredients = (item.rxcuiIngredients ?? [])
    .map((c) => c.trim())
    .filter(Boolean);
  const set = ingredients.length
    ? [...new Set(ingredients)].sort()
    : item.rxcui?.trim()
      ? [item.rxcui.trim()]
      : null;
  return set ? `cui:${set.join("+")}` : null;
}

// The cleaned generic-name identity key for one item, or null when the name cleans
// to nothing.
export function medicationNameKey(name: string): string | null {
  const key = medNameKey(name);
  return key ? `name:${key}` : null;
}

// Partition a list of items into ingredient families: union by equal CUI key OR
// equal name key (a two-attribute union-find, so a resolved item bridges to a
// name-only sibling through the shared generic name). Items with neither key are
// singletons. Deterministic: family order follows first-member input order.
export function medicationFamilies<T extends MedFamilyItem>(
  items: readonly T[]
): MedicationFamily<T>[] {
  // Union-find over item indices.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const byKey = new Map<string, number>();
  items.forEach((item, i) => {
    for (const key of [ingredientCuiKey(item), medicationNameKey(item.name)]) {
      if (!key) continue;
      const first = byKey.get(key);
      if (first == null) byKey.set(key, i);
      else union(first, i);
    }
  });

  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(item);
    groups.set(root, arr);
  });

  return [...groups.values()].map((members) => ({
    familyKey: familyKeyFor(members),
    members,
  }));
}

// The stable derived key for one family (see the module header).
function familyKeyFor(members: readonly MedFamilyItem[]): string {
  const cuiKeys = members
    .map(ingredientCuiKey)
    .filter((k): k is string => !!k)
    .sort();
  if (cuiKeys.length) return cuiKeys[0];
  const nameKeys = members
    .map((m) => medicationNameKey(m.name))
    .filter((k): k is string => !!k)
    .sort();
  if (nameKeys.length) return nameKeys[0];
  return `item:${Math.min(...members.map((m) => m.id))}`;
}

// A human label for the family — the shared generic name when the members agree
// ("Ibuprofen"), else the first member's name. Capitalized for display.
export function familyDisplayLabel(members: readonly MedFamilyItem[]): string {
  const keys = new Set(members.map((m) => medNameKey(m.name)).filter(Boolean));
  if (keys.size === 1) {
    const generic = [...keys][0];
    return generic.charAt(0).toUpperCase() + generic.slice(1);
  }
  return members[0]?.name ?? "";
}
