// e2e seed fixtures — illness domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { db, today } from "../../lib/db";
import { shiftDateStr } from "../../lib/date";
import { reconcileFlags } from "../../lib/queries";
import {
  E2E_LOGIN_SICK_SELF,
  SICK_SELF_PROFILE,
  E2E_LOGIN_SICK_COLLAPSE,
  SICK_COLLAPSE_PROFILE,
  E2E_LOGIN_SICK_PHOTO,
  SICK_PHOTO_PROFILE,
  E2E_LOGIN_SICK_VIDEO,
  SICK_VIDEO_PROFILE,
  E2E_LOGIN_SITCOACH,
  SITCOACH_PROFILE,
  E2E_LOGIN_ILLNESS_CARE,
  ILLNESS_CARE_PROFILE,
  E2E_LOGIN_CARE,
  CARE_PARENT_PROFILE,
  SICK_KID_A_PROFILE,
  SICK_KID_B_PROFILE,
  E2E_LOGIN_COCARE,
  COCARE_PARENT_PROFILE,
  E2E_LOGIN_HHHIST,
  E2E_LOGIN_HHHIST_RO,
  HH_HISTORY_PARENT_PROFILE,
  HH_HISTORY_CHILD_PROFILE,
  E2E_LOGIN_HH_CAREGIVER,
  E2E_LOGIN_HH_SOLO,
  E2E_LOGIN_HH_VIEWER,
  E2E_LOGIN_ILLNESS_CAREGIVER,
  E2E_LOGIN_ILLNESS_RO,
  E2E_LOGIN_VIEWONLY_READ,
  E2E_LOGIN_VIEWONLY_WRITE,
  E2E_LOGIN_CONDREV,
  CONDITION_REVIEW_PROFILE,
  E2E_LOGIN_REASON,
  REASON_MODEL_PROFILE,
  E2E_LOGIN_ASK,
  ASK_RECORDS_PROFILE,
  ASK_RECORDS_MED,
  E2E_LOGIN_CLOSURE_DQ,
  CLOSURE_DQ_PROFILE,
  E2E_LOGIN_NOTIF,
  NOTIF_PROFILE,
  E2E_LOGIN_PROTEIN,
  PROTEIN_QUICKADD_PROFILE,
} from "../fixture-logins";
import {
  seedMemberLogin,
  fixtureProfileId,
  grantProfile,
  rileyProfileId,
} from "./common";

// ── Illness hero, situation-aware coaching, caregiver + visit history ──
export function seedIllness(): void {
  // ── Illness hero fixtures (#858) ──────────────────────────────────────────────
  // Dedicated logins/profiles for the illness hero so its mutations (collapse state, a
  // cross-profile dose/temp) never touch the shared admin session (profile 1's live
  // episode) — repeat-safe under CI's --repeat-each=3. The DB is reset each webServer
  // boot, so these inserts don't accumulate across boots; the episode row is DELETE'd
  // first for a reused dev server.
  function seedSickEpisode(
    profileId: number,
    opts: { activateSituation?: boolean; prnMed?: boolean } = {}
  ): void {
    const on = today(profileId);
    const start = shiftDateStr(on, -2);
    const yesterday = shiftDateStr(on, -1);

    if (opts.activateSituation) {
      // The built-in illness-type situation, ACTIVE — so hasActiveIllnessSituation() keys
      // this profile's OWN full cockpit to the hero. Idempotent for a reused dev server.
      const existing = db
        .prepare(
          "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
        )
        .get(profileId) as { id: number } | undefined;
      const sitId =
        existing?.id ??
        Number(
          db
            .prepare(
              "INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)"
            )
            .run(profileId).lastInsertRowid
        );
      db.prepare(
        "UPDATE situations SET active = 1, illness_type = 1 WHERE id = ?"
      ).run(sitId);
    }

    // The open episode ROW (#856) — identity for the cockpit; membership stays derived.
    db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
      profileId
    );
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
    ).run(profileId, start);

    // Symptoms (worst-severity upsert like the runtime core) + a small fever curve.
    const seedSym = db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
    );
    seedSym.run(profileId, yesterday, "cough", 2);
    seedSym.run(profileId, on, "cough", 2);
    seedSym.run(profileId, on, "fever", 3);

    const tId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit,
            canonical_name, source, notes)
         VALUES (?, ?, 'vitals', 'Body Temperature', ?, ?, 'degF',
                 'Body Temperature', 'manual', ?)`
        )
        // An early clock time so a "now" reading a caregiver logs later in the day always
        // outranks it as the LATEST temp (the multi-sick cross-profile-temp spec asserts the
        // logged value shows in the accordion line).
        .run(profileId, on, "101.3", 101.3, "00:05").lastInsertRowid
    );
    reconcileFlags(profileId, [tId]);

    if (opts.prnMed) {
      // A PRN med with confirmed interval/max (so the cockpit redose line computes) but NO
      // prior administration — the co-caregiver dose the spec logs is the FIRST, so its
      // "last ibuprofen …" clause appears on the other caregiver's hero only after it.
      const has = db
        .prepare(
          "SELECT id FROM intake_items WHERE profile_id = ? AND name = 'Ibuprofen' AND obligation = 'may'"
        )
        .get(profileId) as { id: number } | undefined;
      if (!has) {
        const medId = Number(
          db
            .prepare(
              `INSERT INTO intake_items
               (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose, min_interval_hours, max_daily_count)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', 20, 1, 6, 4)`
            )
            .run(profileId).lastInsertRowid
        );
        // A PRN med needs a dose row — logAdministration resolves the loggable dose through
        // it (the item form guarantees one at runtime; the seed must mirror that).
        db.prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '400 mg', 'any', 'any', 0)`
        ).run(medId);
      }
    }
  }

  // Base (well) caregiver profiles FIRST so they carry the lowest ids among each
  // caregiver's grants — createSession picks accessibleProfiles[0] (lowest id) as the
  // active profile, so each caregiver lands acting as their OWN well profile (not a kid).
  const careParentId = fixtureProfileId(CARE_PARENT_PROFILE);
  const coCareParentId = fixtureProfileId(COCARE_PARENT_PROFILE);
  const sickKidAId = fixtureProfileId(SICK_KID_A_PROFILE);
  const sickKidBId = fixtureProfileId(SICK_KID_B_PROFILE);
  const sickSelfId = fixtureProfileId(SICK_SELF_PROFILE);
  const sickCollapseId = fixtureProfileId(SICK_COLLAPSE_PROFILE);

  seedSickEpisode(sickSelfId, { activateSituation: true });
  seedSickEpisode(sickCollapseId, { activateSituation: true });
  seedSickEpisode(sickKidAId, { prnMed: true });
  seedSickEpisode(sickKidBId, {});

  // SICK_SELF: sole (active) profile is sick → its own FULL cockpit at hero position.
  seedMemberLogin(E2E_LOGIN_SICK_SELF, sickSelfId);
  // SICK_COLLAPSE: a separate sick-solo login for the collapse-persistence test.
  seedMemberLogin(E2E_LOGIN_SICK_COLLAPSE, sickCollapseId);

  // SICK_PHOTO (#1093): a dedicated sick-solo login whose episode cockpit the
  // symptom-photo-link spec drives — attaching a photo TAGGED to a specific symptom log.
  // Isolated so its exact-count / delete-all photo assertions never race the shared
  // profile-1 episode. seedSickEpisode logs cough + fever today, so the photo strip's
  // symptom selector has options.
  const sickPhotoId = fixtureProfileId(SICK_PHOTO_PROFILE);
  seedSickEpisode(sickPhotoId, { activateSituation: true });
  seedMemberLogin(E2E_LOGIN_SICK_PHOTO, sickPhotoId);

  // ── Situation-aware coaching fixture (#837 / #662 item 1) ─────────────────────
  // A dedicated sick profile WITH training history + one situational supplement, so the
  // dashboard coaching widget shows the illness HELD note (coaching has gap nags to hold,
  // not the empty state) and the Nutrition → Supplements situations bar shows the
  // "1 situational item now active" activation acknowledgment. Read-only in the specs, so
  // it stays repeat-safe and never perturbs the other sick fixtures' cockpit assertions.
  const sitCoachId = fixtureProfileId(SITCOACH_PROFILE);
  seedSickEpisode(sitCoachId, { activateSituation: true });
  {
    const on = today(sitCoachId);
    // Training history a few days back → coaching HAS content to hold, with no session
    // logged today (so no "trained today" branch competes with the held note).
    const sid = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Squat Day', 45)`
        )
        .run(sitCoachId, shiftDateStr(on, -3)).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Back Squat', 1, 100, 5)`
    ).run(sid);
    // A situational supplement tied to the active Illness situation (situation_id points
    // at the profile's Illness row so isDueOn's situational branch counts it while active).
    const illnessSitId = (
      db
        .prepare(
          "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
        )
        .get(sitCoachId) as { id: number }
    ).id;
    const suppId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, situation, situation_id)
         VALUES (?, 'Zinc', 1, 'supplement', 'situational', 'should', 'Illness', ?)`
        )
        .run(sitCoachId, illnessSitId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tab', 'morning', 'any', 0)`
    ).run(suppId);
  }
  seedMemberLogin(E2E_LOGIN_SITCOACH, sitCoachId);

  // ILLNESS_CARE: a dedicated sick profile for the illness-care care finding (#805). Its
  // fever is logged on FOUR consecutive days (daysAgo 3→0), crossing the cited "more than
  // 3 days" line so the finding surfaces on Upcoming. Dedicated + read-only in
  // illness-care.spec — profile 1 carries the same fixture, but the illness lifecycle specs
  // mutate profile 1's illness state (end/reopen episode, dismiss the finding), and under
  // --repeat-each a sibling's mutation made the finding vanish for the reader. Mirrors the
  // scripts/seed.ts profile-1 shape: active Illness situation + open episode + 4-day fever.
  const illnessCareId = fixtureProfileId(ILLNESS_CARE_PROFILE);
  {
    const on = today(illnessCareId);
    const existingSit = db
      .prepare(
        "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
      )
      .get(illnessCareId) as { id: number } | undefined;
    const sitId =
      existingSit?.id ??
      Number(
        db
          .prepare(
            "INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)"
          )
          .run(illnessCareId).lastInsertRowid
      );
    db.prepare(
      "UPDATE situations SET active = 1, illness_type = 1 WHERE id = ?"
    ).run(sitId);
    db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
      illnessCareId
    );
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
    ).run(illnessCareId, shiftDateStr(on, -3));
    // Fever on all four consecutive days (daysAgo 3→0) → "more than 3 days" → the finding.
    const seedFever = db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, 'fever', ?, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
    );
    for (const [ago, severity] of [
      [3, 2],
      [2, 3],
      [1, 3],
      [0, 2],
    ] as const) {
      seedFever.run(illnessCareId, shiftDateStr(on, -ago), severity);
    }
  }
  seedMemberLogin(E2E_LOGIN_ILLNESS_CARE, illnessCareId);

  // CARE: acts as the well Care Parent, granted both sick kids → two accordion cockpits.
  const careLoginId = seedMemberLogin(E2E_LOGIN_CARE, careParentId);
  grantProfile(careLoginId, sickKidAId);
  grantProfile(careLoginId, sickKidBId);

  // COCARE: a second caregiver granted Kid A (shared with CARE) → the co-caregiver case.
  const coCareLoginId = seedMemberLogin(E2E_LOGIN_COCARE, coCareParentId);
  grantProfile(coCareLoginId, sickKidAId);

  console.log(
    `e2e: seeded illness-hero fixtures — sick self ${sickSelfId}, sick kids ${sickKidAId}/${sickKidBId}, caregivers ${careLoginId}/${coCareLoginId} (#858)`
  );

  // ── Household-rollup + illness-episode caregiver fixtures (#868 census hardening) ──
  // Five member logins granted the SHARED seeded profiles — profile 1 ("admin") + profile 2
  // ("Riley (child)", = rileyId) — so household-rollup / illness-episode stop creating
  // members at runtime through Settings → Family (a router.refresh() render path that went
  // stale under CI load — the create-member census flake). Grant sets are STATIC; the specs
  // never mutate them, and profile 1 (lowest id) is the caregiver's default active profile.
  const rileyId = rileyProfileId();
  if (rileyId) {
    // household-rollup: 1w+2w (confirm), 1w only (solo/redirect), 1r+2r (view-only).
    const hhCaregiverLoginId = seedMemberLogin(
      E2E_LOGIN_HH_CAREGIVER,
      1,
      "write"
    );
    grantProfile(hhCaregiverLoginId, rileyId, "write");
    seedMemberLogin(E2E_LOGIN_HH_SOLO, 1, "write");
    const hhViewerLoginId = seedMemberLogin(E2E_LOGIN_HH_VIEWER, 1, "read");
    grantProfile(hhViewerLoginId, rileyId, "read");
    // illness-episode: 1w+2w (cross-profile hero, #858), 1r+2w (view-only episode, #879).
    const illnessCaregiverLoginId = seedMemberLogin(
      E2E_LOGIN_ILLNESS_CAREGIVER,
      1,
      "write"
    );
    grantProfile(illnessCaregiverLoginId, rileyId, "write");
    const illnessRoLoginId = seedMemberLogin(E2E_LOGIN_ILLNESS_RO, 1, "read");
    grantProfile(illnessRoLoginId, rileyId, "write");
    console.log(
      "e2e: seeded household-rollup + illness-episode caregiver fixtures (#868)"
    );
  }

  // View-only access (#33): two dedicated logins granted ONLY profile 1, one per access
  // level, replacing view-only-access.spec's runtime Family-UI member creation (the
  // #830/#1111 census flake). Profile 1 is each login's sole grant → its active profile.
  seedMemberLogin(E2E_LOGIN_VIEWONLY_READ, 1, "read");
  seedMemberLogin(E2E_LOGIN_VIEWONLY_WRITE, 1, "write");

  // ── Household visit + illness history fixtures (#1009) ────────────────────────
  // A caregiver granted a well parent + a currently-sick child, each carrying PAST
  // visits + illness episodes, so /medical/episodes (the #1373 care trail) has real cross-profile content to
  // merge and tag by person. The child's CLOSED "Flu" overlaps the parent's Flu (the
  // episode-card present case); the child's OPEN "Cold" makes the household currently
  // sick (dashboard promotion); the parent's far-past "Chickenpox" overlaps nobody (the
  // card-absent case). Parent is created FIRST so it carries the lower id — the login's
  // active profile — so the caregiver acts as the well parent.
  {
    const hhParentId = fixtureProfileId(HH_HISTORY_PARENT_PROFILE);
    const hhChildId = fixtureProfileId(HH_HISTORY_CHILD_PROFILE);
    const on = today(hhParentId);

    // Idempotent for a reused dev server.
    for (const pid of [hhParentId, hhChildId]) {
      db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(pid);
      db.prepare(
        "DELETE FROM encounters WHERE profile_id = ? AND source = 'manual'"
      ).run(pid);
    }

    const addEpisode = (
      pid: number,
      situation: string,
      startedAt: string,
      endedAt: string | null
    ): number => {
      const r = db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, ?, ?, ?)`
        )
        .run(pid, situation, startedAt, endedAt);
      return Number(r.lastInsertRowid);
    };
    const addEncounter = (
      pid: number,
      date: string,
      type: string,
      providerId: number | null = null
    ): number => {
      const r = db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, provider_id, source)
       VALUES (?, ?, ?, ?, 'manual')`
        )
        .run(pid, date, type, providerId);
      return Number(r.lastInsertRowid);
    };

    // Parent: a past visit, a Flu that overlaps the child's, and a far-past Chickenpox.
    addEncounter(hhParentId, shiftDateStr(on, -40), "Annual physical");
    addEpisode(hhParentId, "Flu", shiftDateStr(on, -30), shiftDateStr(on, -25));
    addEpisode(
      hhParentId,
      "Chickenpox",
      shiftDateStr(on, -300),
      shiftDateStr(on, -295)
    );

    // Child: a routine (UNLINKED) past visit, a Flu overlapping the parent's, and an OPEN
    // Cold (sick now). The Cold carries the care-trail nesting fixtures (#1373 Part 2): a
    // LINKED urgent-care visit + a prescribed medication course whose prescriber matches
    // that visit's provider (the provable chain).
    addEncounter(hhChildId, shiftDateStr(on, -10), "Sick visit");
    addEpisode(hhChildId, "Flu", shiftDateStr(on, -28), shiftDateStr(on, -24));
    const coldId = addEpisode(hhChildId, "Cold", shiftDateStr(on, -2), null);

    // #1373 care-trail nesting fixture: an urgent-care visit (Dr. Ng) on Cold day 2, linked
    // to the Cold episode, plus an Amoxicillin course started the same day whose prescriber
    // provider is Dr. Ng — so the course reads "prescribed at the Day-2 urgent-care visit".
    const ngProviderId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key)
         VALUES ('Dr. Ng', 'individual', 'e2e-hhhist-ng')`
        )
        .run().lastInsertRowid
    );
    const urgentCareId = addEncounter(
      hhChildId,
      shiftDateStr(on, -1),
      "Urgent care",
      ngProviderId
    );
    db.prepare(
      `INSERT INTO episode_encounters (profile_id, episode_id, encounter_id)
     VALUES (?, ?, ?)`
    ).run(hhChildId, coldId, urgentCareId);
    const amoxId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
           (profile_id, name, kind, obligation, active, rx)
         VALUES (?, 'Amoxicillin', 'medication', 'should', 1, 1)`
        )
        .run(hhChildId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '250 mg', 'Morning', 'any', 0)`
    ).run(amoxId);
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on, provider_id)
     VALUES (?, ?, NULL, ?)`
    ).run(amoxId, shiftDateStr(on, -1), ngProviderId);

    const hhLoginId = seedMemberLogin(E2E_LOGIN_HHHIST, hhParentId);
    grantProfile(hhLoginId, hhChildId);

    // A second caregiver granted BOTH profiles read-only (the view-only grant case).
    const hhRoLoginId = seedMemberLogin(
      E2E_LOGIN_HHHIST_RO,
      hhParentId,
      "read"
    );
    grantProfile(hhRoLoginId, hhChildId, "read");

    console.log(
      `e2e: seeded household-history fixtures — parent ${hhParentId}, child ${hhChildId}, caregivers ${hhLoginId}/${hhRoLoginId} (#1009)`
    );
  }

  // CONDITION_REVIEW (#685): a dedicated profile carrying a positive infection lab
  // result NOT on its problem list, so the condition-suggestion review item surfaces on
  // Upcoming with the "Add to conditions" confirm. Isolated on purpose — the spec drives
  // a confirm/dismiss flow that mutates the problem list, and self-heals per run.
  const condReviewId = fixtureProfileId(CONDITION_REVIEW_PROFILE);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, canonical_name, value, loinc)
   VALUES (?, date('now'), 'lab', 'HIV 1/2 Antibody', 'HIV 1/2 Antibody', 'Reactive', '56888-1')`
  ).run(condReviewId);
  seedMemberLogin(E2E_LOGIN_CONDREV, condReviewId);
  console.log(
    `e2e: seeded condition-suggestion fixture — profile ${condReviewId} (#685)`
  );

  // REASON_MODEL (#656 item 4): a dedicated adult profile with a family history of
  // heart disease AND a fresh out-of-range LDL. The lipid analyte is risk-elevated for
  // this profile (family-cardiovascular factor), so the biomarker-flag item on
  // /upcoming gains its "why-for-this-profile" line ("Family history of heart
  // disease") — the surface proof for the shared reason model. Read-only; isolated so
  // it never changes a shared profile's flagged-lipid set. Idempotent: clear the LDL
  // + family row first so a reused server re-seeds cleanly.
  const reasonModelId = fixtureProfileId(REASON_MODEL_PROFILE);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
  ).run(reasonModelId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1980-01-01')`
  ).run(reasonModelId);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'LDL Cholesterol'`
  ).run(reasonModelId);
  db.prepare(
    `DELETE FROM family_history WHERE profile_id = ? AND condition = 'Coronary artery disease'`
  ).run(reasonModelId);
  db.prepare(
    `INSERT INTO family_history (profile_id, relation, condition) VALUES (?, 'parent', 'Coronary artery disease')`
  ).run(reasonModelId);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, canonical_name, value, unit, reference_range, flag)
   VALUES (?, date('now'), 'lab', 'LDL Cholesterol', 'LDL Cholesterol', '190', 'mg/dL', '<100', 'high')`
  ).run(reasonModelId);
  seedMemberLogin(E2E_LOGIN_REASON, reasonModelId, "read");

  // NOTIF_PROFILE (#928): a dedicated adult profile whose member OWNS every
  // notification mutation the Settings IA / matrix spec makes (enable Home Assistant,
  // toggle per-kind matrix cells, assert the safety all-channels-off warning). Kept
  // off every shared profile so it's repeat-safe under --repeat-each=3. No health
  // data needed — the matrix reads only notification settings.
  const notifProfileId = fixtureProfileId(NOTIF_PROFILE);
  seedMemberLogin(E2E_LOGIN_NOTIF, notifProfileId, "write");
  console.log(
    `e2e: seeded reason-model fixture — profile ${reasonModelId} (#656)`
  );

  // ASK_RECORDS (#878, Phase 2): a dedicated adult profile whose records answer the
  // canonical Q&A example — "when did I last take antibiotics?". An antibiotics
  // medication (notes name it a course, so the deterministic search matches "antibiotics"
  // via notes) plus a matching urgent-care visit. The palette's "Ask about your records"
  // retrieves them and renders a LINKED answer (offline structured floor on the keyless
  // e2e DB). Idempotent: clear the seeded rows first so a reused server re-seeds cleanly.
  // Isolated + read-only so it's repeat-safe.
  const askRecordsId = fixtureProfileId(ASK_RECORDS_PROFILE);
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    askRecordsId,
    ASK_RECORDS_MED
  );
  db.prepare(
    `DELETE FROM encounters WHERE profile_id = ? AND reason LIKE '%prescribed antibiotics%'`
  ).run(askRecordsId);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, condition, obligation, active, source, notes)
         VALUES (?, ?, 'medication', 'daily', 'should', 1, 'manual', 'Antibiotics course for a sinus infection')`
  ).run(askRecordsId, ASK_RECORDS_MED);
  db.prepare(
    `INSERT INTO encounters (profile_id, date, type, reason)
   VALUES (?, date('now', '-2 months'), 'Urgent care', 'Sinus infection — prescribed antibiotics')`
  ).run(askRecordsId);
  seedMemberLogin(E2E_LOGIN_ASK, askRecordsId, "read");
  console.log(`e2e: seeded record-QA fixture — profile ${askRecordsId} (#878)`);

  // #1305 finding-closure toast (settings autosave path): a sole gappy profile with SEX set
  // but NO birthdate, so ONLY the "Set a birthdate" data-quality gap is the salient clear.
  // The closure spec resets the birthdate at test start (direct-DB), so its write never
  // sticks across repeats and it never perturbs the DQ dashboard fixtures.
  const closureDqId = fixtureProfileId(CLOSURE_DQ_PROFILE);
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'birthdate'`
  ).run(closureDqId);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(closureDqId);
  seedMemberLogin(E2E_LOGIN_CLOSURE_DQ, closureDqId, "write");
  console.log(
    `e2e: seeded closure-DQ fixture — profile ${closureDqId} (#1305)`
  );

  // PROTEIN_QUICKADD_PROFILE (#824): a dedicated adult profile for the protein-grams
  // quick-add spec. Seeds a bodyweight (so the adequacy target scales) + a couple of
  // protein-bearing food-group servings today (so the card renders over the ESTIMATED
  // basis), with NO tracked protein_g and NO protein_log rows — the spec OWNS the grams
  // writes. Idempotent: hard-clear any protein_log rows so a reused server always starts
  // the day from the estimated-only basis the spec's transition asserts.
  const proteinProfileId = fixtureProfileId(PROTEIN_QUICKADD_PROFILE);
  const proteinAnchor = today(proteinProfileId);
  db.prepare(`DELETE FROM protein_log WHERE profile_id = ?`).run(
    proteinProfileId
  );
  db.prepare(
    `DELETE FROM profile_settings WHERE profile_id = ? AND key = 'protein_quickadd_last'`
  ).run(proteinProfileId);
  db.prepare(
    `INSERT OR IGNORE INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 80)`
  ).run(proteinProfileId, proteinAnchor);
  for (const [slug, servings] of [
    ["poultry", 1],
    ["eggs", 1],
  ] as const) {
    db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
    ).run(proteinProfileId, proteinAnchor, slug, servings);
  }
  seedMemberLogin(E2E_LOGIN_PROTEIN, proteinProfileId, "write");
  console.log(
    `e2e: seeded protein quick-add fixture — profile ${proteinProfileId} (${PROTEIN_QUICKADD_PROFILE}) (#824)`
  );
}

// ── Episode symptom-video strip (#1598) ──────────────────────────────────────
// Appended to the seed run's TAIL on purpose: it introduces a profile and an
// episode, and running it after every existing fixture keeps their row ids exactly
// where they were.
//
// A dedicated sick-solo login whose OPEN episode gives the episode page's
// SymptomVideoStrip a live upload day. The strip gathers clips over
// [episode.start, today] and uploads them at the cockpit's log date (today), so an
// OPEN episode is what makes an attached clip visible at all. Deliberately clipless:
// symptom-video.spec attaches and deletes every clip it asserts on, so the fixture
// always starts from the strip's EMPTY state (the branch nothing else renders).
export function seedSymptomVideoEpisode(): void {
  const pid = fixtureProfileId(SICK_VIDEO_PROFILE);
  const on = today(pid);
  const started = shiftDateStr(on, -2);

  // Adult, so nothing on the episode page is age-gated.
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1988-06-15')`
  ).run(pid);

  // Exactly one OPEN episode — the spec reaches it through the care trail's single
  // ongoing row, so a second episode would make that lookup ambiguous.
  db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(pid);
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(pid, started);

  // A small symptom history so the cockpit renders its normal shape (the strip sits
  // below the timeline, which needs days to draw).
  const seedSym = db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
  );
  seedSym.run(pid, shiftDateStr(on, -1), "cough", 2);
  seedSym.run(pid, on, "cough", 3);

  // Start clipless even on a reused dev server; the spec owns every row here.
  db.prepare("DELETE FROM symptom_videos WHERE profile_id = ?").run(pid);

  seedMemberLogin(E2E_LOGIN_SICK_VIDEO, pid, "write");
  console.log(
    `e2e: seeded symptom-video episode fixture — profile ${pid} (${SICK_VIDEO_PROFILE}) (#1598)`
  );
}
