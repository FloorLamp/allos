// Structural data-quality gathers (issue #1045). The reads the pure gap detectors
// (lib/data-quality.ts) can't derive from other query layers: active medications with
// no confirmed RxCUI (name-only safety matching), documents whose extraction FAILED
// (imported but contributing nothing), and dose amounts nothing can read (#3320). The
// two COUNTs are profile-scoped directly (the lib/__tests__/profile-scoping.test.ts
// guard walks all of lib/); the dose read owns no SQL and projects the profile-scoped
// intake reads.
import { db } from "../db";
import { readDoseQuantity } from "../dri";
import { isOnDemand, stackSchedule } from "../intake-schedule";
import { prnDefaultsFor, prnLabelIdentityFor } from "../prn-defaults";
import { parseRxcuiIngredients } from "../rxnorm";
import { getIntakeItems, getIntakeDoses } from "./intake/schedule";
import type { IntakeGapItem } from "../data-quality";
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
// — ten, or ten thousand). #3153 stopped interactive writes; bulk imports preserve
// ambiguous source text for review (#3321). Since a dose keeps no reading beside its text,
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
): UnreadableDoseAmount[] {
  return getIntakeDataQualityRows(profileId).unreadableAmounts;
}

// ---- Obligations the saved schedule cannot keep (#5285) ----

// One live dose row whose amount states a number nothing may read (#3320). It names a
// DOSE, which is why it carries both ids; the two obligation lists below name an ITEM
// and carry the pure model's own `IntakeGapItem`.
export interface UnreadableDoseAmount {
  doseId: number;
  itemId: number;
  itemName: string;
  kind: IntakeItemKind;
  amount: string;
}

// EVERY structural gap that is a question about the intake rows, from ONE pass over
// them. Three lists, one gather:
//
//   unreadableAmounts    a live amount `readDoseQuantity` refuses (#3320, above).
//   unscheduled          a `must`/`should` item on which no live dose states a time,
//                        so `stackSchedule` reads "Not scheduled" and the item is due
//                        nowhere, reminds nothing and counts in no adherence day. The
//                        app already knew — the Manage list says it; nothing asked.
//   obligationMismatch   a `must`/`should` item whose product the curated PRN registry
//                        knows as an as-needed one (`prnDefaultsFor` — the resolved
//                        ingredient CUIs first, then the whole name), so the daily
//                        obligation is probably a mis-set field rather than a decision.
//                        SUGGEST-ONLY: keeping the schedule is a legitimate answer,
//                        which is why nothing here writes.
//
// ONE FUNCTION BECAUSE ONE COST. The reads beneath it are `snapshotCached`, and the
// caller that matters — Home's Setup section — is a streamed child Server Component,
// which runs with the read snapshot CLOSED (lib/read-snapshot.ts documents exactly
// that boundary). So a second reader asking `getIntakeItems`/`getIntakeDoses` for its
// own answer is a second EXECUTION of both, measured at +2 statements on five of the
// six Home personas. Asking all three questions where the rows are already in hand
// costs nothing, and the meter in lib/__db_tests__/dashboard-placement-manifest.test.ts
// is what says so.
//
// NO SQL OF ITS OWN, and it could not have any: every rule here lives in a shipped
// function — `readDoseQuantity`, `stackSchedule`, `prnDefaultsFor` — and SQLite can
// apply none of them. A restatement in SQL would be a second copy of each, and a
// census that disagrees with the engine it describes is worse than none. So this
// projects the already-cached, profile-scoped item and dose reads and asks them.
//
// PRODUCT IDENTITY BEATS THE DISPLAY NAME (#5518): an item linked to a shared bottle
// keeps its own label while the BOTTLE owns what the product is, so the registry is
// asked through `prnLabelIdentityFor` — the same projection the item form and the
// quick-log reader use. The prod row #5285 was reported from is exactly that shape.
//
// Scope, deliberately the same boundary throughout: ACTIVE items only (an inactive item
// is out of the safety stack, the same boundary getMedicationsMissingRxcuiCount draws)
// and LIVE doses only (getIntakeDoses excludes retired rows). `may` items never appear
// in the two obligation lists — an as-needed item is definitionally not owed on any
// day, so it has no schedule to be missing and no obligation to disagree with.
export function getIntakeDataQualityRows(profileId: number): {
  unreadableAmounts: UnreadableDoseAmount[];
  unscheduled: IntakeGapItem[];
  obligationMismatch: IntakeGapItem[];
} {
  const unreadableAmounts: UnreadableDoseAmount[] = [];
  const unscheduled: IntakeGapItem[] = [];
  const obligationMismatch: IntakeGapItem[] = [];

  const activeItems = getIntakeItems(profileId).filter((item) => !!item.active);
  const itemById = new Map(activeItems.map((item) => [item.id, item]));

  const scheduledItemIds = new Set<number>();
  for (const dose of getIntakeDoses(profileId)) {
    const item = itemById.get(dose.item_id);
    if (!item) continue;
    if (stackSchedule(item, dose).scheduled) scheduledItemIds.add(item.id);
    if (dose.amount == null) continue;
    if (readDoseQuantity(dose.amount).kind !== "unreadable") continue;
    unreadableAmounts.push({
      doseId: dose.id,
      itemId: dose.item_id,
      itemName: item.name,
      kind: item.kind,
      amount: dose.amount,
    });
  }

  for (const item of activeItems) {
    if (isOnDemand(item)) continue;
    const row = { id: item.id, name: item.name, kind: item.kind };
    if (!scheduledItemIds.has(item.id)) unscheduled.push(row);
    const asNeededProduct = prnDefaultsFor(
      prnLabelIdentityFor({
        name: item.name,
        supplyId: item.supply_id,
        supplyName: item.supply_name,
        rxcui: item.rxcui,
        rxcuiIngredients: parseRxcuiIngredients(item.rxcui_ingredients),
      })
    );
    if (asNeededProduct !== null) obligationMismatch.push(row);
  }
  return { unreadableAmounts, unscheduled, obligationMismatch };
}
