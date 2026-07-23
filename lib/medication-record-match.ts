// Medication name-key helper + the retired "From your records" bridge prefix.
//
// The "From your records" bridge (issue #560/#817) surfaced imported prescription
// records (`medical_records` category='prescription') with no matched tracked med as
// a suggest-only "Track this". Migration 092 (#1178) consolidated every such row into
// the single medication entity (`intake_items`), leaving the bridge unreachable by
// construction, and it was removed outright (owner decision, #1270). The record↔med
// matcher and the `bridgeCandidates`/`medBridgeDismissalKey` generators went with it.
//
// What remains is deliberately small:
//   - `medNameKey`, the pure name-collapse key shared by the import/renewal/family
//     paths (`lib/import-persist.ts`, `lib/medication-renewal.ts`,
//     `lib/medication-family.ts`, `lib/queries/intake/medications.ts`), so those
//     paths and the (now-gone) bridge could never disagree on how a med name folds.
//   - `MED_BRIDGE_PREFIX`, kept ONLY so a stored `med-bridge:` dismissal row outlives
//     the removed feature (#203): the suppressed-center resolver
//     (`lib/suppression-display.ts`) still labels such a row from its key alone, and
//     Restore clears it. No code mints a new `med-bridge:` key anymore.
//
// Pure — no DB or network. Unit-tested in
// lib/__tests__/medication-record-match.test.ts.

import { cleanMedicationName } from "./prescription-parse";
import { splitMedicationName } from "./medication-info";

// RETIRED (#1270): the dismissal-key prefix the removed records bridge used. No write
// path generates this anymore; it survives solely so an ALREADY-STORED `med-bridge:`
// dismissal row (from a pre-removal instance) still resolves to a label and clears via
// Restore in the suppressed center (#203 — dismissal rows outlive their feature).
// Referenced by lib/suppression-display.ts's orphan-labeling entry.
export const MED_BRIDGE_PREFIX = "med-bridge:";

// The NAME KEY for any medication name. cleanMedicationName strips a trailing
// strength/form; splitMedicationName then collapses a brand to its generic so both
// sides land on the same token ("Advil" and "Ibuprofen" → "ibuprofen"). Shared by the
// #1027 ingredient-family derivation (lib/medication-family.ts) and the import/renewal
// paths so they can never disagree on how a med name collapses.
export function medNameKey(name: string): string {
  const cleaned = cleanMedicationName(name);
  const generic = splitMedicationName(cleaned).name || cleaned;
  return generic.toLowerCase().trim();
}
