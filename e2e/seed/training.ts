// e2e seed fixtures — training domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { db, today } from "../../lib/db";
import { shiftDateStr } from "../../lib/date";
import {
  E2E_LOGIN_FORM_DELOAD,
  E2E_LOGIN_FORM_PLATEAU,
  E2E_LOGIN_FORM_INJURY,
  FORM_DELOAD_PROFILE,
  FORM_PLATEAU_PROFILE,
  FORM_INJURY_PROFILE,
  E2E_LOGIN_ENDURANCE,
  ENDURANCE_PROFILE,
} from "../fixture-logins";
import { adoptTemplate, activateRoutine } from "../../lib/routines";
import { PROFILE_ID, seedMemberLogin, fixtureProfileId } from "./common";

// ── Dense Journal-card + met-target fixtures ──
export function seedJournalCard(): void {
  // Dense Journal-card fixture: the base seed already carries the full synthetic
  // Strava payload; e2e adds only a deliberately long note and the hand-edit lock so
  // disclosure + lock affordances can be exercised without another activity row.
  db.prepare(
    `UPDATE activities
      SET notes = ?, edited = 1
    WHERE profile_id = ? AND external_id = 'strava:seed-ride-1'`
  ).run(
    "Synthetic training note: steady endurance work with controlled breathing through the first half, then a slightly stronger finish while keeping cadence smooth and effort comfortably below threshold.",
    PROFILE_ID
  );

  // Give one recent strength row an explicit met target so the card's visible and
  // accessible status treatment is covered by the browser tier.
  db.prepare(
    `UPDATE exercise_sets
      SET target_reps = reps
    WHERE activity_id = (
      SELECT id FROM activities
       WHERE profile_id = ? AND title = 'Push day'
       ORDER BY date DESC, id DESC LIMIT 1
    ) AND exercise = 'Barbell Bench Press'`
  ).run(PROFILE_ID);

  db.prepare(
    `DELETE FROM integration_sync_events WHERE profile_id = ? AND provider IN ('strava','health-connect')`
  ).run(PROFILE_ID);
}

// ── Training HR-zone fixture ──
export function seedTrainingZones(): void {
  // ── Training HR-zone fixture (issue #159) ─────────────────────────────────────
  // A windowed cardio session with per-minute HR inside its window, so the Trends →
  // Fitness zone section, weekly Zone 2 volume, and polarization split render on the
  // e2e DB. The seed profile is ~40y with a latest resting HR of 55 bpm, so the zone
  // model is Karvonen (max 180, resting 55): Zone 2 ≈ 130–142 bpm, Zone 4 ≈ 155–167.
  // Relative dates so it never goes stale. Idempotent: clear any prior fixture rows.
  const zoneDate = shiftDateStr(today(PROFILE_ID), -2);

  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:zone-ride'`
  ).run(PROFILE_ID);
  db.prepare(
    `DELETE FROM hr_minutes WHERE profile_id = ? AND substr(ts,1,10) = ?`
  ).run(PROFILE_ID, zoneDate);

  db.prepare(
    `INSERT INTO activities
     (profile_id, date, type, title, notes, duration_min, distance_km, intensity,
      start_time, end_time, components, source, external_id)
   VALUES (1, ?, 'cardio', 'Zone 2 base ride', NULL, 60, 20, 'moderate',
           '08:00', '09:00', ?, 'manual', 'e2e:zone-ride')`
  ).run(
    zoneDate,
    JSON.stringify([
      { name: "Cycling", type: "cardio", distance_km: 20, duration_min: 60 },
    ])
  );

  const insHr = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (1, ?, ?, 6, 'health-connect')`
  );
  // 08:00–08:49 easy Zone 2 (135 bpm), 08:50–08:59 hard Zone 4 (160 bpm): 50 easy +
  // 10 hard, an ~83/17 balanced split (below the hard-heavy nudge threshold).
  for (let m = 0; m < 60; m++) {
    const mm = String(m).padStart(2, "0");
    insHr.run(`${zoneDate}T08:${mm}`, m < 50 ? 135 : 160);
  }
  // A resting bucket at noon, OUTSIDE any activity window — proves the aggregation
  // scopes to workout windows (this all-day wear minute must not count as training).
  insHr.run(`${zoneDate}T12:00`, 62);

  console.log(
    `e2e: seeded a windowed HR-zone ride for profile 1 on ${zoneDate} (50 min Z2 + 10 min Z4)`
  );
}

// ── Activity-form fill-paths fixtures ──
export function seedActivityFormPaths(): void {
  // ── #923: activity-form fill-paths fixtures ─────────────────────────────────────
  // FORM_DELOAD: an ADULT profile with an ACTIVE PPL routine in its deload week PLUS
  // logged Barbell Bench Press history, so the strength editor's next-set suggestion for
  // a routine lift is deload-shaved (100 kg progression → ~90 kg + the shared rationale).
  // Dedicated on purpose so a create-and-clean save in the form spec never touches the
  // #741 deload fixture (which asserts an exact slate). Idempotent: reset + re-adopt.
  const formDeloadProfileId = fixtureProfileId(FORM_DELOAD_PROFILE);
  db.prepare(
    `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id WHERE r.profile_id = ?)`
  ).run(formDeloadProfileId);
  db.prepare(
    `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?)`
  ).run(formDeloadProfileId);
  db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(
    formDeloadProfileId
  );
  const formDeloadRoutineId = adoptTemplate(
    formDeloadProfileId,
    "push-pull-legs-6x"
  );
  activateRoutine(formDeloadProfileId, formDeloadRoutineId);
  db.prepare(
    `UPDATE routines SET cycle_weeks = 2, started_date = ? WHERE id = ?`
  ).run(shiftDateStr(today(formDeloadProfileId), -7), formDeloadRoutineId);
  // One prior Barbell Bench Press session (3 × 100 kg × 6) three days ago: the coached
  // suggestion holds 100 kg and builds a rep, which the deload week shaves to 90 kg.
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:form-deload-bench'`
  ).run(formDeloadProfileId);
  const formBenchActId = Number(
    db
      .prepare(
        `INSERT INTO activities
         (profile_id, date, type, title, duration_min, source, external_id, edited)
       VALUES (?, ?, 'strength', 'Push', 40, 'manual', 'e2e:form-deload-bench', 0)`
      )
      .run(formDeloadProfileId, shiftDateStr(today(formDeloadProfileId), -3))
      .lastInsertRowid
  );
  const insFormBench = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Barbell Bench Press', ?, 100, 6, 0)`
  );
  for (let s = 1; s <= 3; s++) insFormBench.run(formBenchActId, s);
  seedMemberLogin(E2E_LOGIN_FORM_DELOAD, formDeloadProfileId);

  // FORM_PLATEAU: an ADULT profile with NO routine and a flat-for-6-weeks Skullcrusher
  // (5 sessions of 30 kg × 8), so the strength editor shows the inline plateau hint for a
  // plateaued lift — never shaved, since the profile has no cycle. Dedicated so the
  // dismiss test's suppression write stays isolated from profile 1's Skullcrusher plateau
  // (which rule-findings.spec relies on).
  const formPlateauProfileId = fixtureProfileId(FORM_PLATEAU_PROFILE);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id LIKE 'e2e:form-plateau-%'`
  ).run(formPlateauProfileId);
  const insFormPlAct = db.prepare(
    `INSERT INTO activities
     (profile_id, date, type, title, duration_min, source, external_id, edited)
   VALUES (?, ?, 'strength', 'Arms', 25, 'manual', ?, 0)`
  );
  const insFormPlSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Skullcrusher', ?, 30, 8, 0)`
  );
  [-40, -33, -26, -14, -2].forEach((day, i) => {
    const actId = Number(
      insFormPlAct.run(
        formPlateauProfileId,
        shiftDateStr(today(formPlateauProfileId), day),
        `e2e:form-plateau-${i}`
      ).lastInsertRowid
    );
    for (let s = 1; s <= 3; s++) insFormPlSet.run(actId, s);
  });
  seedMemberLogin(E2E_LOGIN_FORM_PLATEAU, formPlateauProfileId);

  // FORM_INJURY (#1144): an ADULT profile with a RECOVERING "Chest" injury + logged Barbell
  // Bench Press history (a Chest lift) and NO routine, so the strength editor's next-set
  // suggestion is injury-TEMPERED (100 kg progression → 60 kg = 100 × RECOVERING_LOAD_FACTOR
  // 0.6) OUTSIDE any deload week — the axis #1115 left open. The form now threads the same
  // recovering-region context the Analyze/detail panel reads, so both surfaces seed 60 kg.
  // Dedicated so the recovering injury never tempers a shared profile's coaching surfaces.
  const formInjuryProfileId = fixtureProfileId(FORM_INJURY_PROFILE);
  db.prepare(`DELETE FROM injuries WHERE profile_id = ?`).run(
    formInjuryProfileId
  );
  db.prepare(
    `INSERT INTO injuries (profile_id, label, regions, status, since)
     VALUES (?, 'Left pec strain (e2e)', '["Chest"]', 'recovering', ?)`
  ).run(formInjuryProfileId, shiftDateStr(today(formInjuryProfileId), -21));
  // One prior Barbell Bench Press session (3 × 100 kg × 6) three days ago: the coached
  // suggestion holds 100 kg + builds a rep, which the recovering-Chest temper backs to 60.
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:form-injury-bench'`
  ).run(formInjuryProfileId);
  const formInjuryBenchActId = Number(
    db
      .prepare(
        `INSERT INTO activities
         (profile_id, date, type, title, duration_min, source, external_id, edited)
       VALUES (?, ?, 'strength', 'Push', 40, 'manual', 'e2e:form-injury-bench', 0)`
      )
      .run(formInjuryProfileId, shiftDateStr(today(formInjuryProfileId), -3))
      .lastInsertRowid
  );
  const insFormInjuryBench = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Barbell Bench Press', ?, 100, 6, 0)`
  );
  for (let s = 1; s <= 3; s++) insFormInjuryBench.run(formInjuryBenchActId, s);
  seedMemberLogin(E2E_LOGIN_FORM_INJURY, formInjuryProfileId);

  console.log(
    `e2e: seeded activity-form fill-path fixtures — deload profile ${formDeloadProfileId}, plateau profile ${formPlateauProfileId}, injury profile ${formInjuryProfileId} (#923/#1144)`
  );

  // A profile-1 equipment row REFERENCED by a logged strength set, so the equipment
  // manager's delete can prove it detaches the link (nulls exercise_sets.equipment_id)
  // and the referencing session still renders — no FK 500 (the #342 side-state rule).
  // Idempotent: rebuilt from scratch each boot.
  db.prepare(
    `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Delete Bar'`
  ).run(PROFILE_ID);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:equip-delete'`
  ).run(PROFILE_ID);
  const delBarId = Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, weight_kg, category)
       VALUES (?, 'E2E Delete Bar', 20, 'Barbell')`
      )
      .run(PROFILE_ID).lastInsertRowid
  );
  const delActId = Number(
    db
      .prepare(
        `INSERT INTO activities
         (profile_id, date, type, title, duration_min, source, external_id, edited)
       VALUES (?, ?, 'strength', 'E2E Equipment Delete Session', 30, 'manual', 'e2e:equip-delete', 0)`
      )
      .run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -1)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id)
   VALUES (?, 'Bench Press', 1, 60, 5, ?)`
  ).run(delActId, delBarId);

  // A DEDICATED, non-retired profile-1 Bike used by a session-level cardio activity
  // (activities.equipment_id), for the equipment-registry spec (issue #343): it
  // proves the /equipment index renders a usage badge + a Cardio group, and its
  // /equipment/[id] detail renders the sessions/last-used/total-distance payoff.
  // Distinct name from "E2E Delete Bar" (the delete spec's fixture) so the two specs
  // never race on the same row. Idempotent: rebuilt from scratch each boot.
  db.prepare(
    `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Registry Bike'`
  ).run(PROFILE_ID);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:equip-registry-ride'`
  ).run(PROFILE_ID);
  const regBikeId = Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, weight_kg, category)
       VALUES (?, 'E2E Registry Bike', NULL, 'Bike')`
      )
      .run(PROFILE_ID).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO activities
     (profile_id, date, type, title, duration_min, distance_km, source, external_id, edited, equipment_id)
   VALUES (?, ?, 'cardio', 'E2E Registry Ride', 45, 20, 'manual', 'e2e:equip-registry-ride', 0, ?)`
  ).run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -2), regBikeId);

  // A dedicated recovery device on profile 1 for the protocol-practice spec (issue
  // #344): the protocol form can reference it as the gear its experiment is about.
  // Distinct, synthetic name so it never collides with the equipment specs' rows.
  // Idempotent: rebuilt each boot.
  db.prepare(
    `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Protocol Sauna'`
  ).run(PROFILE_ID);
  db.prepare(
    `INSERT INTO equipment (profile_id, name, weight_kg, category)
   VALUES (?, 'E2E Protocol Sauna', NULL, 'Sauna')`
  ).run(PROFILE_ID);

  // A dedicated STRENGTH implement on profile 1 for the protocols "Recovery gear"
  // filter spec (issue #592): the protocol form must offer the recovery Sauna above
  // but NOT this Barbell. Distinct name so it never collides with the equipment
  // specs' "E2E Delete Bar" (which the manager delete spec removes). Idempotent.
  db.prepare(
    `DELETE FROM equipment WHERE profile_id = ? AND name = 'E2E Protocol Barbell'`
  ).run(PROFILE_ID);
  db.prepare(
    `INSERT INTO equipment (profile_id, name, weight_kg, category)
   VALUES (?, 'E2E Protocol Barbell', 20, 'Barbell')`
  ).run(PROFILE_ID);

  // A dedicated, open, FUTURE-dated care-plan item on profile 1 for the care-plan
  // spec's complete→disappears-from-Upcoming check. Distinct from the base seed's
  // care-plan rows (which care-plan-upcoming.spec drives), so the two never collide.
  // The description must match NO preventive concept-map phrase, so completing it
  // can't infer-satisfy any rule and disturb preventive-upcoming's assertions (an
  // earlier "eye exam" wording once satisfied vision_exam when the spec completed it;
  // vision_exam is now also seed-satisfied via profile 1's current optical Rx, #1098).
  db.prepare(
    `DELETE FROM care_plan_items WHERE profile_id = ? AND description IN ('E2E annual eye exam', 'E2E orthotics fitting')`
  ).run(PROFILE_ID);
  db.prepare(
    `INSERT INTO care_plan_items
     (profile_id, description, category, planned_date, status, notes)
   VALUES (?, 'E2E orthotics fitting', 'procedure', ?, 'planned', 'Custom insole fitting')`
  ).run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), 21));

  // A dedicated, FUTURE, scheduled appointment on profile 1 (with a provider) for the
  // appointments spec's cancel→removed-from-Upcoming check — separate from the base
  // seed's appointments so cancelling it can't disturb the family-calendar / upcoming
  // fixtures. Provider linked via a dedicated synthetic clinic.
  db.prepare(
    `DELETE FROM appointments WHERE profile_id = ? AND title = 'E2E dermatology visit'`
  ).run(PROFILE_ID);
  db.prepare(`DELETE FROM providers WHERE dedup_key = 'e2e-appt-clinic'`).run();
  const apptProviderId = Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key)
       VALUES ('E2E Skin Clinic', 'organization', 'e2e-appt-clinic')`
      )
      .run().lastInsertRowid
  );
  db.prepare(
    `INSERT INTO appointments (profile_id, scheduled_at, provider_id, title, location, status)
   VALUES (?, ?, ?, 'E2E dermatology visit', 'E2E Skin Clinic', 'scheduled')`
  ).run(
    PROFILE_ID,
    `${shiftDateStr(today(PROFILE_ID), 4)} 09:30`,
    apptProviderId
  );

  console.log(
    `e2e: seeded an equipment-delete link fixture, an open care-plan item, and a future appointment on profile ${PROFILE_ID} (#391)`
  );
}

// ── Endurance event plans ──
export function seedEndurancePlans(): void {
  // ── Endurance event plans (#839) ──────────────────────────────────────────────
  // ENDURANCE_PROFILE: a dedicated adult profile with a few weeks of logged runs so a
  // plan created in the spec has a real weekly-volume base + this-week actuals. The spec
  // OWNS the endurance_plans lifecycle (create-and-clean), so hard-clear any leftover
  // plans on a reused server. Runs seeded across the last three weeks + this week.
  const enduranceProfileId = fixtureProfileId(ENDURANCE_PROFILE);
  db.prepare(`DELETE FROM endurance_plans WHERE profile_id = ?`).run(
    enduranceProfileId
  );
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND type = 'cardio'`
  ).run(enduranceProfileId);
  for (const [ago, km, wt] of [
    [20, 8, null],
    [18, 6, null],
    [13, 9, null],
    [11, 7, null],
    [6, 10, "long run"],
    [4, 6, null],
    [1, 8, null], // this week so far
  ] as const) {
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, distance_km, workout_type)
     VALUES (?, ?, 'cardio', 'Running', ?, ?)`
    ).run(
      enduranceProfileId,
      shiftDateStr(today(enduranceProfileId), -ago),
      km,
      wt
    );
  }
  seedMemberLogin(E2E_LOGIN_ENDURANCE, enduranceProfileId, "write");
  console.log(
    `e2e: seeded endurance-plan fixture — profile ${enduranceProfileId} (${ENDURANCE_PROFILE}) (#839)`
  );
}
