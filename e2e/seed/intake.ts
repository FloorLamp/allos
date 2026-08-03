// e2e seed fixtures — intake domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { db, today } from "../../lib/db";
import { now as clockNow } from "../../lib/clock";
import { shiftDateStr, utcSqlString } from "../../lib/date";
import {
  E2E_LOGIN_SUPPLY,
  SUPPLY_PARENT_PROFILE,
  SUPPLY_CHILD_PROFILE,
  SUPPLY_SHARED_BOTTLE,
  SUPPLY_PARENT_MED,
  SUPPLY_CHILD_MED,
  SUPPLY_LOW_BOTTLE,
  SUPPLY_PARENT_LOW_MED,
  SUPPLY_CHILD_LOW_MED,
  SUPPLY_EDIT_BOTTLE,
  SUPPLY_PARENT_EDIT_MED,
  E2E_LOGIN_DRUG_ALLERGY,
  DRUG_ALLERGY_PROFILE,
  E2E_LOGIN_PRN_FAMILY,
  PRN_FAMILY_PROFILE,
  E2E_LOGIN_COVERAGE,
  SAFETY_COVERAGE_PROFILE,
  E2E_LOGIN_UPCOMING_AGG,
  UPCOMING_AGG_PROFILE,
  UPCOMING_AGG_WARFARIN,
  UPCOMING_AGG_ASPIRIN,
  UPCOMING_AGG_NSAID,
  UPCOMING_AGG_SSRI,
  UPCOMING_AGG_SUPPLEMENT,
  UPCOMING_AGG_TAKEN,
  UPCOMING_AGG_PRN,
} from "../fixture-logins";
import {
  PROFILE_ID,
  seedMemberLogin,
  fixtureProfileId,
  grantProfile,
} from "./common";

// ── Percent-strength + med-card adherence/refill parity ──
// The med-card adherence/refill parity medication's name. Exported because ./imports
// re-resolves the row by it (to attach the registry-backed provider).
export const PARITY_MED_NAME = "Adherence Refill Med (e2e)";

export function seedMedicationCards(): void {
  // ── Percent-strength medication fixture (issue #272) ─────────────────────────
  // A topical med whose name carries a PERCENT strength ("Hydrocortisone 2.5%
  // Cream"). Its educational "What is this?" explainer only renders when the name
  // normalizer strips the percent strength before the description lookup — the
  // regression this fixture pins in the browser. PRN (obligation 'may', the Ibuprofen
  // precedent) so it adds no scheduled-due dose to reminder/digest fixtures, and
  // hydrocortisone appears in no interaction dataset, so other specs are
  // undisturbed. Synthetic prescriber — no real PHI.
  const PCT_MED_NAME = "Hydrocortisone 2.5% Cream";
  if (
    !db
      .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
      .get(PROFILE_ID, PCT_MED_NAME)
  ) {
    const pctMed = db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, notes, condition, obligation, kind, prescriber, active)
         VALUES (?, ?, 'Topical steroid — apply to affected area', 'daily', 'may', 'medication', 'Dr. Test Provider', 1)`
      )
      .run(PROFILE_ID, PCT_MED_NAME);
    const pctMedId = Number(pctMed.lastInsertRowid);
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, 'thin layer', 'Anytime', 'any', 0)`
    ).run(pctMedId);
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
     VALUES (?, ?, NULL, NULL, 'PRN for eczema flare')`
    ).run(pctMedId, shiftDateStr(today(PROFILE_ID), -14));
  }

  console.log(
    `e2e: seeded percent-strength medication "${PCT_MED_NAME}" (#272)`
  );

  // ── Med-card adherence + refill parity fixture (issue #747) ──────────────────
  // A CURRENT (open-course, active, daily) medication carrying refill tracking
  // (quantity_on_hand) AND a run of deterministic taken-logs, so its medication
  // CARD renders BOTH the "≈N days left" refill badge and the 14-day adherence
  // summary line — the parity the med card previously lacked (it received neither
  // strip nor refillRate). Fully synthetic name with no rxcui → matches no
  // interaction/PGx/food-drug dataset, so other specs are undisturbed; supply is
  // set HIGH (90 units ÷ ~1/day ≈ 90 days) so it stays ABOVE the low-supply
  // threshold and never joins the dashboard Low-supply widget / Upcoming refill
  // fixtures. Idempotent: re-created from scratch each boot so the log window
  // stays today-relative.
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    PROFILE_ID,
    PARITY_MED_NAME
  );
  const parityMedId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, notes, condition, obligation, kind, prescriber, active, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 'Daily maintenance med — e2e parity fixture', 'daily', 'should', 'medication', 'Dr. Test Provider', 1, 90, 1)`
      )
      .run(PROFILE_ID, PARITY_MED_NAME).lastInsertRowid
  );
  const parityDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 tablet', 'Morning', 'any', 0)`
      )
      .run(parityMedId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'Ongoing — e2e parity fixture')`
  ).run(parityMedId, shiftDateStr(today(PROFILE_ID), -60));
  // Deterministic taken-logs for the last 14 days (every day taken) → 100%
  // adherence, so the AdherenceSummaryLine renders with stable text regardless of
  // the run. (Medication cards use the default visibility mode, which shows the
  // percentage at any value — the resting-supplement "noteworthy only" gate is a
  // different path.)
  const insParityLog = db.prepare(
    `INSERT OR IGNORE INTO intake_item_logs (dose_id, item_id, date, status)
   VALUES (?, ?, ?, 'taken')`
  );
  for (let i = 1; i <= 14; i++) {
    insParityLog.run(
      parityDoseId,
      parityMedId,
      shiftDateStr(today(PROFILE_ID), -i)
    );
  }

  console.log(
    `e2e: seeded med-card adherence+refill parity fixture "${PARITY_MED_NAME}" (#747)`
  );
}

// ── PRN administration ledger ──
export function seedPrnLedger(): void {
  // ── PRN administration ledger fixture (issue #797) ───────────────────────────
  // A CURRENT, active PRN (`may`) medication with refill tracking and TWO
  // administrations already logged TODAY (real given_at times), so BOTH the
  // Medications-page card ("2 today · last …") and the dashboard "Log a PRN dose"
  // widget render a populated PRN med, and the widget's "Log" button can add a
  // third. Fully synthetic name with no rxcui → matches no interaction/PGx/food-drug
  // dataset, so other specs are undisturbed; supply stays HIGH (60 units) so it never
  // joins the low-supply widget/Upcoming fixtures. Idempotent: recreated each boot so
  // the administrations stay today-relative. given_at is stored UTC ("YYYY-MM-DD
  // HH:MM:SS"); the profile tz labels the displayed clock.
  const PRN_MED_NAME = "PRN Quicklog Med (e2e)";
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    PROFILE_ID,
    PRN_MED_NAME
  );
  const prnMedId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, notes, condition, obligation, kind, prescriber, active, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 'As-needed med — e2e PRN quick-log fixture', 'daily', 'may', 'medication', 'Dr. Test Provider', 1, 60, 1)`
      )
      .run(PROFILE_ID, PRN_MED_NAME).lastInsertRowid
  );
  const prnDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', 'Anytime', 'any', 0)`
      )
      .run(prnMedId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'PRN — e2e fixture')`
  ).run(prnMedId, shiftDateStr(today(PROFILE_ID), -5));
  // Two administrations earlier today, so the card shows "2 today". given_at is
  // computed from seed-time minus a fixed offset (45m / 90m ago) — always well outside
  // the widget's ~2-minute double-tap dedup window from the later test-run "now", so a
  // subsequent widget "Log" click deterministically becomes the third. `date` is pinned
  // to today() (not derived from given_at) so the count stays "today" even if an offset
  // crosses UTC midnight at boot.
  const prnToday = today(PROFILE_ID);
  const insAdmin = db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, amount, status)
   VALUES (?, ?, ?, ?, '400 mg', 'taken')`
  );
  for (const minutesAgo of [90, 45]) {
    insAdmin.run(
      prnDoseId,
      prnMedId,
      prnToday,
      utcSqlString(new Date(clockNow().getTime() - minutesAgo * 60 * 1000))
    );
  }

  console.log(
    `e2e: seeded PRN administration ledger fixture "${PRN_MED_NAME}" (#797)`
  );

  // A second PRN med with a CONFIRMED redose notice (#798): min interval 6h, max 4/day,
  // opt-in on, and ONE administration ~7h ago — so the redose window is OPEN and the
  // card/widget render the "Redose OK — min interval passed · 1 of 4 today" status line.
  // Synthetic name → matches no interaction dataset; high supply so it never joins the
  // low-supply fixtures. Idempotent (recreated each boot, administration stays
  // today-relative).
  const REDOSE_MED_NAME = "PRN Redose Med (e2e)";
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    PROFILE_ID,
    REDOSE_MED_NAME
  );
  const redoseMedId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, notes, condition, obligation, kind, prescriber, active, quantity_on_hand, qty_per_dose, min_interval_hours, max_daily_count, redose_notice)
         VALUES (?, ?, 'As-needed med — e2e redose fixture', 'daily', 'may', 'medication', 'Dr. Test Provider', 1, 60, 1, 6, 4, 1)`
      )
      .run(PROFILE_ID, REDOSE_MED_NAME).lastInsertRowid
  );
  const redoseDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '200 mg', 'Anytime', 'any', 0)`
      )
      .run(redoseMedId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'PRN redose — e2e fixture')`
  ).run(redoseMedId, shiftDateStr(today(PROFILE_ID), -30));
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, amount, status)
   VALUES (?, ?, ?, ?, '200 mg', 'taken')`
  ).run(
    redoseDoseId,
    redoseMedId,
    today(PROFILE_ID),
    utcSqlString(new Date(clockNow().getTime() - 7 * 60 * 60 * 1000))
  );
  console.log(
    `e2e: seeded PRN redose-notice fixture "${REDOSE_MED_NAME}" (#798)`
  );
}

// ── Low-supply medication ──
export function seedLowSupply(): void {
  // ── Low-supply medication fixture (issue #852 item 3) ────────────────────────
  // A CURRENT, active, SCHEDULED daily medication sitting BELOW the low-supply threshold —
  // the state the one-tap "Refilled" action + run-out date render on. qty_per_dose is 10
  // (units/day ≈ 10), so 3 units ≈ 0 days left; a +30 refill only reaches ~3 days, keeping
  // it low across the browser test's repeated runs (the shared seed isn't reset between
  // them, so the affordance must persist). A fill size (30) is REMEMBERED so the browser
  // test exercises the genuine one-tap path repeatably (the first-use "ask for a size"
  // path is covered by the action tier). Distinctly named so filter-based specs are
  // undisturbed.
  const LOW_SUPPLY_MED_NAME = "Low Supply Med (e2e)";
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    PROFILE_ID,
    LOW_SUPPLY_MED_NAME
  );
  const lowSupplyMedId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, notes, condition, obligation, kind, prescriber, active, quantity_on_hand, qty_per_dose, last_fill_size)
         VALUES (?, ?, 'e2e low-supply refill fixture', 'daily', 'should', 'medication', 'Dr. Test Provider', 1, 3, 10, 30)`
      )
      .run(PROFILE_ID, LOW_SUPPLY_MED_NAME).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
   VALUES (?, '1 tablet', 'morning', 'any', 0)`
  ).run(lowSupplyMedId);
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
   VALUES (?, ?, NULL, NULL, 'e2e low-supply fixture')`
  ).run(lowSupplyMedId, shiftDateStr(today(PROFILE_ID), -30));
  console.log(
    `e2e: seeded low-supply medication "${LOW_SUPPLY_MED_NAME}" on profile ${PROFILE_ID} (#852)`
  );
}

// ── Drug-allergy x medication cross-check ──
export function seedDrugAllergyCrosscheck(): void {
  // ── Drug-allergy × medication cross-check fixture (#1029, #1092) ──────────────
  // A dedicated adult profile with a recorded "Penicillin — hives" allergy plus two
  // tracked active medications: amoxicillin (a same-class penicillin hit) and
  // cephalexin (the documented penicillin ↔ cephalosporin cross-reactivity hit). The
  // spec asserts the safety-strip cards on /medications and the care-persistent
  // Needs-attention hero finding (#1092: snooze-only, a page dismissal resisted), and
  // owns its dismissal state (reset per test). Idempotent for a reused server:
  // hard-clear this profile's allergies + intake rows before re-seeding. Synthetic, no PHI.
  const drugAllergyId = fixtureProfileId(DRUG_ALLERGY_PROFILE);
  db.prepare(`DELETE FROM allergies WHERE profile_id = ?`).run(drugAllergyId);
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(drugAllergyId);
  db.prepare(
    `DELETE FROM intake_item_doses WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(drugAllergyId);
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(
    drugAllergyId
  );
  db.prepare(
    `INSERT INTO allergies (profile_id, substance, reaction, severity, status)
   VALUES (?, 'Penicillin', 'hives', 'moderate', 'active')`
  ).run(drugAllergyId);
  for (const medName of ["Amoxicillin 500 mg", "Cephalexin 250 mg"]) {
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, obligation)
         VALUES (?, ?, 1, 'medication', 'may')`
    ).run(drugAllergyId, medName);
  }
  seedMemberLogin(E2E_LOGIN_DRUG_ALLERGY, drugAllergyId, "write");
  console.log(
    `e2e: seeded drug-allergy cross-check fixture — profile ${drugAllergyId} (${DRUG_ALLERGY_PROFILE}) (#1029)`
  );
}

// ── Cross-item PRN counter ──
export function seedPrnCounter(): void {
  // ── Cross-item PRN counter fixture (#1027) ────────────────────────────────────
  // A dedicated adult profile with the issue's two-ibuprofen setup: OTC "Ibuprofen"
  // (PRN, confirmed 6h interval / max 4 — the redose-line carrier) plus a second
  // "Ibuprofen 800 mg" item (PRN, unconfirmed fields) whose administration ONE HOUR
  // before the frozen e2e clock holds the OTC item's redose window across the family.
  // The spec asserts the family-widened "across 2 items" counter line on /medications
  // and the coaching duplication note on the dashboard rollup. Idempotent hard-clear
  // for a reused server. Synthetic, no PHI.
  const prnFamilyId = fixtureProfileId(PRN_FAMILY_PROFILE);
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(prnFamilyId);
  db.prepare(
    `DELETE FROM intake_item_doses WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(prnFamilyId);
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(prnFamilyId);
  const prnOtcId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, obligation, redose_notice, min_interval_hours, max_daily_count)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', 1, 6, 4)`
      )
      .run(prnFamilyId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
   VALUES (?, '200 mg', 'anytime', 'any', 0)`
  ).run(prnOtcId);
  const prnRxId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Ibuprofen 800 mg', 1, 'medication', 'daily', 'may')`
      )
      .run(prnFamilyId).lastInsertRowid
  );
  const prnRxDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '800 mg', 'anytime', 'any', 0)`
      )
      .run(prnRxId).lastInsertRowid
  );
  // The sibling administration: 1h before the frozen clock, on the profile-local day.
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status)
   VALUES (?, ?, ?, ?, 'taken')`
  ).run(
    prnRxDoseId,
    prnRxId,
    today(prnFamilyId),
    utcSqlString(new Date(clockNow().getTime() - 3_600_000))
  );
  seedMemberLogin(E2E_LOGIN_PRN_FAMILY, prnFamilyId, "write");
  console.log(
    `e2e: seeded cross-item PRN counter fixture — profile ${prnFamilyId} (${PRN_FAMILY_PROFILE}) (#1027)`
  );
}

// ── Safety-coverage empty state ──
export function seedSafetyCoverage(): void {
  // ── Safety-coverage empty-state fixture (#1032) ───────────────────────────────
  // A dedicated adult profile whose stack produces NO safety warnings: loratadine
  // (off the curated interaction set entirely) + sertraline (a name-matched SSRI
  // concept with no interacting partner), both name-only (no confirmed RxNorm code).
  // The spec asserts the honest empty state — the "checked 1 of 2, no flags" scope
  // line on both safety strips (instead of the pre-#1032 silent blank) and the quiet
  // limited-screening chip on the name-only rows. Idempotent hard-clear for a reused
  // server. Synthetic, no PHI.
  const coverageId = fixtureProfileId(SAFETY_COVERAGE_PROFILE);
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(coverageId);
  db.prepare(
    `DELETE FROM intake_item_doses WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(coverageId);
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(coverageId);
  for (const medName of ["Loratadine 10 mg", "Sertraline 50 mg"]) {
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, obligation)
         VALUES (?, ?, 1, 'medication', 'may')`
    ).run(coverageId, medName);
  }
  seedMemberLogin(E2E_LOGIN_COVERAGE, coverageId, "write");
  console.log(
    `e2e: seeded safety-coverage fixture — profile ${coverageId} (${SAFETY_COVERAGE_PROFILE}) (#1032)`
  );
}

// ── Shared supply pools ──
export function seedSharedSupplyPools(): void {
  // ── #1374 shared supply pools fixture ────────────────────────────────────────
  // One caregiver login granted TWO dedicated profiles, each carrying a daily
  // medication linked to a shared bottle. Two bottles: a well-stocked one (the spec
  // confirms a dose from EACH member and watches ONE count fall), and a deliberately
  // LOW one (so exactly ONE pooled low-supply finding surfaces per bottle, not one per
  // linked member). Spec-owned; idempotent for a reused dev server.
  {
    const supplyParentId = fixtureProfileId(SUPPLY_PARENT_PROFILE);
    const supplyChildId = fixtureProfileId(SUPPLY_CHILD_PROFILE);
    const upsertBottle = (name: string, qty: number): number => {
      const existing = db
        .prepare("SELECT id FROM shared_supplies WHERE name = ?")
        .get(name) as { id: number } | undefined;
      if (existing) return existing.id;
      return Number(
        db
          .prepare(
            "INSERT INTO shared_supplies (name, strength, form, quantity_on_hand) VALUES (?, '200 mg', 'tablet', ?)"
          )
          .run(name, qty).lastInsertRowid
      );
    };
    const upsertLinkedMed = (
      profileId: number,
      name: string,
      supplyId: number
    ): void => {
      const existing = db
        .prepare(
          "SELECT id FROM intake_items WHERE profile_id = ? AND name = ?"
        )
        .get(profileId, name) as { id: number } | undefined;
      if (existing) {
        db.prepare(
          "UPDATE intake_items SET supply_id = ?, quantity_on_hand = NULL WHERE id = ?"
        ).run(supplyId, existing.id);
        return;
      }
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items
             (profile_id, name, kind, condition, obligation, active, source, quantity_on_hand, qty_per_dose, supply_id)
         VALUES (?, ?, 'medication', 'daily', 'should', 1, 'manual', NULL, 1, ?)`
          )
          .run(profileId, name, supplyId).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 tablet', '08:00', 'any', 0)`
      ).run(itemId);
    };

    const sharedBottleId = upsertBottle(SUPPLY_SHARED_BOTTLE, 60);
    upsertLinkedMed(supplyParentId, SUPPLY_PARENT_MED, sharedBottleId);
    upsertLinkedMed(supplyChildId, SUPPLY_CHILD_MED, sharedBottleId);

    // 4 units, two daily consumers at 1 unit/day → 2 days left, well under the
    // 10-day default threshold.
    const lowBottleId = upsertBottle(SUPPLY_LOW_BOTTLE, 4);
    upsertLinkedMed(supplyParentId, SUPPLY_PARENT_LOW_MED, lowBottleId);
    upsertLinkedMed(supplyChildId, SUPPLY_CHILD_LOW_MED, lowBottleId);

    // The edit case's own bottle: one linked med on the parent, so rewriting its
    // count never perturbs the decrement case's arithmetic.
    const editBottleId = upsertBottle(SUPPLY_EDIT_BOTTLE, 75);
    upsertLinkedMed(supplyParentId, SUPPLY_PARENT_EDIT_MED, editBottleId);

    const supplyLoginId = seedMemberLogin(
      E2E_LOGIN_SUPPLY,
      supplyParentId,
      "write"
    );
    grantProfile(supplyLoginId, supplyChildId, "write");
    console.log(
      `e2e: seeded shared-supply-pool fixture — ${E2E_LOGIN_SUPPLY} granted ${SUPPLY_PARENT_PROFILE} (${supplyParentId}) + ${SUPPLY_CHILD_PROFILE} (${supplyChildId}); bottles ${sharedBottleId}/${lowBottleId} (#1374)`
    );
  }
}

// ── Upcoming display aggregation (#1504) ──
export function seedUpcomingAggregate(): void {
  // A dedicated adult profile shaped like the audit's Today band, so the fold and its
  // pinned exclusions can be asserted without touching the shared seed:
  //   • SIX scheduled `must` doses, ONE of them already logged taken today — the fold
  //     must state "5 doses left · 1 of 6 taken", a fraction that only reconciles if
  //     the denominator comes from the same due evaluation as the rows.
  //   • FOUR interacting medications (warfarin + aspirin + an NSAID + an SSRI), which
  //     yield at least three pairwise interaction findings for the med-safety rollup.
  //   • ONE PRN medication logged OVER its confirmed daily max — the pinned safety row
  //     that renders individually, ABOVE the fold, in every state.
  // Idempotent hard-clear so a reused server re-seeds cleanly. Synthetic, no PHI.
  const aggId = fixtureProfileId(UPCOMING_AGG_PROFILE);
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(aggId);
  db.prepare(
    `DELETE FROM intake_item_doses WHERE item_id IN
     (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(aggId);
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(aggId);
  db.prepare(`DELETE FROM upcoming_dismissals WHERE profile_id = ?`).run(aggId);

  const aggDay = today(aggId);
  const scheduled = (name: string, kind: "medication" | "supplement") => {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, ?, 'daily', 'must')`
        )
        .run(aggId, name, kind).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 tab', 'morning', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    return { itemId, doseId };
  };

  for (const name of [
    UPCOMING_AGG_WARFARIN,
    UPCOMING_AGG_ASPIRIN,
    UPCOMING_AGG_NSAID,
    UPCOMING_AGG_SSRI,
  ]) {
    scheduled(name, "medication");
  }
  scheduled(UPCOMING_AGG_SUPPLEMENT, "supplement");
  // The already-taken sixth dose: it is part of the day's schedule (the denominator)
  // and deliberately NOT a pending row, so "1 of 6 taken" is a claim about the same
  // set the disclosure lists.
  const takenDose = scheduled(UPCOMING_AGG_TAKEN, "supplement");
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
     VALUES (?, ?, ?, 'taken', '1 tab')`
  ).run(takenDose.doseId, takenDose.itemId, aggDay);

  // The PRN over-max safety row: confirmed max of 1, logged twice today.
  const prnId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, max_daily_count)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', 1)`
      )
      .run(aggId, UPCOMING_AGG_PRN).lastInsertRowid
  );
  const prnDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '250 mg', 'anytime', 'any', 0)`
      )
      .run(prnId).lastInsertRowid
  );
  for (const backMs of [7_200_000, 3_600_000]) {
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status)
       VALUES (?, ?, ?, ?, 'taken')`
    ).run(
      prnDoseId,
      prnId,
      aggDay,
      utcSqlString(new Date(clockNow().getTime() - backMs))
    );
  }

  seedMemberLogin(E2E_LOGIN_UPCOMING_AGG, aggId, "write");
  console.log(
    `e2e: seeded Upcoming aggregation fixture — ${E2E_LOGIN_UPCOMING_AGG} granted ${UPCOMING_AGG_PROFILE} (${aggId}) (#1504)`
  );
}
