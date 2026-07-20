// Structural data-quality gathers (issue #1045). The two COUNT reads the pure gap
// detectors (lib/data-quality.ts) can't derive from other query layers: active
// medications with no confirmed RxCUI (name-only safety matching), and documents whose
// extraction FAILED (imported but contributing nothing). Both are profile-scoped
// directly (the lib/__tests__/profile-scoping.test.ts guard walks all of lib/).
import { db } from "../db";

// Read a single scalar COUNT(*) alias `c`.
function scalar(row: unknown): number {
  return (row as { c: number } | undefined)?.c ?? 0;
}

// Active medications with NO confirmed RxCUI — name-only interaction/PGx/dental/
// ototoxic screening (#1032's limited-coverage state; #851 confirm is the fix). Only
// `kind = 'medication'` and `active = 1` count — an inactive or supplement row is out
// of the safety stack. A blank/whitespace rxcui is "no code", same as NULL.
export function getMedicationsMissingRxcuiCount(profileId: number): number {
  return scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM intake_items
          WHERE profile_id = ? AND kind = 'medication' AND active = 1
            AND (rxcui IS NULL OR TRIM(rxcui) = '')`
      )
      .get(profileId)
  );
}

// Documents whose extraction is in the terminal `failed` state — stored but
// contributing nothing until reprocessed (Data → Review). Profile-scoped.
export function getFailedExtractionDocumentCount(profileId: number): number {
  return scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM medical_documents
          WHERE profile_id = ? AND extraction_status = 'failed'`
      )
      .get(profileId)
  );
}
