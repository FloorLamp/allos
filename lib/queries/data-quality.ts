// Structural data-quality gathers (issue #1045). The reads the pure gap detectors
// (lib/data-quality.ts) can't derive from other query layers: active medications with
// no confirmed RxCUI (name-only safety matching), documents whose extraction FAILED
// (imported but contributing nothing), and dose amounts nothing can read (#3320). The
// two COUNTs are profile-scoped directly (the lib/__tests__/profile-scoping.test.ts
// guard walks all of lib/); the dose read owns no SQL and projects the profile-scoped
// intake reads.
import { db } from "../db";
import { readDoseQuantity } from "../dri";
import { getIntakeItems, getIntakeDoses } from "./intake/schedule";
import type { IntakeItemKind } from "../types/intake";

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

// The SOLE unconfirmed medication's id when exactly ONE active medication lacks a
// confirmed RxCUI, else null (#1146). Same predicate as the count above (the two
// reads must agree on what "unconfirmed" means), read with LIMIT 2 so a many-med
// profile never pays for a full-list scan. Profile-scoped.
export function getMedicationMissingRxcuiSoleId(
  profileId: number
): number | null {
  const rows = db
    .prepare(
      `SELECT id FROM intake_items
        WHERE profile_id = ? AND kind = 'medication' AND active = 1
          AND (rxcui IS NULL OR TRIM(rxcui) = '')
        LIMIT 2`
    )
    .all(profileId) as { id: number }[];
  return rows.length === 1 ? rows[0].id : null;
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

// ---- Dose amounts nothing can read (#3320) ----

// The LIVE dose rows of ACTIVE items whose amount states a number the separator rule
// refuses (`"2,5 g"` — 2.5 g or 25 g, and nothing in the row says which; `"10.000 IU"`
// — ten, or ten thousand). #3153 stopped the write path storing new ones; rows written
// before that fix are still there, and since a dose keeps no reading beside its text,
// nothing was ever stored wrong — the amount simply reads as ABSENT now, and the
// upper-limit and RDA totals skip it without saying so. This read is what makes the
// skip visible.
//
// NO SQL OF ITS OWN, and it could not have any: the rule lives in `readDoseQuantity`
// and SQLite cannot apply it. A GLOB/regex restatement would be a second copy of the
// rule #3153 finished unifying, and a census that disagrees with the engine it
// describes is worse than none. So this projects the already-cached, profile-scoped
// item and dose reads and asks the shipped function.
//
// Scope, deliberately: ACTIVE items only (an inactive item is out of the safety stack,
// the same boundary getMedicationsMissingRxcuiCount draws) and LIVE doses only
// (getIntakeDoses excludes retired rows — a retired dose is history, not a number any
// total is reaching for today).
//
// SAY WHAT THAT COSTS, because it is not obvious to a later reader: a retired dose
// whose amount is ambiguous is permanently invisible AS A GAP. Nothing will ever
// prompt anyone to retype it. That exclusion is a DEFERRAL rather than a discard, and
// the reason is `unretireDose` (lib/queries/intake/dose-lifecycle.ts): restoring a
// retired dose puts the row back in the live set with its `amount` untouched — the
// row's id, and its text, are exactly the ones that were retired — so the gap fires
// the moment the dose is schedulable again, which is the moment a total would reach
// for its number. The dose ledger still shows the raw string throughout.
//
// AND WHAT THIS COUNT IS NOT. It is a CEILING on the safety-relevant population, not
// equal to it: only items on an every-day schedule contribute to the daily UL/RDA
// totals (`contributesToDailyLimit`, #635), so a situational or workout-conditioned
// item's unreadable amount is counted here while feeding no upper-limit total at all.
// That is deliberate — an unreadable amount is unusable for every consumer, not just
// the UL, and retyping it is worth the same either way — but do not read the number as
// "doses missing from a safety total". It is at most that many.
export function getUnreadableDoseAmounts(
  profileId: number
): { itemId: number; kind: IntakeItemKind }[] {
  const kindById = new Map<number, IntakeItemKind>();
  for (const item of getIntakeItems(profileId)) {
    if (item.active) kindById.set(item.id, item.kind);
  }
  const out: { itemId: number; kind: IntakeItemKind }[] = [];
  for (const dose of getIntakeDoses(profileId)) {
    const kind = kindById.get(dose.item_id);
    if (!kind) continue;
    if (readDoseQuantity(dose.amount).kind !== "unreadable") continue;
    out.push({ itemId: dose.item_id, kind });
  }
  return out;
}
