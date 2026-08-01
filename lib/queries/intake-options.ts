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
// both the full MedicationForm and the quick-add.
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
}

export function getIntakeCatalogOptions(
  profileId: number
): IntakeCatalogOptions {
  return {
    medications: getRankedMedicationOptions(profileId),
    medicationBrands: getRankedMedicationBrandOptions(profileId),
    supplements: getRankedSupplementOptions(profileId),
  };
}
