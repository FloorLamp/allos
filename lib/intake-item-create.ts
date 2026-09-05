// The ONE way an intake item is born (#4669).
//
// WHAT THIS REPLACES. Three production statements used to spell `INSERT INTO
// intake_items`, with three different column sets:
//
//   1. the form (`addIntakeItem`) — 36 columns, every affordance the item form offers;
//   2. `acceptSuggestion` — 12 columns, leaning on the schema's `kind='supplement'`
//      default to say what it was creating;
//   3. the import (`persistExtractedMedications`) — 15 columns, then three follow-up
//      UPDATEs for rxcui / encounter_id / indication_condition_id.
//
// A column absent from one of those sets was sometimes a DELIBERATE DIFFERENCE (an
// import genuinely knows no `brand`, a supplement suggestion has no prescriber) and
// sometimes a DEFECT (an imported prescription landed `rx = 0` — OTC — while the
// migration that introduced the column backfilled exactly that row shape to 1). The
// two are indistinguishable from a diff of three statements, which is why they are
// one statement now: what a creator does not know it OMITS, and what an intake item
// IS, this file decides.
//
// WHAT AN INTAKE ITEM IS, stated once:
//   • It has a name. Blank is refused, from every door.
//   • Its KIND is declared, never defaulted by the schema. Kind decides which columns
//     are even meaningful, so it cannot be a thing the row happens to fall into.
//   • Its obligation defaults to its KIND's default (`must` for a medication, #1505),
//     not to the column's blanket `should`.
//   • A medication's Rx/OTC flag is derived when unstated by the same rule migration
//     045 backfilled with: a recorded prescriber or Rx number ⇒ prescription.
//   • Medication-only fields are NULL on a supplement and supplement-only fields are
//     NULL on a medication — a kind's columns belong to that kind
//     (`intakeKindAffordances` is the same table the form reads).
//   • A PRN redose notice that cannot fire is not stored as armed.
//   • An item pooled onto a shared bottle keeps no private count (#1705).
//   • Its doses are born stamped (`created_at`, #430) and with their first schedule
//     VERSION (#1973) — otherwise the first edit has nothing to close and retroactively
//     re-judges every past day.
//   • A new medication opens a course.
//
// COLUMNS THIS DELIBERATELY DOES NOT WRITE, so their absence is a statement rather
// than an oversight: `source_name` (written only by the import-review rename, with
// COALESCE, #3480), `source_record_id` (migration 092's projection provenance — no
// live creator has one), `last_fill_size` (a refill records it, not a birth), and
// `active`, which is always 1 here because a newly created item is being tracked.
//
// The caller owns the transaction. Every satellite write below is the caller's
// transaction too, so an item and its doses and its course land together or not at all.

import { db, today } from "./db";
import { sqlNow } from "./clock";
import { intakeKindAffordances } from "./intake-kind-affordances";
import { ensureMedicationCourse, recordScheduleVersion } from "./queries";
import type { CourseAttribution } from "./queries";
import type { FoodTiming, IntakeCondition, IntakeObligation } from "./types";
import type { CadenceKind } from "./intake-cadence";

/** The one refusal a create can return. Rendered verbatim by the form. */
export const INTAKE_ITEM_NAME_REQUIRED = "Enter a name.";

/** A dose row to create alongside the item, in the caller's own order. */
export interface IntakeItemDoseSeed {
  amount: string | null;
  time_of_day: string | null;
  food_timing: FoodTiming;
  // The per-row calendar (#1602). Absent means "no opinion" — the import and the
  // suggestion accept have no calendar to offer, which is not the same as a gap.
  weekdays?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

/**
 * Where the row came from, and everything that provenance implies. `source` is not a
 * free string here: an extracted item carries its document and its reprocess key with
 * it, so "extracted with no document link" cannot be spelled.
 */
export type IntakeItemProvenance =
  | { source: "manual" }
  | {
      source: "extracted";
      // NULL for a documentless (paste) import — its stable id suffices.
      documentId: number | null;
      importKey: string | null;
    };

/**
 * A new medication's initial course. Required for a medication and unspellable for a
 * supplement, because "a medication with no course" is the state every course reader
 * has to special-case.
 *   • `open`   — this core opens it (the form's start date, or the import's fallback).
 *   • `caller` — the caller writes the DERIVED courses itself (an import whose source
 *                carried explicit periods), inside this same transaction.
 */
export type InitialMedicationCourse =
  | {
      kind: "open";
      startedOn: string | null;
      // Keep an UNKNOWN start unknown rather than defaulting it to the created day.
      preserveUnknownStart?: boolean;
      attribution?: CourseAttribution;
    }
  | { kind: "caller" };

interface IntakeItemCreateBase {
  name: string;
  provenance: IntakeItemProvenance;
  condition?: IntakeCondition;
  // Omitted → the kind's default obligation, not the column's.
  obligation?: IntakeObligation;
  notes?: string | null;
  brand?: string | null;
  product?: string | null;
  stack?: string | null;
  // The free-text situation label and its id-keyed row (#560). Both are dropped
  // unless the condition is `situational` — the free-text column is documented as a
  // denormalized FALLBACK for the id, and a fallback without its id is a lie.
  situation?: string | null;
  situationId?: number | null;
  // The INVERSE "pause while X is active" link (#1296) — independent of `condition`.
  pauseSituationId?: number | null;
  critical?: number;
  escalateAfterMin?: number | null;
  escalateChatId?: string | null;
  quantityOnHand?: number | null;
  qtyPerDose?: number;
  rxcui?: string | null;
  rxcuiIngredients?: string | null;
  encounterId?: number | null;
  supplyId?: number | null;
  cadenceKind?: CadenceKind;
  cadenceWeekdays?: string | null;
  cadenceIntervalDays?: number | null;
  cadenceAnchorDate?: string | null;
  doses?: IntakeItemDoseSeed[];
}

interface MedicationOnlyFields {
  prescriber?: string | null;
  pharmacy?: string | null;
  rxNumber?: string | null;
  // These two are the best TEXT available, and they are not always an ASSERTION. An
  // import with no structured attribution scrapes them out of the sig and notes
  // (prescription-parse's label heuristics), where "Call your doctor if symptoms
  // persist" reads as a prescriber and "no prescription required" as an Rx number.
  // A caller that got a field that way says so here; the field is still stored, but
  // the Rx derivation below will not treat a guess as evidence of a prescription.
  // Omitted → false: a hand-entered field is asserted by the person who typed it.
  prescriberScraped?: boolean;
  rxNumberScraped?: boolean;
  // Omitted → derived (prescriber or Rx number ⇒ prescription), migration 045's rule.
  rx?: number;
  providerId?: number | null;
  indicationConditionId?: number | null;
  // PRN safety numbers — only ever the user-CONFIRMED label figures (#798/#1854).
  minIntervalHours?: number | null;
  maxDailyCount?: number | null;
  maxDailyAmountMg?: number | null;
  redoseNotice?: number;
}

export type IntakeItemCreate = IntakeItemCreateBase &
  (
    | { kind: "supplement" }
    | ({
        kind: "medication";
        course: InitialMedicationCourse;
      } & MedicationOnlyFields)
  );

export type IntakeItemCreateResult =
  { ok: true; id: number } | { ok: false; error: string };

function hasText(value: string | null | undefined): boolean {
  return !!value && value.trim() !== "";
}

/**
 * Insert ONE dose row, born properly. The two things a bare
 * `INSERT INTO intake_item_doses` kept forgetting:
 *
 *   • `created_at` from the CLOCK SEAM (sqlNow, #1534) — the adherence-pattern window
 *     starts at the DOSE's real birth, not the parent item's (#430), and
 *     doseAdherenceSince truncates the stamp to a calendar day. SQLite forbids
 *     `datetime('now')` as an ADD COLUMN default, so an insert that omits it stores
 *     NULL, which reads as "born at the epoch".
 *   • the first schedule VERSION (#1973). Without it the FIRST edit has nothing to
 *     close: the new version becomes the earliest one and the resolver's
 *     before-recorded-history fallback re-judges every past day by the NEW rule.
 *
 * The import's dose insert did neither, which is the second half of what #4669 found.
 * Shared with the edit path so a dose added by an edit is born the same way.
 * Returns the new dose id. Must run inside the caller's write transaction.
 */
export function insertIntakeDose(
  itemId: number,
  dose: IntakeItemDoseSeed,
  // The profile-LOCAL calendar day the dose is born on — its first version's
  // `effective_from`. Local rather than a UTC slice of created_at because it is
  // compared against the profile-local windows every adherence surface is built from.
  birthDay: string,
  sort = 0
): number {
  const info = db
    .prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at,
          weekdays, start_date, end_date)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      itemId,
      dose.amount,
      dose.time_of_day,
      dose.food_timing,
      sort,
      sqlNow(),
      dose.weekdays ?? null,
      dose.start_date ?? null,
      dose.end_date ?? null
    );
  const doseId = Number(info.lastInsertRowid);
  recordScheduleVersion(doseId, birthDay, dose);
  return doseId;
}

/**
 * Create one intake item, its doses, and (for a medication) its opening course.
 *
 * Profile-scoped by construction: `profileId` is bound into the row, and every
 * satellite write is keyed to the id this insert returned. The caller resolves
 * authorization at the request boundary and passes the profile it proved.
 *
 * Must run inside the caller's write transaction.
 */
export function createIntakeItemCore(
  profileId: number,
  input: IntakeItemCreate
): IntakeItemCreateResult {
  const name = input.name.trim();
  if (!name) return { ok: false, error: INTAKE_ITEM_NAME_REQUIRED };

  const isMed = input.kind === "medication";
  const med: MedicationOnlyFields = isMed ? input : {};
  const condition: IntakeCondition = input.condition ?? "daily";
  const affordances = intakeKindAffordances(input.kind);
  const obligation = input.obligation ?? affordances.defaultObligation;

  // A medication's identity columns; NULL on a supplement, where they mean nothing.
  const prescriber = isMed ? (med.prescriber ?? null) : null;
  const pharmacy = isMed ? (med.pharmacy ?? null) : null;
  const rxNumber = isMed ? (med.rxNumber ?? null) : null;
  // Migration 045's derivation, applied at CREATION rather than only at backfill: an
  // imported prescription arrives with a prescriber and an Rx number and used to land
  // as OTC, which hid those very fields and read as "OTC" on the badge and to the
  // episode reconciler. A caller that KNOWS (the form's explicit 0/1) still wins.
  //
  // It reads ATTRIBUTION SOMEBODY ASSERTED, never a free-text scrape. 045 backfilled
  // over columns a person had typed, so "there is a prescriber" was a fact; at import
  // time the same two columns may hold a label heuristic's guess over prose, and
  // deriving a clinical flag from a guess turns "Call your doctor if symptoms
  // persist" into a prescription — which the episode reconciler then reads as an Rx
  // course rather than the OTC PRN it is (lib/episode-med-reconcile.ts).
  const assertedPrescriber = med.prescriberScraped ? null : prescriber;
  const assertedRxNumber = med.rxNumberScraped ? null : rxNumber;
  const rx = !isMed
    ? 0
    : (med.rx ??
      (hasText(assertedPrescriber) || hasText(assertedRxNumber) ? 1 : 0));
  const providerId = isMed ? (med.providerId ?? null) : null;
  const indicationConditionId = isMed
    ? (med.indicationConditionId ?? null)
    : null;

  // A `may` item is on demand by construction (#1505), and only a PRN MEDICATION
  // carries redose numbers. The notice is armed only when both numbers are confirmed:
  // an opt-in that can never fire is not stored as "on" (the #798 liability line).
  const isPrnMedication = isMed && obligation === "may";
  const minIntervalHours = isPrnMedication
    ? (med.minIntervalHours ?? null)
    : null;
  const maxDailyCount = isPrnMedication ? (med.maxDailyCount ?? null) : null;
  const maxDailyAmountMg = isPrnMedication
    ? (med.maxDailyAmountMg ?? null)
    : null;
  const redoseNotice =
    isPrnMedication &&
    minIntervalHours != null &&
    maxDailyCount != null &&
    med.redoseNotice
      ? 1
      : 0;

  // Stack is a SUPPLEMENT affordance — the form does not offer it to a medication, and
  // neither does the model. Read from the affordance table rather than re-spelled as
  // `isMed`, because the EDIT path reads the same table for the same column: a row's
  // shape must not depend on which door touched it last.
  const stack = affordances.stack ? (input.stack ?? null) : null;

  // The situational pair stands or falls together (see IntakeItemCreateBase).
  const situational = condition === "situational";
  const situation = situational ? (input.situation ?? null) : null;
  const situationId = situational ? (input.situationId ?? null) : null;

  // Pooled onto a shared bottle (#1705): a linked item keeps NO private count, so the
  // phantom-double-supply invariant cannot depend on the caller remembering it.
  const supplyId = input.supplyId ?? null;
  const quantityOnHand =
    supplyId != null ? null : (input.quantityOnHand ?? null);

  const provenance = input.provenance;
  const documentId =
    provenance.source === "extracted" ? provenance.documentId : null;
  const importKey =
    provenance.source === "extracted" ? provenance.importKey : null;

  // created_at is bound from the CLOCK SEAM (sqlNow, #1534) rather than left to the
  // column's `datetime('now')` default: an intake item's created_at is read as a
  // calendar DAY — `date(created_at)` seeds a medication course's started_on and
  // decides episode membership (getEpisodeMedReconciliation), and doseAdherenceSince
  // truncates it — all against `today()`-derived windows.
  const info = db
    .prepare(
      `INSERT INTO intake_items
         (profile_id, name, notes, active, kind, condition, obligation,
          brand, product, stack, situation, situation_id, pause_situation_id,
          critical, escalate_after_min, escalate_chat_id,
          quantity_on_hand, qty_per_dose, supply_id,
          prescriber, pharmacy, rx_number, rx, provider_id,
          indication_condition_id, encounter_id,
          min_interval_hours, max_daily_count, max_daily_amount_mg, redose_notice,
          rxcui, rxcui_ingredients,
          source, document_id, import_key, created_at,
          cadence_kind, cadence_weekdays, cadence_interval_days, cadence_anchor_date)
       VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      profileId,
      name,
      input.notes ?? null,
      input.kind,
      condition,
      obligation,
      input.brand ?? null,
      input.product ?? null,
      stack,
      situation,
      situationId,
      input.pauseSituationId ?? null,
      input.critical ?? 0,
      input.escalateAfterMin ?? null,
      input.escalateChatId ?? null,
      quantityOnHand,
      input.qtyPerDose ?? 1,
      supplyId,
      prescriber,
      pharmacy,
      rxNumber,
      rx,
      providerId,
      indicationConditionId,
      input.encounterId ?? null,
      minIntervalHours,
      maxDailyCount,
      maxDailyAmountMg,
      redoseNotice,
      input.rxcui ?? null,
      input.rxcuiIngredients ?? null,
      provenance.source,
      documentId,
      importKey,
      sqlNow(),
      input.cadenceKind ?? "daily",
      input.cadenceWeekdays ?? null,
      input.cadenceIntervalDays ?? null,
      input.cadenceAnchorDate ?? null
    );
  const itemId = Number(info.lastInsertRowid);

  const birthDay = today(profileId);
  (input.doses ?? []).forEach((d, i) =>
    insertIntakeDose(itemId, d, birthDay, i)
  );

  if (input.kind === "medication" && input.course.kind === "open") {
    ensureMedicationCourse(
      profileId,
      itemId,
      input.course.startedOn,
      input.course.preserveUnknownStart ?? false,
      input.course.attribution
    );
  }

  return { ok: true, id: itemId };
}
