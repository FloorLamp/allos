// Allergen cross-reactivity matcher (issue #153).
//
// Cross-reactivity between allergens is well documented and clinically static:
// birch pollen cross-reacts with apple / stone fruit / hazelnut (oral allergy
// syndrome); natural rubber latex with banana / avocado / kiwi (latex-fruit
// syndrome); crustacean shellfish share tropomyosin; cashew↔pistachio and
// walnut↔pecan cluster; cow / goat / sheep milk share caseins. This module reads
// the curated framework dataset lib/datasets/data/allergen-cross-reactivity.json
// (via lib/datasets/allergen-cross-reactivity) and, given a profile's
// allergens/sensitizations (canonical names — the same strings the allergies view
// carries, produced by lib/allergy-ige.ts), surfaces INFORMATIONAL cross-reaction
// notes.
//
// It is pure (no DB/network) and INFORMATIONAL only — the wording is "commonly
// cross-reacts with" / "commonly associated with", never a diagnosis. A single
// pure matcher backs every surface (the Allergies page and the passport allergy
// view), per the one-question-one-computation rule.
//
// The families live in the curated-dataset FRAMEWORK envelope (issue #860 Track B):
// lib/datasets/data/allergen-cross-reactivity.json, generated from the hand-maintained
// scripts/allergen-cross-reactivity.source.json and consumed via
// lib/datasets/allergen-cross-reactivity.ts. This module is the DOMAIN matcher over its
// entries (resolving a profile's allergens to families by member/alias form-overlap).

import {
  CROSS_REACTIVITY_FAMILIES,
  type CrossReactivityFamily,
} from "./datasets/allergen-cross-reactivity";

export type { CrossReactivityFamily } from "./datasets/allergen-cross-reactivity";

export interface CrossReactivityMatch {
  familyId: string;
  familyName: string;
  label: string;
  citation: string;
  // The profile allergen(s) that placed the profile in this family (display form).
  triggers: string[];
  // Other members of the family the trigger(s) commonly cross-react with.
  related: string[];
  // A self-contained informational sentence formatted over the fields above.
  note: string;
}

const FAMILIES: CrossReactivityFamily[] = CROSS_REACTIVITY_FAMILIES;

export function crossReactivityFamilies(): readonly CrossReactivityFamily[] {
  return FAMILIES;
}

// Normalize an allergen/member string to a comparable key: lowercase, drop
// apostrophes, collapse any non-alphanumeric run to a single space, trim.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The set of comparable forms for a string: its normalized form plus a naive
// depluralized form (trailing "s" dropped) so "peanuts" matches "peanut" and
// "crabs" matches "crab". Short words (<= 3 chars) are not depluralized.
function forms(s: string): Set<string> {
  const n = normalize(s);
  const out = new Set<string>();
  if (!n) return out;
  out.add(n);
  if (n.length > 3 && n.endsWith("s")) out.add(n.slice(0, -1));
  return out;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// All comparable forms recognized for a family member (its own name plus any
// configured aliases).
function memberForms(
  family: CrossReactivityFamily,
  member: string
): Set<string> {
  const out = forms(member);
  const aliases = family.aliases?.[member];
  if (aliases) for (const a of aliases) for (const f of forms(a)) out.add(f);
  return out;
}

function joinHuman(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// Given a profile's allergens/sensitizations (canonical display names), return the
// cross-reactivity families the profile falls into. For each family, `triggers`
// are the profile's own matching allergens and `related` are the family's OTHER
// members they commonly cross-react with. An allergen that belongs to more than
// one family (e.g. kiwi ∈ birch-OAS and latex-fruit) yields one match per family.
// Families where nothing beyond the trigger itself remains to note are omitted.
export function findCrossReactivity(
  allergens: readonly string[]
): CrossReactivityMatch[] {
  const inputForms = allergens
    .filter((a) => a && a.trim())
    .map((a) => ({ display: a.trim(), forms: forms(a) }));
  if (inputForms.length === 0) return [];

  const matches: CrossReactivityMatch[] = [];

  for (const family of FAMILIES) {
    // Which family members does the profile have? Track the matched member so the
    // "related" list can exclude it, and the profile's own display string for the
    // trigger label.
    const matchedMembers = new Set<string>();
    const triggerDisplays: string[] = [];
    const seenTriggers = new Set<string>();

    for (const member of family.members) {
      const mForms = memberForms(family, member);
      for (const inp of inputForms) {
        if (overlaps(inp.forms, mForms)) {
          matchedMembers.add(member);
          const key = inp.display.toLowerCase();
          if (!seenTriggers.has(key)) {
            seenTriggers.add(key);
            triggerDisplays.push(inp.display);
          }
        }
      }
    }

    if (matchedMembers.size === 0) continue;

    const related = family.members.filter((m) => !matchedMembers.has(m));
    if (related.length === 0) continue; // nothing new to inform about

    const triggerLabel = joinHuman(triggerDisplays);
    const note =
      `${triggerLabel} commonly cross-reacts with ${joinHuman(related)} ` +
      `(${family.label}). Informational only — cross-reactivity does not mean a ` +
      `reaction is certain.`;

    matches.push({
      familyId: family.id,
      familyName: family.name,
      label: family.label,
      citation: family.citation,
      triggers: triggerDisplays,
      related,
      note,
    });
  }

  return matches;
}
