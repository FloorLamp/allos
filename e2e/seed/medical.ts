// e2e seed fixtures — medical domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { db, today } from "../../lib/db";
import { shiftDateStr } from "../../lib/date";
import { reconcileFlags } from "../../lib/queries";
import {
  E2E_LOGIN_RECS_ENRICH,
  RECS_ENRICH_PROFILE,
  RECS_ENRICH_ALLERGY_MED,
  RECS_ENRICH_PGX_MED,
  RECS_ENRICH_PROCEDURE,
  E2E_LOGIN_FLABS,
  FLAGGED_LAB_PROFILE,
  E2E_LOGIN_IOP,
  FLAGGED_IOP_PROFILE,
  E2E_LOGIN_PREVCODE,
  PREVENTIVE_CODES_PROFILE,
  E2E_LOGIN_DQ_GAPPY,
  DQ_GAPPY_PROFILE,
  E2E_LOGIN_DQ_COMPLETE,
  DQ_COMPLETE_PROFILE,
  E2E_LOGIN_DQ_CARE,
  DQ_CARE_PARENT_PROFILE,
  DQ_CARE_CHILD_PROFILE,
  E2E_LOGIN_DQ_ADULT,
  DQ_ADULT_PROFILE,
  E2E_LOGIN_VISITLINKS,
  VISITLINKS_PROFILE,
  E2E_LOGIN_ENCRICH,
  ENCRICH_PROFILE,
  E2E_LOGIN_CREATEVISIT,
  CREATEVISIT_PROFILE,
  E2E_LOGIN_PANELGROUPS,
  PANEL_GROUPS_PROFILE,
  PANEL_GROUPS_OTHER_ANALYTE,
} from "../fixture-logins";
import {
  PROFILE_ID,
  seedMemberLogin,
  fixtureProfileId,
  grantProfile,
} from "./common";
import { BROWSER_DOC_ID } from "./imports";

// ── Medical/passport UI-audit fixtures ──
export function seedPassportSmalls(): void {
  // ---- Medical/passport UI-audit fixtures (#381, #383, #384) ----
  // All idempotent (delete-then-insert on unique e2e identifiers) and fully
  // synthetic. Layered on profile 1 for the medical-smalls specs.

  // #381 — a STARRED genomics biomarker whose only reading is ~2 years old. The
  // canonical name has no canonical_biomarkers row, so before the fix the pinned
  // tile judged staleness on the (null) canonical category and mislabelled a
  // genotype "stale"; after the fix it judges on the RECORD's 'genomics' category
  // (never stale). The starred-biomarker-stale spec asserts the tile shows no
  // "stale" note.
  const APOE_MARKER = "E2E APOE Genotype";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, APOE_MARKER);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, source)
   VALUES (?, '2023-05-01', 'genomics', ?, 'e3/e4', ?, 'manual')`
  ).run(PROFILE_ID, APOE_MARKER, APOE_MARKER);
  db.prepare(
    `DELETE FROM saved_items WHERE profile_id = ? AND kind = 'biomarker' AND key = ?`
  ).run(PROFILE_ID, APOE_MARKER);
  db.prepare(
    `INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)`
  ).run(PROFILE_ID, APOE_MARKER);

  // #516 — a positive durable-immunity antibody titer whose only reading is ~2 years
  // old. On the flat 365-day retest clock it would nag "retest overdue" and render
  // "These results are stale", which is clinically wrong for a documented positive
  // immunity result (durable evidence, like genomics). The durable-immunity spec asserts
  // the detail page shows no "stale" note. Unique synthetic name so the assertion is
  // deterministic and it can't collide with the seed's own titers.
  const IMMUNITY_MARKER = "E2E Varicella IgG";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, IMMUNITY_MARKER);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, notes, source)
   VALUES (?, '2023-05-01', 'lab', ?, 'Immune', ?, 'Immune', 'manual')`
  ).run(PROFILE_ID, IMMUNITY_MARKER, IMMUNITY_MARKER);

  // #544/#549 — a POSITIVE durable-immunity titer the extractor stamped "abnormal".
  // The qualitative classifier reroutes the flag reconcile to present it as a neutral
  // "Immune" status (never a red "Abnormal" attention flag) and cross-link to the
  // immunization surface. Synthetic name that matches isDurableImmunityTiter.
  const IMMUNE_FLAG_MARKER = "E2E Hepatitis B Surface Antibody";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, IMMUNE_FLAG_MARKER);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, notes, flag, source)
   VALUES (?, '2023-05-01', 'lab', ?, 'Positive', ?, 'Immune', 'abnormal', 'manual')`
  ).run(PROFILE_ID, IMMUNE_FLAG_MARKER, IMMUNE_FLAG_MARKER);

  // #548 — an IMMUTABLE identity attribute (blood type) the extractor stamped
  // "abnormal", dated ~2 years old. The classifier makes it neutral (never abnormal)
  // and exempt from the retest-stale clock, the way genomics + durable immunity are.
  const BLOOD_TYPE_MARKER = "E2E ABO Blood Group";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, BLOOD_TYPE_MARKER);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, flag, source)
   VALUES (?, '2023-05-01', 'lab', ?, 'A POSITIVE', ?, 'abnormal', 'manual')`
  ).run(PROFILE_ID, BLOOD_TYPE_MARKER, BLOOD_TYPE_MARKER);

  // #542 — a titer series whose values carry an embedded unit ("58 mIU/mL") and a
  // dilution ratio ("1:160"), both with value_num NULL. parseLeadingNumeric recovers
  // the leading numeric at the chart boundary so these plot instead of vanishing.
  const EMBEDDED_UNIT_MARKER = "E2E Rubella IgG Titer";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, EMBEDDED_UNIT_MARKER);
  const embeddedInsert = db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, source)
   VALUES (?, ?, 'lab', ?, ?, ?, 'manual')`
  );
  embeddedInsert.run(
    PROFILE_ID,
    "2024-02-01",
    EMBEDDED_UNIT_MARKER,
    "1:40",
    EMBEDDED_UNIT_MARKER
  );
  embeddedInsert.run(
    PROFILE_ID,
    "2025-02-01",
    EMBEDDED_UNIT_MARKER,
    "58 mIU/mL",
    EMBEDDED_UNIT_MARKER
  );

  // #543 — a purely qualitative series (no numeric anywhere) renders as a dated
  // timeline instead of a blank numeric chart.
  const QUALITATIVE_MARKER = "E2E Mumps IgG Screen";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, QUALITATIVE_MARKER);
  const qualInsert = db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, source)
   VALUES (?, ?, 'lab', ?, ?, ?, 'manual')`
  );
  qualInsert.run(
    PROFILE_ID,
    "2023-03-01",
    QUALITATIVE_MARKER,
    "Negative",
    QUALITATIVE_MARKER
  );
  qualInsert.run(
    PROFILE_ID,
    "2025-03-01",
    QUALITATIVE_MARKER,
    "Reactive",
    QUALITATIVE_MARKER
  );

  // #698 §4 — visual acuity is a Snellen fraction ("20/20"): qualitative-shaped, so it
  // must render as a dated timeline (not a flat numeric chart), and it must NOT flag as
  // abnormal (no numeric reference band). Two dated readings, value_num NULL, canonical
  // "Visual Acuity, Right Eye". parseLeadingNumeric now rejects the bare fraction, so
  // plottableReadingValue is null → the dated-timeline branch; reconcileFlags leaves it
  // unflagged (an unrecognized qualitative analyte defers).
  const ACUITY_MARKER = "Visual Acuity, Right Eye";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, ACUITY_MARKER);
  qualInsert.run(
    PROFILE_ID,
    "2024-04-01",
    ACUITY_MARKER,
    "20/40",
    ACUITY_MARKER
  );
  qualInsert.run(
    PROFILE_ID,
    "2025-04-01",
    ACUITY_MARKER,
    "20/20",
    ACUITY_MARKER
  );

  // Reconcile so the extractor's blunt "abnormal" flags are corrected before the
  // specs read the page (the app's own boot reconcile is signature-gated and the seed
  // already stamped the current signature, so it would skip these post-seed inserts).
  reconcileFlags(PROFILE_ID);

  // A recent qualitative lab with a valid directionless provider flag. The compact
  // dashboard must say "Abnormal" explicitly: unlike high/low, this status cannot
  // communicate its meaning with a directional caret. Inserted after reconciliation
  // because this fixture models the provider-authored flag before a later canonical
  // mapping is available.
  const DIRECTIONLESS_LAB_MARKER = "E2E Directionless Lab Status";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, DIRECTIONLESS_LAB_MARKER);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, canonical_name, flag, source)
   VALUES (?, ?, 'lab', ?, 'Detected', ?, 'abnormal', 'manual')`
  ).run(
    PROFILE_ID,
    shiftDateStr(today(PROFILE_ID), -1),
    DIRECTIONLESS_LAB_MARKER,
    DIRECTIONLESS_LAB_MARKER
  );

  // #383 — a lab whose raw name ("...CHOLESTEROL, TOTAL") differs from its
  // displayed canonical heading ("...Total Cholesterol"), so the biomarker search
  // must match the canonical name a user actually sees.
  const CHOL_RAW = "E2E CHOLESTEROL, TOTAL";
  const CHOL_CANONICAL = "E2E Total Cholesterol";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, CHOL_CANONICAL);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
   VALUES (?, '2026-06-20', 'lab', ?, '185', 185, 'mg/dL', ?, 'manual')`
  ).run(PROFILE_ID, CHOL_RAW, CHOL_CANONICAL);

  // #384 — two overlapping documents' twin of the same allergy (a unique synthetic
  // substance so the assertion is deterministic): one manual, one imported from the
  // e2e browser document. The "Recorded allergies" manager must collapse them to a
  // single row, like its clinical-list siblings.
  const RAGWEED = "E2E Ragweed";
  db.prepare(
    `DELETE FROM allergies WHERE profile_id = ? AND substance = ?`
  ).run(PROFILE_ID, RAGWEED);
  db.prepare(
    `INSERT INTO allergies (profile_id, substance, reaction, status, document_id)
   VALUES (?, ?, 'Sneezing', 'active', NULL)`
  ).run(PROFILE_ID, RAGWEED);
  db.prepare(
    `INSERT INTO allergies (profile_id, substance, reaction, status, document_id)
   VALUES (?, ?, 'Sneezing', 'active', ?)`
  ).run(PROFILE_ID, RAGWEED, BROWSER_DOC_ID);

  // Passport-safety fixture (#1405): ONE allergy carrying criticality, a REFUTED
  // verification status, and TWO graded manifestations — the three facts the old
  // single-`reaction` shape could not hold. Refuted is the load-bearing case: the row
  // stays on the management list but must drop out of the merged known-allergies view
  // (and therefore the emergency card / drug screen). Idempotent: clear first, and the
  // child rows cascade with the parent.
  const SAFETY_ALLERGEN = "E2E Refuted Allergen";
  db.prepare(
    `DELETE FROM allergies WHERE profile_id = ? AND substance = ?`
  ).run(PROFILE_ID, SAFETY_ALLERGEN);
  const safetyAllergyId = Number(
    db
      .prepare(
        `INSERT INTO allergies
           (profile_id, substance, reaction, severity, status, criticality,
            verification_status, document_id)
         VALUES (?, ?, 'Hives', 'moderate', 'active', 'high', 'refuted', NULL)`
      )
      .run(PROFILE_ID, SAFETY_ALLERGEN).lastInsertRowid
  );
  const insReaction = db.prepare(
    `INSERT INTO allergy_reactions (allergy_id, manifestation, severity, position)
     VALUES (?, ?, ?, ?)`
  );
  insReaction.run(safetyAllergyId, "Hives", "moderate", 0);
  insReaction.run(safetyAllergyId, "Anaphylaxis", "severe", 1);

  console.log(
    `e2e: seeded medical-smalls fixtures on profile ${PROFILE_ID} (#381 starred genomics, #383 canonical search, #384 allergy twins)`
  );
}

// ── Duplicate-immunization delete-confirm ──
export function seedDuplicateImmunization(): void {
  // ── Duplicate-immunization delete-confirm fixture (issue #534) ────────────────
  // Two yellow-fever doses on the SAME date for profile 1, so the immunizations
  // delete confirm — keyed on "vaccine + date" — would read identically for both
  // without the distinguishing dose label the #534 fix folds in. Yellow fever is a
  // travel/record-only vaccine (never due/overdue), so this can't perturb any CDC
  // schedule-status assertion. Distinct dose labels give the confirm something to
  // disambiguate on. Idempotent: clear the marked rows first.
  db.prepare(
    `DELETE FROM immunizations WHERE profile_id = ? AND notes = 'e2e:dup-immz'`
  ).run(PROFILE_ID);
  // Dose A also carries the #1406 administration attributes (lot / route / site /
  // adverse reaction) so the history table's "Lot / route / site" column has a row to
  // render. The lot number is a deliberately LOW-ENTROPY fictional string — a
  // random-looking hex value would read like a real manufacturer lot to the PHI scan.
  const insDupImmz = db.prepare(
    `INSERT INTO immunizations
       (profile_id, date, vaccine, dose_label, notes, source, lot_number, route, site, reaction)
   VALUES (?, '2024-05-01', 'yellow_fever', ?, 'e2e:dup-immz', NULL, ?, ?, ?, ?)`
  );
  insDupImmz.run(
    PROFILE_ID,
    "Travel dose A",
    "lot-test-batch-42",
    "subcutaneous",
    "Left deltoid",
    "Sore arm for two days"
  );
  insDupImmz.run(PROFILE_ID, "Travel dose B", null, null, null, null);
  console.log(
    `e2e: seeded two same-date yellow-fever immunizations on profile ${PROFILE_ID} (delete-confirm disambiguation, #534)`
  );
}

// ── Flagged-labs + flagged-IOP follow-ups ──
export function seedFlaggedFollowups(): void {
  // ── Flagged-labs follow-up fixture (#700 flagged-labs adapter) ────────────────
  // A dedicated adult profile (no birthdate) carrying ONE flagged biomarker: an
  // out-of-range Hemoglobin A1c dated ~120 days ago. The followup-labs spec tracks a
  // 3-month "Recheck A1c" follow-up from the biomarker detail page (so its planned date
  // lands in the past → OVERDUE → surfaces on Upcoming immediately), asserts the legible
  // item, then adds a later same-family (eAG) reading and resolves the loop. Idempotent:
  // delete-then-insert the A1c source on (profile, canonical); the spec owns + cleans the
  // follow-up care_plan_items + the later eAG reading in beforeAll/afterAll.
  const flaggedLabId = fixtureProfileId(FLAGGED_LAB_PROFILE);
  const flaggedLabAnchor = today(flaggedLabId);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Hemoglobin A1c'`
  ).run(flaggedLabId);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
   VALUES (?, ?, 'lab', 'Hemoglobin A1c', '8.2', 8.2, '%', 'Hemoglobin A1c', 'high', 'manual')`
  ).run(flaggedLabId, shiftDateStr(flaggedLabAnchor, -120));
  seedMemberLogin(E2E_LOGIN_FLABS, flaggedLabId, "write");
  console.log(
    `e2e: seeded flagged-lab follow-up fixture — profile ${flaggedLabId} (${FLAGGED_LAB_PROFILE}) (#700)`
  );

  // ── Flagged-IOP glaucoma follow-up fixture (#698 §6 IOP adapter) ──────────────
  // A dedicated adult profile carrying ONE flagged intraocular-pressure reading: an
  // out-of-range right-eye IOP (28 mmHg, ref 10–21) dated ~120 days ago. The followup-iop
  // spec tracks a 3-month "Recheck IOP / glaucoma workup" from the biomarker detail page
  // (planned date lands in the past → OVERDUE → surfaces on Upcoming immediately), asserts
  // the legible item, then adds a later LEFT-eye pressure and resolves the loop (bilateral).
  // Idempotent: delete-then-insert the source IOP on (profile, canonical); the spec owns +
  // cleans the follow-up care_plan_items + the later reading in beforeAll/afterAll.
  const flaggedIopId = fixtureProfileId(FLAGGED_IOP_PROFILE);
  const flaggedIopAnchor = today(flaggedIopId);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Intraocular Pressure, Right Eye'`
  ).run(flaggedIopId);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, source)
   VALUES (?, ?, 'vitals', 'Intraocular Pressure, Right Eye', '28', 28, 'mmHg', 'Intraocular Pressure, Right Eye', 'high', 'manual')`
  ).run(flaggedIopId, shiftDateStr(flaggedIopAnchor, -120));
  seedMemberLogin(E2E_LOGIN_IOP, flaggedIopId, "write");
  console.log(
    `e2e: seeded flagged-IOP follow-up fixture — profile ${flaggedIopId} (${FLAGGED_IOP_PROFILE}) (#698)`
  );
}

// ── Coded preventive satisfaction ──
export function seedPreventiveSatisfaction(): void {
  // ── Coded preventive satisfaction (#1035/#1037) ───────────────────────────────
  // A dedicated adult profile whose adult_physical and dental_cleaning rules are
  // satisfied ONLY through stored codes: a generic "Office Visit" encounter carrying
  // CPT 99396 (established preventive visit, 40-64) and a completed generic "Prophy"
  // dental row carrying CDT D1110. No name synonym can match either, so the spec's
  // absence assertions prove the code path end-to-end. vision_exam stays DUE (no
  // evidence), anchoring the rendered list. Idempotent: rows are cleared first.
  const prevCodeId = fixtureProfileId(PREVENTIVE_CODES_PROFILE);
  {
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
    ).run(prevCodeId);
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1980-02-01')`
    ).run(prevCodeId);
    const pToday = today(prevCodeId);
    db.prepare(`DELETE FROM encounters WHERE profile_id = ?`).run(prevCodeId);
    db.prepare(`DELETE FROM dental_procedures WHERE profile_id = ?`).run(
      prevCodeId
    );
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, code, code_system, class_code)
       VALUES (?, ?, 'Office Visit', '99396', 'CPT', 'AMB')`
    ).run(prevCodeId, shiftDateStr(pToday, -30));
    db.prepare(
      `INSERT INTO dental_procedures (profile_id, name, status, cdt_code, procedure_date)
       VALUES (?, 'Prophy', 'completed', 'D1110', ?)`
    ).run(prevCodeId, shiftDateStr(pToday, -30));
  }
  seedMemberLogin(E2E_LOGIN_PREVCODE, prevCodeId, "write");
  console.log(
    `e2e: seeded coded preventive-satisfaction fixture — profile ${prevCodeId} (${PREVENTIVE_CODES_PROFILE}) (#1035/#1037)`
  );
}

// ── Structural data-quality gaps ──
export function seedDataQualityGaps(): void {
  // ── Structural data-quality gaps (#1045) ─────────────────────────────────────
  // Idempotent helpers to force a profile's structural fields to a known state on a
  // reused dev server (the profile_settings + medical_documents are re-seeded cleanly).
  function clearProfileAttrs(profileId: number): void {
    db.prepare(
      `DELETE FROM profile_settings WHERE profile_id = ?
       AND key IN ('sex','birthdate','age','reproductive_status','smoking_status',
                   'smoking_pack_years','smoking_quit_year','smoking_source',
                   'risk_attributes_reviewed')`
    ).run(profileId);
  }
  function setAttr(profileId: number, key: string, value: string): void {
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(profileId, key, value);
  }

  // (A) A GAPPY sole profile: no birthdate, no sex, one failed-extraction document, and a
  // name-only active medication → the dashboard "Data quality" widget shows birthdate,
  // sex, RxCUI, and failed-doc gaps (leverage-ranked). The dismiss test resets its own
  // data-quality dismissals first (below), so its write never sticks across repeats.
  const dqGappyId = fixtureProfileId(DQ_GAPPY_PROFILE);
  clearProfileAttrs(dqGappyId);
  db.prepare(
    `DELETE FROM medical_documents WHERE profile_id = ? AND filename = 'dq-broken.txt'`
  ).run(dqGappyId);
  db.prepare(
    `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes,
      extraction_status, extraction_error, uploaded_at)
   VALUES (?, 'dq-broken.txt', '', 'text/plain', 12,
           'failed', 'Unsupported file type.', '2026-01-01 00:00:00')`
  ).run(dqGappyId);
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name = 'DQ Mystery Pill'`
  ).run(dqGappyId);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, as_needed)
   VALUES (?, 'DQ Mystery Pill', 1, 'medication', 1)`
  ).run(dqGappyId);
  seedMemberLogin(E2E_LOGIN_DQ_GAPPY, dqGappyId, "write");

  // (B) A COMPLETE sole profile: birthdate (adult) + sex + smoking status + reviewed risk
  // factors, and no meds/labs/failed-docs → the "Data quality" widget self-hides.
  const dqCompleteId = fixtureProfileId(DQ_COMPLETE_PROFILE);
  clearProfileAttrs(dqCompleteId);
  setAttr(dqCompleteId, "sex", "male");
  setAttr(dqCompleteId, "birthdate", "1985-01-01");
  setAttr(dqCompleteId, "smoking_status", "never");
  setAttr(dqCompleteId, "smoking_source", "manual");
  setAttr(dqCompleteId, "risk_attributes_reviewed", "1");
  seedMemberLogin(E2E_LOGIN_DQ_COMPLETE, dqCompleteId, "write");

  // (C) A caregiver with a COMPLETE own profile + a GAPPY child → the household page
  // shows a per-member data-quality gaps line on the child's card only.
  const dqParentId = fixtureProfileId(DQ_CARE_PARENT_PROFILE);
  clearProfileAttrs(dqParentId);
  setAttr(dqParentId, "sex", "female");
  setAttr(dqParentId, "birthdate", "1988-06-01");
  setAttr(dqParentId, "smoking_status", "never");
  setAttr(dqParentId, "smoking_source", "manual");
  setAttr(dqParentId, "risk_attributes_reviewed", "1");
  const dqChildId = fixtureProfileId(DQ_CARE_CHILD_PROFILE);
  clearProfileAttrs(dqChildId); // no birthdate/sex → birthdate + sex gaps
  const dqCareLogin = seedMemberLogin(E2E_LOGIN_DQ_CARE, dqParentId, "write");
  grantProfile(dqCareLogin, dqChildId, "write");
  console.log(
    `e2e: seeded data-quality fixtures — gappy ${dqGappyId}, complete ${dqCompleteId}, ` +
      `care parent ${dqParentId} + child ${dqChildId} (#1045)`
  );

  // (D) A structurally-GAPPY ADULT (#1146/#1219): birthdate + sex set (male, adult) so
  // the ADULT-gated gaps fire — smoking status unknown, risk factors unreviewed, and a
  // PARTIAL PhenoAge panel (one Albumin lab → first missing analyte is Creatinine) —
  // and its CTAs must deep-link the exact forms. The same profile hosts the
  // dashboard-deeplinks #1219 fixtures: a target-less goal (bare title row → goals
  // link) and FOUR ongoing protocols + a layout that shows the active-protocols widget
  // (cap 3 → "+1 more" overflow link). Idempotent; synthetic values only.
  {
    const dqAdultId = fixtureProfileId(DQ_ADULT_PROFILE);
    clearProfileAttrs(dqAdultId);
    setAttr(dqAdultId, "sex", "male");
    setAttr(dqAdultId, "birthdate", "1984-04-01");
    db.prepare(
      `DELETE FROM medical_records WHERE profile_id = ? AND name = 'Albumin'`
    ).run(dqAdultId);
    db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
     VALUES (?, '2026-01-15', 'lab', 'Albumin', '4.5', 4.5, 'g/dL', 'Albumin', 'manual')`
    ).run(dqAdultId);

    // #1219 item 3 — a goal with NO measurable target (no exercise/metric/body-metric
    // and no target_value): the dashboard row renders no bar, so its title must link.
    db.prepare(
      `DELETE FROM goals WHERE profile_id = ? AND title = 'Feel better all around'`
    ).run(dqAdultId);
    db.prepare(
      `INSERT INTO goals (profile_id, title, status) VALUES (?, 'Feel better all around', 'active')`
    ).run(dqAdultId);

    // #1219 item 4 — four ONGOING protocols (end_date null) + a stored dashboard
    // layout that shows the off-by-default active-protocols widget, so the widget
    // caps at 3 and renders the "+1 more" overflow link. Distinct start dates pin
    // the shown/overflow split (getProtocols orders by start_date DESC).
    db.prepare(
      `DELETE FROM protocols WHERE profile_id = ? AND name LIKE 'DQ Protocol %'`
    ).run(dqAdultId);
    const insDqProtocol = db.prepare(
      `INSERT INTO protocols (profile_id, name, start_date, outcome_keys)
     VALUES (?, ?, ?, '[]')`
    );
    const dqAdultToday = today(dqAdultId);
    for (let i = 1; i <= 4; i++) {
      insDqProtocol.run(
        dqAdultId,
        `DQ Protocol ${i}`,
        shiftDateStr(dqAdultToday, -(10 + i))
      );
    }
    setAttr(
      dqAdultId,
      "dashboard_layout",
      JSON.stringify({ order: ["active-protocols"], hidden: [] })
    );

    seedMemberLogin(E2E_LOGIN_DQ_ADULT, dqAdultId, "write");
    console.log(
      `e2e: seeded data-quality ADULT fixture — profile ${dqAdultId} (${DQ_ADULT_PROFILE}) (#1146/#1219)`
    );
  }
}

// ── Record/episode <-> visit linking, encounter enrichment, create-visit offer ──
export function seedVisitLinking(): void {
  // ── Record ↔ visit / episode ↔ visit linking fixture (#1050/#1053) ──────────────
  // A self-contained profile: one visit, a same-day UNLINKED medication (with a
  // course started that day so the tier-2 engine dates it), and
  // an illness episode spanning that day with NO linked visit. The spec drives the
  // "From this visit?" batch link, the med "Prescribed at" line, and the cockpit Care
  // suggestion → link → encounter back-link. OWNS every row (dedicated profile), so the
  // suite's shared-seed counts are untouched.
  {
    const vlProfileId = fixtureProfileId(VISITLINKS_PROFILE);
    const VL_DATE = "2026-05-12";
    // A visit on VL_DATE with an attending provider (also seeds the provider row).
    // providers carries a NOT NULL UNIQUE dedup_key, so seed it explicitly.
    db.prepare(
      `INSERT OR IGNORE INTO providers (name, type, dedup_key)
     VALUES ('Dr. Vera Vasquez (e2e)', 'individual', 'e2e:vera-vasquez')`
    ).run();
    const vlProviderId = (
      db
        .prepare(
          "SELECT id FROM providers WHERE dedup_key = 'e2e:vera-vasquez'"
        )
        .get() as { id: number }
    ).id;
    // Idempotent: only seed the visit + med + episode once per profile.
    const existingVisit = db
      .prepare(
        "SELECT id FROM encounters WHERE profile_id = ? AND date = ? AND type = 'Office Visit'"
      )
      .get(vlProfileId, VL_DATE) as { id: number } | undefined;
    if (!existingVisit) {
      db.prepare(
        `INSERT INTO encounters (profile_id, date, type, class_code, reason, provider_id)
       VALUES (?, ?, 'Office Visit', 'AMB', 'Sinus infection', ?)`
      ).run(vlProfileId, VL_DATE, vlProviderId);
      // An unlinked medication + a course dated VL_DATE, with the SAME provider so
      // the suggestion reads STRONG. (The med IS the tier-2 candidate — #1178
      // removed the paired medical_records 'prescription' row / 'record' domain.)
      const vlMedId = Number(
        db
          .prepare(
            `INSERT INTO intake_items (profile_id, name, kind, provider_id)
           VALUES (?, 'Amoxicillin (e2e)', 'medication', ?)`
          )
          .run(vlProfileId, vlProviderId).lastInsertRowid
      );
      db.prepare(
        "INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)"
      ).run(vlMedId, VL_DATE);
      // An illness episode spanning VL_DATE, no linked visit yet.
      db.prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'sinus infection', '2026-05-10', '2026-05-15')`
      ).run(vlProfileId);
    }
    seedMemberLogin(E2E_LOGIN_VISITLINKS, vlProfileId, "write");
    console.log(
      `e2e: seeded visit-link fixture — profile ${vlProfileId} (${VISITLINKS_PROFILE}) #1050/#1053`
    );
  }

  // ── Encounter-detail enrichment (#1350/#1353) ─────────────────────────────────
  // A self-contained profile whose subject visit exercises every enrichment: a
  // same-provider prior visit (visit context), a completed appointment booked for it
  // (scheduling origin), an illness episode spanning the visit with NO link yet (the
  // encounter-side link suggestion → link → care trail), and a document-sourced + a
  // manual condition (RecordProvenance deep-link vs plain label). OWNS every row.
  {
    const enId = fixtureProfileId(ENCRICH_PROFILE);
    const EN_SUBJECT_DATE = "2026-06-18";
    db.prepare(
      `INSERT OR IGNORE INTO providers (name, type, dedup_key)
     VALUES ('Dr. Enid Enrich (e2e)', 'individual', 'e2e:enid-enrich')`
    ).run();
    const enProviderId = (
      db
        .prepare("SELECT id FROM providers WHERE dedup_key = 'e2e:enid-enrich'")
        .get() as { id: number }
    ).id;
    const existingSubject = db
      .prepare(
        "SELECT id FROM encounters WHERE profile_id = ? AND date = ? AND type = 'Office Visit'"
      )
      .get(enId, EN_SUBJECT_DATE) as { id: number } | undefined;
    if (!existingSubject) {
      // A same-provider prior visit earlier the same year → visit context reads
      // "2nd visit with Dr. Enid Enrich · last one Feb 2026" and "2nd … this year".
      db.prepare(
        `INSERT INTO encounters (profile_id, date, type, class_code, reason, provider_id)
       VALUES (?, '2026-02-10', 'Office Visit', 'AMB', 'Annual checkup', ?)`
      ).run(enId, enProviderId);
      const subjectId = Number(
        db
          .prepare(
            `INSERT INTO encounters (profile_id, date, type, class_code, reason, provider_id)
           VALUES (?, ?, 'Office Visit', 'AMB', 'Sinus congestion', ?)`
          )
          .run(enId, EN_SUBJECT_DATE, enProviderId).lastInsertRowid
      );
      // A completed appointment booked for the subject visit → scheduling origin.
      db.prepare(
        `INSERT INTO appointments (profile_id, scheduled_at, provider_id, status, encounter_id, title)
       VALUES (?, '2026-06-10 09:30:00', ?, 'completed', ?, 'Sick visit')`
      ).run(enId, enProviderId, subjectId);
      // An illness episode spanning the subject visit, NO linked visit yet → the
      // encounter-side "Link an illness episode?" suggestion.
      db.prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'sinus infection (e2e)', '2026-06-15', '2026-06-23')`
      ).run(enId);
      // A source document + a document-sourced condition and a manual condition →
      // RecordProvenance deep-link vs plain label (#1353).
      const docId = Number(
        db
          .prepare(
            `INSERT INTO medical_documents
             (profile_id, filename, stored_path, doc_type, extraction_status, extracted_count, document_date)
           VALUES (?, 'visit-summary-e2e.xml', '/dev/null', 'ccd', 'done', 1, ?)`
          )
          .run(enId, EN_SUBJECT_DATE).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO conditions (profile_id, name, status, source, document_id)
       VALUES (?, 'Acute sinusitis (e2e)', 'active', ?, ?)`
      ).run(enId, `document:${docId}`, docId);
      db.prepare(
        `INSERT INTO conditions (profile_id, name, status, source)
       VALUES (?, 'Seasonal allergies (e2e)', 'active', NULL)`
      ).run(enId);
    }
    seedMemberLogin(E2E_LOGIN_ENCRICH, enId, "write");
    console.log(
      `e2e: seeded encounter-enrichment fixture — profile ${enId} (${ENCRICH_PROFILE}) #1350/#1353`
    );
  }

  // ── "Create a visit from this record?" (#1099) ────────────────────────────────
  // A self-contained profile with ONE optical prescription dated a day that has NO
  // encounter — so the Vision record card shows the "Create a visit from this record?"
  // prompt. The spec accepts it and asserts the derived visit appears with the Rx in its
  // "From this visit" section. OWNS the profile (dedicated login), so the accept's writes
  // (a new encounter + the link) never touch shared-seed counts. Idempotent under
  // --repeat-each: seed once, and the spec only accepts when the prompt is still present.
  {
    const cvProfileId = fixtureProfileId(CREATEVISIT_PROFILE);
    const CV_DATE = "2026-05-20";
    db.prepare(
      `INSERT OR IGNORE INTO providers (name, type, dedup_key)
     VALUES ('Dr. Iris Optic (e2e)', 'individual', 'e2e:iris-optic')`
    ).run();
    const cvProviderId = (
      db
        .prepare("SELECT id FROM providers WHERE dedup_key = 'e2e:iris-optic'")
        .get() as { id: number }
    ).id;
    const existingRx = db
      .prepare(
        "SELECT id FROM optical_prescriptions WHERE profile_id = ? AND issued_date = ?"
      )
      .get(cvProfileId, CV_DATE) as { id: number } | undefined;
    if (!existingRx) {
      db.prepare(
        `INSERT INTO optical_prescriptions
         (profile_id, kind, od_sphere, os_sphere, issued_date, provider_id, brand)
       VALUES (?, 'glasses', -1.5, -1.75, ?, ?, 'Rx Slip (e2e)')`
      ).run(cvProfileId, CV_DATE, cvProviderId);
    }
    seedMemberLogin(E2E_LOGIN_CREATEVISIT, cvProfileId, "write");
    console.log(
      `e2e: seeded create-visit fixture — profile ${cvProfileId} (${CREATEVISIT_PROFILE}) #1099`
    );
  }
}

// ── Records-surface enrichment sweep ──
export function seedRecordsEnrichment(): void {
  // ── Records-surface enrichment sweep (issues #1354 + #1355) ───────────────────
  // A dedicated member login + ADULT profile carrying the exact fixtures the enrichment
  // lines read (own login/profile so no contraindication/PGx finding perturbs another
  // spec's medications/allergies counts):
  //   • #1354 allergy↔med: a Penicillin allergy + an active Amoxicillin med → a
  //     drug-allergy CLASS contraindication surfaces on the allergy row (deep-links to
  //     the med).
  //   • #1354 PGx↔med: a CYP2C19 poor-metabolizer variant + an active Clopidogrel med →
  //     a PGx hit surfaces on the variant row.
  //   • #1355 "Performed at": a procedure linked to an encounter (with a provider).
  {
    const reId = fixtureProfileId(RECS_ENRICH_PROFILE);
    const activeMed = (name: string): number =>
      Number(
        db
          .prepare(
            `INSERT INTO intake_items (profile_id, name, kind, active, as_needed, source)
           VALUES (?, ?, 'medication', 1, 0, 'manual')`
          )
          .run(reId, name).lastInsertRowid
      );
    if (
      !db
        .prepare(
          "SELECT 1 FROM allergies WHERE profile_id = ? AND substance = ?"
        )
        .get(reId, "Penicillin")
    ) {
      activeMed(RECS_ENRICH_ALLERGY_MED);
      activeMed(RECS_ENRICH_PGX_MED);
      db.prepare(
        `INSERT INTO allergies (profile_id, substance, reaction, status, source)
       VALUES (?, 'Penicillin', 'hives', 'active', 'manual')`
      ).run(reId);
      db.prepare(
        `INSERT INTO genomic_variants
         (profile_id, gene, star_allele, result_type, interpretation, source)
       VALUES (?, 'CYP2C19', '*2/*2', 'pharmacogenomic', 'Poor metabolizer', 'manual')`
      ).run(reId);
      const provId = Number(
        db
          .prepare(
            "INSERT INTO providers (name, type, dedup_key) VALUES ('Dr. Reyes (e2e)', 'individual', 'dk:e2e-recs-enrich-reyes')"
          )
          .run().lastInsertRowid
      );
      const encId = Number(
        db
          .prepare(
            `INSERT INTO encounters (profile_id, date, type, class_code, provider_id, source)
           VALUES (?, '2026-04-12', 'Orthopedic Surgery', 'AMB', ?, 'manual')`
          )
          .run(reId, provId).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO procedures (profile_id, name, date, encounter_id, source)
       VALUES (?, ?, '2026-04-12', ?, 'manual')`
      ).run(reId, RECS_ENRICH_PROCEDURE, encId);
    }
    seedMemberLogin(E2E_LOGIN_RECS_ENRICH, reId, "write");
    console.log(
      `e2e: seeded records-enrichment fixture — ${E2E_LOGIN_RECS_ENRICH} granted ${RECS_ENRICH_PROFILE} (${reId}) (#1354/#1355)`
    );
  }
}

// ── Results-hub panel groups (#1499 section A) ────────────────────────────────
// A dedicated adult profile whose WHOLE lab history is FOURTEEN readings across
// exactly three #1502 panels, so the group headers' published counts are exact and
// stable:
//
//   Lipids   · 5 analytes · 1 flagged   (LDL still high; the rest currently normal)
//   Thyroid  · 2 analytes               (no flag — the unflagged contrast)
//   Other    · 1 analyte                (un-canonicalized, sorts last, never dropped)
//
// Several analytes carry historical readings, for two reasons. First, the header
// counts ANALYTES while the expansion lists ROWS, and only a fixture where the two
// differ can pin that. Second, a Triglycerides high whose CURRENT reading is normal
// must NOT count toward "1 flagged" — that pins the header to the analyte's CURRENT
// state rather than to any reading ever.
//
// The row count is deliberately ABOVE lib/biomarker-panel-groups' AUTO_OPEN_ROW_LIMIT
// (a short list has nothing to index, so it arrives expanded) — this fixture has to
// arrive COLLAPSED for the default-state assertions to mean anything.
//
// HDL Cholesterol is DELIBERATELY absent. It is the input to two read-time derived
// indices (Non-HDL Cholesterol, Triglyceride/HDL Ratio), and a derived virtual row is
// a lipids analyte too — seeding HDL would silently move the count off 5 the day
// someone reads this fixture. Idempotent: every row is deleted by profile before
// insert, so a reused server re-seeds cleanly.
export function seedPanelGroups(): void {
  const pid = fixtureProfileId(PANEL_GROUPS_PROFILE);
  db.prepare(`DELETE FROM medical_records WHERE profile_id = ?`).run(pid);
  const anchor = today(pid);
  const add = (
    date: string,
    name: string,
    canonical: string | null,
    value: number,
    unit: string,
    flag: string | null,
    panel: string
  ) =>
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name, flag, panel, source)
         VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?, ?, 'manual')`
      )
      .run(pid, date, name, String(value), value, unit, canonical, flag, panel);

  const recent = shiftDateStr(anchor, -30);
  const older = shiftDateStr(anchor, -400);
  const oldest = shiftDateStr(anchor, -760);
  const LAB = "E2E Lab";

  // Lipids — five analytes; LDL is the group's one CURRENT flag.
  add(recent, "LDL Cholesterol", "LDL Cholesterol", 171, "mg/dL", "high", LAB);
  add(older, "LDL Cholesterol", "LDL Cholesterol", 168, "mg/dL", "high", LAB);
  add(oldest, "LDL Cholesterol", "LDL Cholesterol", 96, "mg/dL", null, LAB);
  add(
    recent,
    "Total Cholesterol",
    "Total Cholesterol",
    190,
    "mg/dL",
    null,
    LAB
  );
  add(older, "Total Cholesterol", "Total Cholesterol", 202, "mg/dL", null, LAB);
  add(
    oldest,
    "Total Cholesterol",
    "Total Cholesterol",
    186,
    "mg/dL",
    null,
    LAB
  );
  add(recent, "Triglycerides", "Triglycerides", 110, "mg/dL", null, LAB);
  add(older, "Triglycerides", "Triglycerides", 128, "mg/dL", null, LAB);
  // A historical high whose CURRENT reading is normal — must NOT count as flagged.
  add(oldest, "Triglycerides", "Triglycerides", 260, "mg/dL", "high", LAB);
  add(recent, "VLDL Cholesterol", "VLDL Cholesterol", 22, "mg/dL", null, LAB);
  add(recent, "Lipoprotein(a)", "Lipoprotein(a)", 18, "nmol/L", null, LAB);

  // Thyroid — two analytes, both normal, so a second group stays COLLAPSED while
  // Lipids is expanded (the per-group independence assertion).
  add(
    recent,
    "TSH",
    "Thyroid-Stimulating Hormone (TSH)",
    2.1,
    "uIU/mL",
    null,
    LAB
  );
  add(recent, "Free T4", "Free T4", 1.3, "ng/dL", null, LAB);

  // Un-canonicalized — the reserved `other` bucket, never dropped, always last.
  add(
    recent,
    PANEL_GROUPS_OTHER_ANALYTE,
    null,
    42,
    "U/L",
    null,
    "E2E Vendor Panel"
  );

  seedMemberLogin(E2E_LOGIN_PANELGROUPS, pid, "write");
  console.log(
    `e2e: seeded panel-groups fixture — ${E2E_LOGIN_PANELGROUPS} granted ${PANEL_GROUPS_PROFILE} (${pid}) (#1499)`
  );
}
