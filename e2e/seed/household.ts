// e2e seed fixtures — household domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { now as clockNow } from "../../lib/clock";
import {
  createFixtureProfile,
  createFixtureProfileWithId,
} from "../fixture-profile";
import {
  E2E_LOGIN_HH_ROUND,
  HH_ROUND_CAREGIVER_PROFILE,
  HH_ROUND_WARD_PROFILE,
  HH_ROUND_SHADOW_PROFILE,
  E2E_LOGIN_MULTI,
  MULTI_OWNER_PROFILE,
  MULTI_SHARED_PROFILE,
  MULTI_OWNER_DOSE,
  MULTI_SHARED_DOSE,
  E2E_LOGIN_MVMEDS,
  MVMEDS_SELF_PROFILE,
  MVMEDS_RO_PROFILE,
  MVMEDS_SELF_MED,
  MVMEDS_RO_MED,
  E2E_LOGIN_MVBIO,
  MVBIO_SELF_PROFILE,
  MVBIO_RO_PROFILE,
  MVBIO_SHARED_ANALYTE,
  MVBIO_SELF_ANALYTE,
  MVBIO_RO_ANALYTE,
  MULTI_OWNER_CONDITION,
  MULTI_SHARED_CONDITION,
  MULTI_OWNER_ALLERGY,
  MULTI_SHARED_ALLERGY,
  MULTI_OWNER_GOAL,
  MULTI_SHARED_GOAL,
  MULTI_ACTIVITY_DATE,
  MULTI_OWNER_ACTIVITY_A,
  MULTI_OWNER_ACTIVITY_B,
  MULTI_SHARED_ACTIVITY,
  E2E_LOGIN_TL_MULTI,
  TL_EAST_PROFILE,
  TL_WEST_PROFILE,
  TL_EAST_ACTIVITY,
  TL_WEST_ACTIVITY,
  TL_EAST_TZ,
  TL_WEST_TZ,
  MULTI_OWNER_VISIT,
  MULTI_SHARED_VISIT,
  MULTI_OWNER_VACCINE,
  MULTI_SHARED_VACCINE,
  E2E_LOGIN_OWN,
  OWN_SELF_PROFILE,
  OWN_OTHER_PROFILE,
  OWN_SELF_DOSE,
  OWN_OTHER_DOSE,
  E2E_LOGIN_TOASTS,
  TOAST_SWITCH_A_PROFILE,
  TOAST_SWITCH_B_PROFILE,
  E2E_LOGIN_GRANTEDIT,
  GRANT_EDIT_PROFILE,
  DUP_ACCESS_PROFILE,
  INVITE_TARGET_PROFILE,
  E2E_LOGIN_SETUP_HEALTH,
  SETUP_HEALTH_OK_PROFILE,
  SETUP_HEALTH_GAP_PROFILE,
  SETUP_HEALTH_QUIET_PROFILE,
  SETUP_HEALTH_GAP_MED,
} from "../fixture-logins";
import { seedMemberLogin, fixtureProfileId, grantProfile } from "./common";
import {
  completeOnboardingState,
  initialOnboardingState,
} from "../../lib/onboarding";
import { setOnboardingState } from "../../lib/settings";

// ── Household rollup, profile-switch toaster, family calendar ──
export function seedHouseholdRollup(): void {
  // ── Household rollup fixtures (issue #31) ─────────────────────────────────────
  // A SECOND profile so the Household cross-profile view has more than one card and
  // the caregiver-grant flows can be exercised (a login granted 2 profiles sees the
  // overview; a single-grant login does not). The profile carries exactly one due-
  // today supplement dose, unlogged, so it surfaces as an "Attention today" item a
  // caregiver can confirm from the household card WITHOUT switching to it. Fully
  // synthetic — no real PHI. Idempotent: the DB is reset per run, but guard anyway.
  const HOUSEHOLD_PROFILE_ID = 2;
  const HOUSEHOLD_PROFILE_NAME = "Sam Rivers"; // obviously-fictional
  const HOUSEHOLD_SUPP_NAME = "Household Vitamin D";

  if (
    !db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(HOUSEHOLD_PROFILE_ID)
  ) {
    createFixtureProfileWithId(
      db,
      HOUSEHOLD_PROFILE_ID,
      HOUSEHOLD_PROFILE_NAME
    );
  }

  if (
    !db
      .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
      .get(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_SUPP_NAME)
  ) {
    const supp = db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, condition, obligation, active, source)
         VALUES (?, ?, 'daily', 'should', 1, 'manual')`
      )
      .run(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_SUPP_NAME);
    // One daily dose, no taken-log for today → surfaces as a due dose on the card.
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '2000 IU', '08:00', 'any', 0)`
    ).run(Number(supp.lastInsertRowid));
  }

  // A SECOND due dose dedicated to the read-only-member spec. The write-member
  // spec CONFIRMS the Vitamin D dose above, so a later test asserting a still-due
  // row needs its own item — sharing one fixture made the read-only test order-
  // dependent (it failed whenever the confirm test ran first).
  const HOUSEHOLD_RO_SUPP_NAME = "Household Magnesium";
  if (
    !db
      .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
      .get(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_RO_SUPP_NAME)
  ) {
    const roSupp = db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, condition, obligation, active, source)
         VALUES (?, ?, 'daily', 'should', 1, 'manual')`
      )
      .run(HOUSEHOLD_PROFILE_ID, HOUSEHOLD_RO_SUPP_NAME);
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '200 mg', '20:00', 'any', 0)`
    ).run(Number(roSupp.lastInsertRowid));
  }

  console.log(
    `e2e: seeded household profile ${HOUSEHOLD_PROFILE_ID} (${HOUSEHOLD_PROFILE_NAME}) with two due-today supplement doses`
  );

  // ── Profile-switch toaster fixtures (issue #296) ──────────────────────────────
  // The ExtractionToaster/ImportJobsToaster poll the ACTIVE profile's document/job
  // history and toast terminal transitions, seeding silently on the first poll.
  // Before #296 a profile switch didn't reset that seed, so the new profile's whole
  // terminal history ghost-toasted as "just finished". To prove the fix, the second
  // profile (id 2, "Sam Rivers") needs its own pre-existing TERMINAL rows: switching
  // to it must produce ZERO toasts (the fix reseeds silently). Synthetic filenames/
  // content only — no real PHI. Idempotent: clear prior fixtures first.
  db.prepare(
    `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN ('e2e-p2-labs.pdf', 'e2e-p2-broken.txt')`
  ).run(HOUSEHOLD_PROFILE_ID);
  db.prepare(
    `DELETE FROM import_jobs WHERE profile_id = ? AND summary = 'e2e-p2: 3 readings'`
  ).run(HOUSEHOLD_PROFILE_ID);
  db.prepare(
    `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
      extraction_status, extracted_count, uploaded_at)
   VALUES (?, 'e2e-p2-labs.pdf', '', 'application/pdf', 4096, 'Lab report',
           'done', 9, '2026-07-07 09:00:00')`
  ).run(HOUSEHOLD_PROFILE_ID);
  db.prepare(
    `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes,
      extraction_status, extraction_error, uploaded_at)
   VALUES (?, 'e2e-p2-broken.txt', '', 'text/plain', 12,
           'failed', 'Unsupported file type.', '2026-07-07 08:30:00')`
  ).run(HOUSEHOLD_PROFILE_ID);
  db.prepare(
    `INSERT INTO import_jobs
     (profile_id, type, status, summary, created_at, updated_at)
   VALUES (?, 'biomarkers', 'ready', 'e2e-p2: 3 readings',
           '2026-07-07 08:00:00', '2026-07-07 08:00:00')`
  ).run(HOUSEHOLD_PROFILE_ID);

  console.log(
    `e2e: seeded profile ${HOUSEHOLD_PROFILE_ID} terminal document/job history for the profile-switch toaster spec (#296)`
  );

  // ── Consolidated "family" calendar fixtures ───────────────────────────────────
  // A SECOND profile with its own upcoming appointment so the family-calendar feed +
  // preview have two profiles' data to merge. The e2e login is the bootstrap admin,
  // who can access every profile without an explicit grant. Synthetic name/provider
  // only — no real PHI. Idempotent: reuse the profile if a prior run created it, and
  // clear its fixture appointment before re-inserting.
  const CHILD_NAME = "Test Child";
  let childId = (
    db.prepare("SELECT id FROM profiles WHERE name = ?").get(CHILD_NAME) as
      { id: number } | undefined
  )?.id;
  if (!childId) {
    childId = createFixtureProfile(db, CHILD_NAME);
  }
  // A clearly-future date so the appointment always lands in the feed's forward window.
  // Anchored on the clock seam (#990) so it stays future relative to the app's frozen
  // "today" under e2e, not the real wall clock.
  const soon = clockNow();
  soon.setDate(soon.getDate() + 5);
  const soonDate = soon.toISOString().slice(0, 10);
  db.prepare(
    "DELETE FROM appointments WHERE profile_id = ? AND title = 'Pediatric checkup'"
  ).run(childId);
  db.prepare(
    `INSERT INTO appointments (profile_id, date, time_of_day, title, location, status)
   VALUES (?, ?, '10:00', 'Pediatric checkup', 'Springfield Pediatrics', 'scheduled')`
  ).run(childId, soonDate);

  console.log(
    `e2e: seeded a second profile (${CHILD_NAME}, id=${childId}) with an upcoming appointment for the family-calendar feed`
  );
}

// ── Profile-switch toaster spec isolation ──
export function seedToasterIsolation(): void {
  // ── Profile-switch toaster spec isolation (#296 / PR #1110 shard-3 cascade) ────
  // The profile-switch-toasts spec switches the ACTIVE PROFILE mid-test. Run on the
  // shared admin storageState, a mid-switch failure on a degraded runner stranded the
  // shared session on its fixture profile, and every LATER spec in that worker saw the
  // wrong (empty) profile's data — 17 downstream specs failed as data-gated app shells
  // (PR #1110 run 29829296858 shard 3). The fix moves the spec into its OWN cookie
  // context with its OWN member login, so its switching can never touch the shared
  // session. This dedicated member is granted TWO profiles, each carrying its own
  // pre-existing TERMINAL document/import-job history — a done doc (→ "Extraction
  // complete"), a failed doc (→ "Extraction unsuccessful"), and a ready import job
  // (→ the "Extracted <summary>…" toast) — so switching between them exercises the
  // silent-reseed on BOTH profiles. Seeded FIRST here so profile A sorts to the lower
  // id (the login's default active profile on sign-in). Synthetic filenames/content
  // only — no real PHI. Idempotent: clear this fixture's rows by name/summary first.
  {
    const seedToasterHistory = (profileId: number, tag: string) => {
      db.prepare(
        `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN (?, ?)`
      ).run(profileId, `${tag}-labs.pdf`, `${tag}-broken.txt`);
      db.prepare(
        `DELETE FROM import_jobs WHERE profile_id = ? AND summary = ?`
      ).run(profileId, `${tag}: readings`);
      // A successfully-extracted document → the ExtractionToaster success toast.
      db.prepare(
        `INSERT INTO medical_documents
         (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
          extraction_status, extracted_count, uploaded_at)
       VALUES (?, ?, '', 'application/pdf', 4096, 'Lab report',
               'done', 6, '2026-07-06 09:00:00')`
      ).run(profileId, `${tag}-labs.pdf`);
      // A rejected upload in a terminal 'failed' state → the error toast.
      db.prepare(
        `INSERT INTO medical_documents
         (profile_id, filename, stored_path, mime_type, size_bytes,
          extraction_status, extraction_error, uploaded_at)
       VALUES (?, ?, '', 'text/plain', 12,
               'failed', 'Unsupported file type.', '2026-07-06 08:30:00')`
      ).run(profileId, `${tag}-broken.txt`);
      // A ready import job → the ImportJobsToaster "Extracted <summary>…" toast.
      db.prepare(
        `INSERT INTO import_jobs
         (profile_id, type, status, summary, created_at, updated_at)
       VALUES (?, 'biomarkers', 'ready', ?, '2026-07-06 08:00:00', '2026-07-06 08:00:00')`
      ).run(profileId, `${tag}: readings`);
    };

    const toastAId = fixtureProfileId(TOAST_SWITCH_A_PROFILE);
    const toastBId = fixtureProfileId(TOAST_SWITCH_B_PROFILE);
    seedToasterHistory(toastAId, "e2e-toastA");
    seedToasterHistory(toastBId, "e2e-toastB");
    seedMemberLogin(E2E_LOGIN_TOASTS, toastAId, "read");
    seedMemberLogin(E2E_LOGIN_TOASTS, toastBId, "read");
    console.log(
      `e2e: seeded profile-switch toaster fixture — login ${E2E_LOGIN_TOASTS} → profiles ${toastAId} (${TOAST_SWITCH_A_PROFILE}) + ${toastBId} (${TOAST_SWITCH_B_PROFILE}) #296`
    );
  }
}

// ── Multi-profile viewing, multi-view boards, own-profile affordances ──
export function seedMultiProfile(): void {
  // ── Multi-profile viewing fixtures (issue #1096) ──────────────────────────────
  // A dedicated member (E2E_LOGIN_MULTI) granted TWO dedicated profiles, both WRITE,
  // each with one due-today supplement dose. The multi-view spec toggles the second
  // profile into the view-set on /upcoming and confirms a CROSS-PROFILE dose — an
  // isolated fixture so that persistent write never races the shared household specs.
  {
    const multiOwnerId = fixtureProfileId(MULTI_OWNER_PROFILE);
    const multiSharedId = fixtureProfileId(MULTI_SHARED_PROFILE);
    const seedMultiDose = (profileId: number, name: string): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?"
          )
          .get(profileId, name)
      ) {
        const supp = db
          .prepare(
            `INSERT INTO intake_items
             (profile_id, name, condition, obligation, active, source)
         VALUES (?, ?, 'daily', 'should', 1, 'manual')`
          )
          .run(profileId, name);
        // One daily dose, no taken-log for today → surfaces as a due dose on Upcoming.
        db.prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1000 IU', '08:00', 'any', 0)`
        ).run(Number(supp.lastInsertRowid));
      }
    };
    seedMultiDose(multiOwnerId, MULTI_OWNER_DOSE);
    seedMultiDose(multiSharedId, MULTI_SHARED_DOSE);
    // Tier-1 multi-view record-list fixtures (#1328): a condition, allergy, and health
    // goal per profile so the /records + /results record lists render one row per profile.
    const seedMultiRecords = (profileId: number, tag: string): void => {
      if (
        !db
          .prepare("SELECT 1 FROM conditions WHERE profile_id = ? AND name = ?")
          .get(profileId, tag)
      ) {
        db.prepare(
          "INSERT INTO conditions (profile_id, name, status, source) VALUES (?, ?, 'active', NULL)"
        ).run(profileId, tag);
      }
    };
    const seedMultiAllergy = (profileId: number, substance: string): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM allergies WHERE profile_id = ? AND substance = ?"
          )
          .get(profileId, substance)
      ) {
        db.prepare(
          "INSERT INTO allergies (profile_id, substance, status, source) VALUES (?, ?, 'active', NULL)"
        ).run(profileId, substance);
      }
    };
    const seedMultiGoal = (profileId: number, description: string): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM care_goals WHERE profile_id = ? AND description = ?"
          )
          .get(profileId, description)
      ) {
        db.prepare(
          "INSERT INTO care_goals (profile_id, description, source) VALUES (?, ?, NULL)"
        ).run(profileId, description);
      }
    };
    seedMultiRecords(multiOwnerId, MULTI_OWNER_CONDITION);
    seedMultiRecords(multiSharedId, MULTI_SHARED_CONDITION);
    seedMultiAllergy(multiOwnerId, MULTI_OWNER_ALLERGY);
    seedMultiAllergy(multiSharedId, MULTI_SHARED_ALLERGY);
    seedMultiGoal(multiOwnerId, MULTI_OWNER_GOAL);
    seedMultiGoal(multiSharedId, MULTI_SHARED_GOAL);
    // Multi-view Training Journal (#1330): manual cardio activities so /training's Log
    // feed renders a merged, subject-stamped card feed. Idempotent per (profile, title).
    const seedMultiActivity = (profileId: number, title: string): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM activities WHERE profile_id = ? AND date = ? AND title = ?"
          )
          .get(profileId, MULTI_ACTIVITY_DATE, title)
      ) {
        db.prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'cardio', ?, 30)`
        ).run(profileId, MULTI_ACTIVITY_DATE, title);
      }
    };
    // Owner: two same-day rows (a same-profile merge candidate for each other).
    seedMultiActivity(multiOwnerId, MULTI_OWNER_ACTIVITY_A);
    seedMultiActivity(multiOwnerId, MULTI_OWNER_ACTIVITY_B);
    // Shared: one same-day row — a cross-profile card (subject chip), never an owner
    // card's merge sibling.
    seedMultiActivity(multiSharedId, MULTI_SHARED_ACTIVITY);
    // Tier-1b bespoke-list multi-view fixtures (#1359): a past visit (encounter) + a
    // recorded immunization dose per profile, so the Visits "Past" list and the
    // Immunizations "All recorded doses" list each render one row per profile.
    const seedMultiVisit = (profileId: number, type: string): void => {
      if (
        !db
          .prepare("SELECT 1 FROM encounters WHERE profile_id = ? AND type = ?")
          .get(profileId, type)
      ) {
        db.prepare(
          "INSERT INTO encounters (profile_id, date, type, source) VALUES (?, '2026-02-15', ?, NULL)"
        ).run(profileId, type);
      }
    };
    const seedMultiVaccine = (profileId: number, vaccine: string): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM immunizations WHERE profile_id = ? AND vaccine = ?"
          )
          .get(profileId, vaccine)
      ) {
        db.prepare(
          "INSERT INTO immunizations (profile_id, date, vaccine, source) VALUES (?, '2026-01-20', ?, NULL)"
        ).run(profileId, vaccine);
      }
    };
    seedMultiVisit(multiOwnerId, MULTI_OWNER_VISIT);
    seedMultiVisit(multiSharedId, MULTI_SHARED_VISIT);
    seedMultiVaccine(multiOwnerId, MULTI_OWNER_VACCINE);
    seedMultiVaccine(multiSharedId, MULTI_SHARED_VACCINE);
    const multiLoginId = seedMemberLogin(
      E2E_LOGIN_MULTI,
      multiOwnerId,
      "write"
    );
    grantProfile(multiLoginId, multiSharedId, "write");
    console.log(
      `e2e: seeded multi-view fixture — ${E2E_LOGIN_MULTI} granted ${MULTI_OWNER_PROFILE} (${multiOwnerId}) + ${MULTI_SHARED_PROFILE} (${multiSharedId})`
    );
  }

  // ── Multi-view Medications regimen boards (issue #1373 Part 1) ─────────────────
  // E2E_LOGIN_MVMEDS: a base profile (WRITE, acting) + a second profile READ-ONLY, each
  // with one due-today SCHEDULED medication (kind='medication', a daily dose, no taken
  // log) so both boards render Today content and both feed the leading strip. The self
  // profile is created FIRST so it holds the lower id → the login lands acting as it.
  {
    const mvSelfId = fixtureProfileId(MVMEDS_SELF_PROFILE);
    const mvRoId = fixtureProfileId(MVMEDS_RO_PROFILE);
    const seedBoardMed = (profileId: number, name: string): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?"
          )
          .get(profileId, name)
      ) {
        const med = db
          .prepare(
            `INSERT INTO intake_items
             (profile_id, name, kind, condition, obligation, active, source)
         VALUES (?, ?, 'medication', 'daily', 'should', 1, 'manual')`
          )
          .run(profileId, name);
        db.prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tablet', '08:00', 'any', 0)`
        ).run(Number(med.lastInsertRowid));
      }
    };
    seedBoardMed(mvSelfId, MVMEDS_SELF_MED);
    seedBoardMed(mvRoId, MVMEDS_RO_MED);
    const mvLoginId = seedMemberLogin(E2E_LOGIN_MVMEDS, mvSelfId, "write");
    grantProfile(mvLoginId, mvRoId, "read");
    console.log(
      `e2e: seeded medications-board fixture — ${E2E_LOGIN_MVMEDS} granted ${MVMEDS_SELF_PROFILE} (${mvSelfId}, write) + ${MVMEDS_RO_PROFILE} (${mvRoId}, read)`
    );
  }

  // ── Multi-view Biomarkers (Results) table (issue #1331) ───────────────────────
  // E2E_LOGIN_MVBIO: a base profile (WRITE, acting) + a second profile READ-ONLY. Both
  // carry the SHARED "Vitamin D" analyte family with DIFFERENT values/dates (so the
  // merged table proves per-member is_latest never crosses), plus one uniquely-named
  // analyte each so the spec can assert each member's data merged in. The self profile
  // is created FIRST so it holds the lower id → the login lands acting as it.
  {
    const bioSelfId = fixtureProfileId(MVBIO_SELF_PROFILE);
    const bioRoId = fixtureProfileId(MVBIO_RO_PROFILE);
    const seedBioReading = (
      profileId: number,
      canonical: string,
      date: string,
      value: number,
      unit: string
    ): void => {
      db.prepare(
        `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ? AND date = ?`
      ).run(profileId, canonical, date);
      db.prepare(
        `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'manual')`
      ).run(profileId, date, canonical, String(value), value, unit, canonical);
    };
    // Shared family: self's newest is 2024-06 (55), the read-only member's is 2024-03
    // (42) — each member's own newest must flag is_latest independently.
    seedBioReading(bioSelfId, MVBIO_SHARED_ANALYTE, "2024-01-01", 30, "ng/mL");
    seedBioReading(bioSelfId, MVBIO_SHARED_ANALYTE, "2024-06-01", 55, "ng/mL");
    seedBioReading(bioRoId, MVBIO_SHARED_ANALYTE, "2024-03-01", 42, "ng/mL");
    // A uniquely-named analyte per member so the spec can prove both members' rows merge.
    seedBioReading(bioSelfId, MVBIO_SELF_ANALYTE, "2024-05-01", 120, "ng/mL");
    seedBioReading(bioRoId, MVBIO_RO_ANALYTE, "2024-05-01", 95, "mg/dL");
    // The read-only member's unique analyte came from a DOCUMENT (#2316). Provenance
    // navigation is not a write, so its row must keep a ⋯ menu holding "View source
    // document" even though the grant is read-only — the regression the source link's
    // move into that menu could most easily introduce, since the menu used to render
    // only for a writable row (#1331). Synthetic filename, no PHI, and idempotent.
    db.prepare(
      `DELETE FROM medical_documents WHERE profile_id = ? AND filename = 'e2e-mvbio-ro-labs.pdf'`
    ).run(bioRoId);
    const bioRoDocId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
              extraction_status, extracted_count, uploaded_at)
           VALUES (?, 'e2e-mvbio-ro-labs.pdf', '', 'application/pdf', 2048,
                   'Lab report', 'done', 1, '2024-05-01 09:00:00')`
        )
        .run(bioRoId).lastInsertRowid
    );
    // `document_id` only, and `source` back to NULL: on medical_records the FK IS
    // the provenance link (the `source = 'document:<id>'` string encoding is for the
    // clinical tables that have no such column), and sourceDocumentId prefers it.
    db.prepare(
      `UPDATE medical_records SET document_id = ?, source = NULL
         WHERE profile_id = ? AND canonical_name = ?`
    ).run(bioRoDocId, bioRoId, MVBIO_RO_ANALYTE);
    const bioLoginId = seedMemberLogin(E2E_LOGIN_MVBIO, bioSelfId, "write");
    grantProfile(bioLoginId, bioRoId, "read");
    console.log(
      `e2e: seeded biomarkers-table fixture — ${E2E_LOGIN_MVBIO} granted ${MVBIO_SELF_PROFILE} (${bioSelfId}, write) + ${MVBIO_RO_PROFILE} (${bioRoId}, read)`
    );
  }

  // ── Multi-view Timeline: divergent-timezone day boundary (issue #1329) ─────────
  // A dedicated member (E2E_LOGIN_TL_MULTI) granted TWO adult profiles WRITE, each with a
  // per-profile timezone ~25h apart, so the SAME frozen instant is a DIFFERENT local
  // calendar date for each. Each profile carries ONE activity dated on ITS OWN today
  // (computed in its zone from the SAME clock the app freezes), so the merged multi-view
  // Timeline renders two separate "Today" day-groups with honest per-member divergence
  // badges. The timeline spec toggles WEST into the view-set and asserts both members'
  // today-badges + the subject chip on the non-acting row; single view stays unchanged.
  {
    const eastId = fixtureProfileId(TL_EAST_PROFILE);
    const westId = fixtureProfileId(TL_WEST_PROFILE);
    const setTz = db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    );
    setTz.run(eastId, TL_EAST_TZ);
    setTz.run(westId, TL_WEST_TZ);
    // The frozen instant the app uses (ALLOS_TEST_NOW when set, else real now), so the
    // seeded activity date == the app's today(profileId) at request time.
    const seedNow = process.env.ALLOS_TEST_NOW
      ? new Date(process.env.ALLOS_TEST_NOW)
      : new Date();
    const todayIn = (tz: string): string =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(seedNow);
    const seedTlActivity = (
      profileId: number,
      tz: string,
      title: string
    ): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM activities WHERE profile_id = ? AND title = ?"
          )
          .get(profileId, title)
      ) {
        db.prepare(
          `INSERT INTO activities (profile_id, date, type, title)
         VALUES (?, ?, 'cardio', ?)`
        ).run(profileId, todayIn(tz), title);
      }
    };
    seedTlActivity(eastId, TL_EAST_TZ, TL_EAST_ACTIVITY);
    seedTlActivity(westId, TL_WEST_TZ, TL_WEST_ACTIVITY);
    const tlLoginId = seedMemberLogin(E2E_LOGIN_TL_MULTI, eastId, "write");
    grantProfile(tlLoginId, westId, "write");
    console.log(
      `e2e: seeded timeline divergent-tz fixture — ${E2E_LOGIN_TL_MULTI} granted ${TL_EAST_PROFILE} (${eastId}, ${todayIn(TL_EAST_TZ)}) + ${TL_WEST_PROFILE} (${westId}, ${todayIn(TL_WEST_TZ)})`
    );
  }

  // ── Own-profile / not-self write affordances fixture (issue #1013) ────────────
  // A dedicated member (E2E_LOGIN_OWN) granted TWO adult profiles WRITE, with its
  // own-profile pointing at the FIRST (SELF). Each carries a due-today dose (household
  // dose-confirm buttons) + one weigh-in (the dashboard weight widget renders). The
  // spec asserts the not-self naming on the OTHER profile (never the login's own).
  {
    const ownSelfId = fixtureProfileId(OWN_SELF_PROFILE);
    const ownOtherId = fixtureProfileId(OWN_OTHER_PROFILE);
    const seedOwnDose = (profileId: number, name: string): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?"
          )
          .get(profileId, name)
      ) {
        const supp = db
          .prepare(
            `INSERT INTO intake_items
             (profile_id, name, condition, obligation, active, source)
         VALUES (?, ?, 'daily', 'should', 1, 'manual')`
          )
          .run(profileId, name);
        db.prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1000 IU', '08:00', 'any', 0)`
        ).run(Number(supp.lastInsertRowid));
      }
    };
    const seedOwnWeigh = (profileId: number): void => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM body_metrics WHERE profile_id = ? AND notes = 'e2e:own-seed'"
          )
          .get(profileId)
      ) {
        db.prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
         VALUES (?, date('now'), 72.0, 'e2e:own-seed')`
        ).run(profileId);
      }
    };
    seedOwnDose(ownSelfId, OWN_SELF_DOSE);
    seedOwnDose(ownOtherId, OWN_OTHER_DOSE);
    seedOwnWeigh(ownSelfId);
    seedOwnWeigh(ownOtherId);
    const ownLoginId = seedMemberLogin(E2E_LOGIN_OWN, ownSelfId, "write");
    grantProfile(ownLoginId, ownOtherId, "write");
    // Declare SELF as the login's own-profile (#1013): the association, not a grant.
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      ownSelfId,
      ownLoginId
    );
    console.log(
      `e2e: seeded own-profile fixture — ${E2E_LOGIN_OWN} own=${OWN_SELF_PROFILE} (${ownSelfId}), other=${OWN_OTHER_PROFILE} (${ownOtherId})`
    );
  }
}

// Ensure EXACTLY `count` profiles share this name — the one fixture shape
// fixtureProfileId can't express (it upserts by name, so it can only ever produce
// one). Deliberate duplicates back the #1434/#534 disambiguation assertions: two
// identically-named profiles must not render as identical grant rows. Idempotent for
// a reused dev server: it tops the population up, never past `count`. Returns the ids
// in id order (the order the disambiguation ordinals follow).
function duplicateFixtureProfileIds(name: string, count: number): number[] {
  const ids = (
    db
      .prepare("SELECT id FROM profiles WHERE name = ? ORDER BY id")
      .all(name) as { id: number }[]
  ).map((r) => r.id);
  while (ids.length < count) ids.push(createFixtureProfile(db, name));
  return ids.slice(0, count);
}

// ── Grant-matrix collapse fixture ──
export function seedGrantMatrix(): void {
  // ── #1412 grant-matrix collapse fixture ──────────────────────────────────────
  // A dedicated member login granted ONE dedicated profile (write). The family-grants
  // spec (e2e/family-grants.spec.ts) opens Settings → Family as admin, drives this
  // login's collapsed grant-summary row + Edit disclosure, and flips its grant level —
  // isolated so it never perturbs another spec's grant set. Idempotent for a reused dev
  // server (fixtureProfileId + seedMemberLogin both upsert).
  {
    const grantEditId = fixtureProfileId(GRANT_EDIT_PROFILE);
    seedMemberLogin(E2E_LOGIN_GRANTEDIT, grantEditId, "write");
    console.log(
      `e2e: seeded grant-edit fixture — login ${E2E_LOGIN_GRANTEDIT} granted profile ${grantEditId} (${GRANT_EDIT_PROFILE}) (#1412)`
    );
  }

  // ── #1434 invite-hardening fixtures ─────────────────────────────────────────
  // PROFILES WITHOUT LOGINS (the #1392 lesson): the specs need profiles to grant and
  // to disambiguate, not more identities in every login's grant matrix. The duplicate
  // pair is the point — same name, two people — and the invite target is what the
  // emailed-invite journey grants its new member at create time.
  {
    const dupIds = duplicateFixtureProfileIds(DUP_ACCESS_PROFILE, 2);
    const inviteTargetId = fixtureProfileId(INVITE_TARGET_PROFILE);
    console.log(
      `e2e: seeded invite-hardening fixtures — duplicate profiles ${dupIds.join(", ")} (${DUP_ACCESS_PROFILE}), invite target ${inviteTargetId} (${INVITE_TARGET_PROFILE}) (#1434)`
    );
  }
}

// ── Telegram household dose round ──
export function seedTelegramDoseRound(): void {
  // ── Telegram household dose round fixture (issue #1459) ───────────────────────
  // A caregiver login whose OWN profile is the receiver, plus one WRITE-granted member
  // (offerable) and one READ-only member (never offerable). The caregiver profile is
  // created FIRST so it holds the lowest id and is the acting profile on login. The
  // ward carries a due-today dose so a real round has something to be about. Synthetic
  // only, idempotent for a reused server.
  {
    const hhCaregiverId = fixtureProfileId(HH_ROUND_CAREGIVER_PROFILE);
    const hhWardId = fixtureProfileId(HH_ROUND_WARD_PROFILE);
    const hhShadowId = fixtureProfileId(HH_ROUND_SHADOW_PROFILE);

    if (
      !db
        .prepare(
          "SELECT 1 FROM intake_items WHERE profile_id = ? AND name = 'HH Round Vitamin D (e2e)'"
        )
        .get(hhWardId)
    ) {
      const item = db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'HH Round Vitamin D (e2e)', 1, 'supplement', 'daily', 'should')`
        )
        .run(hhWardId);
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '2000 IU', '08:00', 'any', 0)`
      ).run(Number(item.lastInsertRowid));
    }

    const hhLoginId = seedMemberLogin(
      E2E_LOGIN_HH_ROUND,
      hhCaregiverId,
      "write"
    );
    grantProfile(hhLoginId, hhWardId, "write");
    grantProfile(hhLoginId, hhShadowId, "read");
    // The own-profile association (#1013) — what makes this login a ROUND RECEIVER.
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      hhCaregiverId,
      hhLoginId
    );
    console.log(
      `e2e: seeded household-round fixture — ${E2E_LOGIN_HH_ROUND} own=${HH_ROUND_CAREGIVER_PROFILE} (${hhCaregiverId}), write=${HH_ROUND_WARD_PROFILE} (${hhWardId}), read=${HH_ROUND_SHADOW_PROFILE} (${hhShadowId}) (#1459)`
    );
  }
}

// ── Member setup health on the Household board (issue #2173) ──
export function seedHouseholdSetup(): void {
  // Three SPEC-OWNED profiles plus their own caregiver login. The setup row is a
  // derived verdict over a whole profile's configuration, so it owns its data outright
  // (#2353): nothing else in the suite writes these profiles, so no neighbour's dose,
  // onboarding row or channel can flip a card. Synthetic only; idempotent for a reused
  // dev server.
  const okId = fixtureProfileId(SETUP_HEALTH_OK_PROFILE);
  const gapId = fixtureProfileId(SETUP_HEALTH_GAP_PROFILE);
  const quietId = fixtureProfileId(SETUP_HEALTH_QUIET_PROFILE);

  // OK + GAP have been through onboarding; QUIET deliberately has NO onboarding_state
  // row, which is the state that has always rendered identically to "complete".
  for (const id of [okId, gapId]) {
    setOnboardingState(id, {
      ...completeOnboardingState(initialOnboardingState(), "2026-01-01"),
      // Dismissed so the fixture's dashboards stay quiet — this spec is about the
      // household board, not the post-onboarding checklist.
      checklistDismissed: true,
    });
  }

  // The one channel that routes with NO managing login: a profile-scoped Home Assistant
  // webhook. It is what makes OK healthy while GAP (same dosed item, no channel) is not.
  for (const [key, value] of [
    ["ha_notify_enabled", "1"],
    ["ha_notify_webhook_url", "https://ha.invalid/api/webhook/e2e-setup-ok"],
  ] as const) {
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(okId, key, value);
  }

  const addItem = (
    profileId: number,
    name: string,
    kind: "supplement" | "medication",
    active: 0 | 1,
    dosed: boolean
  ): void => {
    if (
      db
        .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
        .get(profileId, name)
    )
      return;
    const item = db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, ?, ?, 'daily', 'should')`
      )
      .run(profileId, name, active, kind);
    if (dosed) {
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 cap', '08:00', 'any', 0)`
      ).run(Number(item.lastInsertRowid));
    }
  };

  // A dosed, active, non-`may` item on both OK and GAP: the send source that makes
  // "would this profile send something?" true at all.
  addItem(okId, "Setup OK Vitamin D (e2e)", "supplement", 1, true);
  addItem(gapId, "Setup Gap Vitamin D (e2e)", "supplement", 1, true);
  // GAP's second line: active, scheduled-shaped, and with no dose row, so it can never
  // be due. A medication, so its CTA deep-links the item's own edit form.
  addItem(gapId, SETUP_HEALTH_GAP_MED, "medication", 1, false);
  // QUIET's whole roster is inactive. Supplements only: the shared onboarding presence
  // reader counts ANY medication row as a first value, which would take this profile out
  // of the never-onboarded check's "thin presence" gate.
  addItem(quietId, "Setup Quiet Multivitamin (e2e)", "supplement", 0, false);
  addItem(quietId, "Setup Quiet Fluoride (e2e)", "supplement", 0, false);

  const loginId = seedMemberLogin(E2E_LOGIN_SETUP_HEALTH, okId, "write");
  grantProfile(loginId, gapId, "write");
  grantProfile(loginId, quietId, "write");
  console.log(
    `e2e: seeded member setup-health fixture — ${E2E_LOGIN_SETUP_HEALTH} ok=${okId}, gap=${gapId}, quiet=${quietId} (#2173)`
  );
}
