// The query boundary for the ranked medication / supplement picker options (#1677).
// It resolves the profile's own ledger ONCE and hands bucketed facts to the pure
// rankers (lib/medication-rank.ts, lib/supplement-rank.ts) — no surface re-derives
// ordering, and the full form and the quick-add can never disagree about what the
// picker's first eight rows are (#221).

import { db } from "../db";
import {
  rankedMedicationBrandOptions,
  rankedMedicationOptions,
  type MedicationUsage,
} from "../medication-rank";
import {
  rankedSupplementOptions,
  type SupplementUsage,
} from "../supplement-rank";

// The profile's medication ledger as the ranker's stable facts: one row per recorded
// medication, `current` when it is still on the regimen. Both the live regimen row
// (`intake_items.active`) and the course ledger contribute — a medication whose item
// was deactivated but whose course never stopped still reads as current, the same
// current/past split the Medications page's own lists use.
function medicationUsage(profileId: number): MedicationUsage[] {
  return db
    .prepare(
      `SELECT i.name AS name,
              MAX(CASE WHEN i.active = 1
                         OR (c.id IS NOT NULL AND c.stopped_on IS NULL)
                       THEN 1 ELSE 0 END) AS current
         FROM intake_items i
         LEFT JOIN medication_courses c ON c.item_id = i.id
        WHERE i.profile_id = ? AND i.kind = 'medication'
        GROUP BY i.name`
    )
    .all(profileId)
    .map((r) => {
      const row = r as { name: string; current: number };
      return { name: row.name, current: row.current === 1 };
    });
}

// The medication NAME picker order for this profile (#1677) — one source, consumed by
// the one intake form (#3216), whichever host mounts it.
export function getRankedMedicationOptions(profileId: number): string[] {
  return rankedMedicationOptions(medicationUsage(profileId));
}

// The medication BRAND picker order for the PRE-PICK state (#1677): the brands this
// profile has actually recorded lead, active rows ahead of retired ones. Once a
// medication is picked the form narrows to that drug's own brands, which is unchanged.
export function getRankedMedicationBrandOptions(profileId: number): string[] {
  const used = db
    .prepare(
      `SELECT brand FROM intake_items
        WHERE profile_id = ? AND kind = 'medication'
          AND brand IS NOT NULL AND TRIM(brand) <> ''
        ORDER BY active DESC, id DESC`
    )
    .all(profileId)
    .map((r) => (r as { brand: string }).brand);
  return rankedMedicationBrandOptions(used);
}

// The profile's own STACK names (#3100). Everything that groups by stack groups by
// EXACT STRING — `doseSortKey` encodes the raw label, the supplement row renders it
// verbatim — so the only way into an existing stack used to be retyping its name
// exactly, and "AM stack" typed as "AM Stack" silently minted a second cluster.
// Offering the names that already exist makes exact reuse the easy path.
//
// Distinctness is EXACT (after trimming), deliberately: if a profile already carries
// both "AM stack" and "AM Stack", both are real clusters today and both must stay
// reachable from the picker. Folding them here would hide one of the two behind a
// name that does not select it. Merging near-duplicates is a separate question
// (#3100 puts it out of scope) and it is not this list's to decide.
//
// Not scoped to `kind = 'supplement'`: the stack FIELD is supplement-only, but
// `lib/dose-order.ts` clusters whatever carries a stack, so a row that already has
// one is a cluster the picker must be able to name.
export function getRankedStackOptions(profileId: number): string[] {
  const used = db
    .prepare(
      `SELECT stack FROM intake_items
        WHERE profile_id = ?
          AND stack IS NOT NULL AND TRIM(stack) <> ''
        ORDER BY active DESC, id DESC`
    )
    .all(profileId)
    .map((r) => (r as { stack: string }).stack);
  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of used) {
    const stack = raw.trim();
    if (!stack || seen.has(stack)) continue;
    seen.add(stack);
    options.push(stack);
  }
  return options;
}

// The profile's supplement shelf as the ranker's stable facts — retired items included
// (a supplement cycled off is far more likely to be re-added than one never taken).
function supplementUsage(profileId: number): SupplementUsage[] {
  return db
    .prepare(
      `SELECT name, MAX(active) AS current
         FROM intake_items
        WHERE profile_id = ? AND kind = 'supplement'
        GROUP BY name`
    )
    .all(profileId)
    .map((r) => {
      const row = r as { name: string; current: number };
      return { name: row.name, current: row.current === 1 };
    });
}

// The supplement NAME picker order for this profile (#1677).
export function getRankedSupplementOptions(profileId: number): string[] {
  return rankedSupplementOptions(supplementUsage(profileId));
}

// Everything an intake surface needs to render its pickers, resolved once at the page's
// auth boundary and handed to the client as plain arrays.
export interface IntakeCatalogOptions {
  medications: string[];
  medicationBrands: string[];
  supplements: string[];
  // The profile's own stack names (#3100). No curated tier — a stack is whatever
  // this profile called one — so a profile with no stacks yields [].
  stacks: string[];
}

export function getIntakeCatalogOptions(
  profileId: number
): IntakeCatalogOptions {
  return {
    medications: getRankedMedicationOptions(profileId),
    medicationBrands: getRankedMedicationBrandOptions(profileId),
    supplements: getRankedSupplementOptions(profileId),
    stacks: getRankedStackOptions(profileId),
  };
}
