// e2e seed fixtures — training domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { db, today } from "../../lib/db";
import { shiftDateStr, utcMinute, zonedWallTimeToUtc } from "../../lib/date";
import { localDayRange } from "../../lib/local-day-window";
import {
  E2E_LOGIN_FORM_DELOAD,
  E2E_LOGIN_FORM_PLATEAU,
  E2E_LOGIN_FORM_INJURY,
  FORM_DELOAD_PROFILE,
  FORM_PLATEAU_PROFILE,
  FORM_INJURY_PROFILE,
  E2E_LOGIN_ENDURANCE,
  ENDURANCE_PROFILE,
  E2E_LOGIN_TRAINING_ROLLUP,
  TRAINING_ROLLUP_PROFILE,
  E2E_LOGIN_LOAD_CONTEXT,
  LOAD_CONTEXT_PROFILE,
  LOAD_CONTEXT_LIFT,
  LOAD_CONTEXT_HOME,
  LOAD_CONTEXT_HOTEL,
  E2E_LOGIN_LAB_GOAL,
  LAB_GOAL_PROFILE,
  LAB_GOAL_TRACKED,
  LAB_GOAL_OVERDUE,
  LAB_GOAL_IN_RANGE,
  LAB_GOAL_TARGET,
} from "../fixture-logins";
import { getTimezone, setUserBirthdate, setUserSex } from "../../lib/settings";
import { reconcileFlags } from "../../lib/queries";
import { adoptTemplate, activateRoutine } from "../../lib/routines";
import { PROFILE_ID, seedMemberLogin, fixtureProfileId } from "./common";

// ── Dense Journal-card + met-target fixtures ──
export function seedJournalCard(): void {
  // Dense Journal-card fixture: the base seed already carries the full synthetic
  // Strava payload; e2e adds only a deliberately long note and the hand-edit lock so
  // disclosure + lock affordances can be exercised without another activity row.
  db.prepare(
    `UPDATE activities
      SET notes = ?,
          edited = 1,
          equipment_id = (
            SELECT id FROM equipment
             WHERE profile_id = ? AND name = 'Road Bike'
             LIMIT 1
          )
    WHERE profile_id = ? AND external_id = 'strava:seed-ride-1'`
  ).run(
    "Synthetic training note: steady endurance work with controlled breathing through the first half, then a slightly stronger finish while keeping cadence smooth and effort comfortably below threshold.",
    PROFILE_ID,
    PROFILE_ID
  );
  // Give the older, similarly sized cycling fixture enough overlapping provider
  // measurements to exercise the ride detail's selectable progression chart.
  // Values are deliberately plausible and fictional.
  db.prepare(
    `UPDATE activities
        SET avg_hr = 140,
            elevation_m = 165,
            relative_effort = 58,
            avg_power_w = 168,
            weighted_avg_power_w = 176,
            avg_cadence = 84
      WHERE profile_id = ? AND title = 'Zone 2 bike'`
  ).run(PROFILE_ID);

  const ride = db
    .prepare(
      `SELECT id, date FROM activities
        WHERE profile_id = ? AND external_id = 'strava:seed-ride-1'`
    )
    .get(PROFILE_ID) as { id: number; date: string } | undefined;
  if (ride) {
    const times = Array.from({ length: 1201 }, (_, index) => index);
    const streams = {
      time: { data: times, original_size: times.length },
      distance: {
        data: times.map((second) => second * 5),
        original_size: times.length,
      },
      moving: {
        data: times.map((second) => second < 300 || second >= 360),
        original_size: times.length,
      },
      watts: {
        data: times.map((second) =>
          second >= 400 && second < 500
            ? 0
            : second < 60
              ? 285
              : 175 + (second % 90)
        ),
        original_size: times.length,
      },
      cadence: {
        data: times.map((second) => 82 + (second % 12)),
        original_size: times.length,
      },
      velocity_smooth: {
        data: times.map((second) => 6.4 + (second % 40) / 20),
        original_size: times.length,
      },
      altitude: {
        data: times.map((second) => 100 + second / 30),
        original_size: times.length,
      },
      heartrate: {
        data: times.map((second) => 132 + Math.floor(second / 120)),
        original_size: times.length,
      },
      grade_smooth: {
        data: times.map((second) =>
          second >= 600 && second < 900 ? 4.2 : 0.5
        ),
        original_size: times.length,
      },
      latlng: {
        data: times.map((second) => {
          const anchors = [
            [38.5, -120.2],
            [40.7, -120.95],
            [43.252, -126.453],
          ];
          const scaled = (second / 1200) * (anchors.length - 1);
          const start = Math.min(Math.floor(scaled), anchors.length - 2);
          const progress = scaled - start;
          return [
            anchors[start][0] +
              (anchors[start + 1][0] - anchors[start][0]) * progress,
            anchors[start][1] +
              (anchors[start + 1][1] - anchors[start][1]) * progress,
          ];
        }),
        original_size: times.length,
      },
    };
    db.prepare(
      `INSERT INTO activity_telemetry
         (profile_id, activity_id, source, streams_json, ftp_w,
          power_zones_json, snapshot_at)
       VALUES (?, ?, 'strava', ?, 250, ?, datetime('now'))
       ON CONFLICT(profile_id, activity_id, source) DO UPDATE SET
         streams_json = excluded.streams_json,
         ftp_w = excluded.ftp_w,
         power_zones_json = excluded.power_zones_json`
    ).run(
      PROFILE_ID,
      ride.id,
      JSON.stringify(streams),
      JSON.stringify([
        { min: 0, max: 150 },
        { min: 151, max: 205 },
        { min: 206, max: 250 },
        { min: 251, max: -1 },
      ])
    );
    const insertRideHr = db.prepare(
      `INSERT OR REPLACE INTO hr_minutes
         (profile_id, ts, bpm, n, source)
       VALUES (?, ?, ?, 6, 'health-connect')`
    );
    for (let minute = 0; minute < 62; minute++) {
      const clockMinute = 7 * 60 + 15 + minute;
      const hh = String(Math.floor(clockMinute / 60)).padStart(2, "0");
      const mm = String(clockMinute % 60).padStart(2, "0");
      insertRideHr.run(
        PROFILE_ID,
        // hr_minutes.ts is a UTC instant since migration 164 (#2205); the fixture
        // converts its local wall clock the same way the ingest does.
        utcMinute(
          zonedWallTimeToUtc(getTimezone(PROFILE_ID), ride.date, `${hh}:${mm}`)!
        ),
        135 + Math.floor(minute / 8)
      );
    }
    db.prepare(
      "DELETE FROM activity_laps WHERE profile_id = ? AND activity_id = ?"
    ).run(PROFILE_ID, ride.id);
    db.prepare(
      `INSERT INTO activity_laps
         (profile_id, activity_id, source, external_id, lap_index, name,
          distance_m, moving_time_sec, average_speed_mps, average_watts)
       VALUES (?, ?, 'strava', 'e2e-lap-1', 1, 'Lap 1', 10000, 1500, 6.67, 184),
              (?, ?, 'strava', 'e2e-lap-2', 2, 'Lap 2', 14500, 2220, 6.53, 188)`
    ).run(PROFILE_ID, ride.id, PROFILE_ID, ride.id);
    db.prepare(
      "DELETE FROM activity_segment_efforts WHERE profile_id = ? AND activity_id = ?"
    ).run(PROFILE_ID, ride.id);
    db.prepare(
      `INSERT INTO activity_segment_efforts
         (profile_id, activity_id, source, external_id, name, distance_m,
          moving_time_sec, average_watts, pr_rank)
       VALUES (?, ?, 'strava', 'e2e-segment-1', 'Fictional park climb',
               1200, 245, 278, 1)`
    ).run(PROFILE_ID, ride.id);

    const prior = db
      .prepare(
        `SELECT id FROM activities
          WHERE profile_id = ? AND title = 'Zone 2 bike'
          ORDER BY date DESC, id DESC LIMIT 1`
      )
      .get(PROFILE_ID) as { id: number } | undefined;
    const route = db
      .prepare("SELECT polyline FROM activity_routes WHERE activity_id = ?")
      .get(ride.id) as { polyline: string } | undefined;
    if (prior && route) {
      db.prepare(
        `INSERT INTO activity_routes (activity_id, polyline, source)
         VALUES (?, ?, 'strava')
         ON CONFLICT(activity_id) DO UPDATE SET polyline = excluded.polyline`
      ).run(prior.id, route.polyline);
    }
  }

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
  const zoneTz = getTimezone(PROFILE_ID);

  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:zone-ride'`
  ).run(PROFILE_ID);
  {
    // The day as a half-open UTC range — `substr(ts,1,10)` is the UTC day now, not
    // the profile-local one this fixture means (#2205).
    const { startUtc, endUtc } = localDayRange(zoneTz, zoneDate);
    db.prepare(
      `DELETE FROM hr_minutes WHERE profile_id = ? AND ts >= ? AND ts < ?`
    ).run(PROFILE_ID, startUtc, endUtc);
  }

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
    insHr.run(
      utcMinute(zonedWallTimeToUtc(zoneTz, zoneDate, `08:${mm}`)!),
      m < 50 ? 135 : 160
    );
  }
  // A resting bucket at noon, OUTSIDE any activity window — proves the aggregation
  // scopes to workout windows (this all-day wear minute must not count as training).
  insHr.run(utcMinute(zonedWallTimeToUtc(zoneTz, zoneDate, "12:00")!), 62);

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
     (profile_id, date, type, title, duration_min, distance_km, source, external_id, edited, equipment_id, components)
   VALUES (?, ?, 'cardio', 'E2E Registry Ride', 45, 20, 'manual', 'e2e:equip-registry-ride', 0, ?,
           '[{"name":"Cycling","type":"cardio","distance_km":20,"duration_min":45}]')`
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

// ── Training → Overview rollup fixture (#1496) ──
export function seedTrainingRollup(): void {
  // A dedicated ADULT profile with a LIGHT recent strength log: five small-muscle
  // exercises at 2 sets each inside the trailing 7-day window, so the per-muscle
  // volume-band engine (#742) fires a HANDFUL of `below` shortfalls at once — the pile
  // the Overview rollup exists to fold into one card. Earlier sessions in the two
  // preceding weeks clear the #719 cold-start gate (≥2 distinct training weeks). NO
  // routine (so no deload gate) and NO injury (so no excluded region), and every date
  // is RELATIVE so the fixture never goes stale.
  const profileId = fixtureProfileId(TRAINING_ROLLUP_PROFILE);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id LIKE 'e2e:training-rollup-%'`
  ).run(profileId);
  const insAct = db.prepare(
    `INSERT INTO activities
     (profile_id, date, type, title, duration_min, source, external_id, edited)
   VALUES (?, ?, 'strength', 'Accessories', 30, 'manual', ?, 0)`
  );
  const insSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, ?, ?, 20, 10, 0)`
  );
  const EXERCISES = [
    "Barbell Curl",
    "Skullcrusher",
    "Lateral Raise",
    "Cable Crunch",
    "Standing Calf Raise",
  ];
  // Two earlier weeks satisfy the cold-start gate; day -2 is the in-window session
  // whose light volume produces the shortfalls.
  [-16, -9, -2].forEach((day, i) => {
    const actId = Number(
      insAct.run(
        profileId,
        shiftDateStr(today(profileId), day),
        `e2e:training-rollup-${i}`
      ).lastInsertRowid
    );
    for (const exercise of EXERCISES) {
      for (let s = 1; s <= 2; s++) insSet.run(actId, exercise, s);
    }
  });
  seedMemberLogin(E2E_LOGIN_TRAINING_ROLLUP, profileId, "write");
  console.log(
    `e2e: seeded training-overview rollup fixture — profile ${profileId} (${TRAINING_ROLLUP_PROFILE}) (#1496)`
  );
}

// ── Strength load contexts (#1610) ────────────────────────────────────────────
// One exercise NAME logged on TWO registry machines at loads that are not
// comparable: a home chest press climbing 80 → 86 kg and a hotel machine whose
// stack geometry makes ~50 kg the right load. Before #1610 the read layer dropped
// `exercise_sets.equipment_id`, so every strength surface averaged the two into one
// jagged progression, and a movement-wide max let the home machine's numbers stand
// in for the hotel machine's.
//
// The fixture is what makes the deferred half OBSERVABLE in the browser: two
// contexts is the minimum at which the Analyze chooser renders, the Trends series
// splits, and the goal form has an ambiguity to force a choice about.
//
// Dates are relative (#1511) and inside the 90-day Trends default so the lens sees
// them without widening the range. Idempotent: its own rows are cleared and
// rewritten, children first.
export function seedLoadContexts(): void {
  const profileId = fixtureProfileId(LOAD_CONTEXT_PROFILE);
  const t = today(profileId);

  db.prepare(
    `DELETE FROM exercise_sets WHERE activity_id IN
       (SELECT id FROM activities WHERE profile_id = ?)`
  ).run(profileId);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM goals WHERE profile_id = ?`).run(profileId);
  db.prepare(`DELETE FROM equipment WHERE profile_id = ?`).run(profileId);

  const insEquipment = db.prepare(
    `INSERT INTO equipment (profile_id, name, category) VALUES (?, ?, 'Machine')`
  );
  const homeId = Number(
    insEquipment.run(profileId, LOAD_CONTEXT_HOME).lastInsertRowid
  );
  const hotelId = Number(
    insEquipment.run(profileId, LOAD_CONTEXT_HOTEL).lastInsertRowid
  );

  const insAct = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, source)
     VALUES (?, ?, 'strength', 'Chest day', 40, 'manual')`
  );
  const insSet = db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, equipment_id, warmup)
     VALUES (?, ?, ?, ?, 5, ?, 0)`
  );
  const session = (ago: number, weightKg: number, equipmentId: number) => {
    const actId = Number(
      insAct.run(profileId, shiftDateStr(t, -ago)).lastInsertRowid
    );
    for (let set = 1; set <= 3; set++)
      insSet.run(actId, LOAD_CONTEXT_LIFT, set, weightKg, equipmentId);
  };

  // The home machine PROGRESSES; the hotel machine is nearly flat. Averaged, the two
  // read as one lift bouncing between 50 and 86 — the fabricated trend #1610 is
  // about. The hotel machine carries the NEWEST session, so it is the context the
  // Analyze view must default to.
  for (const [ago, kg] of [
    [63, 80],
    [49, 82],
    [35, 84],
    [21, 86],
  ] as const) {
    session(ago, kg, homeId);
  }
  for (const [ago, kg] of [
    [56, 50],
    [42, 50],
    [28, 51],
    [7, 51],
  ] as const) {
    session(ago, kg, hotelId);
  }

  seedMemberLogin(E2E_LOGIN_LOAD_CONTEXT, profileId, "write");
  console.log(
    `e2e: seeded strength load-context fixture — profile ${profileId} (${LOAD_CONTEXT_PROFILE}) (#1610)`
  );
}

export function seedLabValueGoal(): void {
  // The fixture behind e2e/lab-value-goal.spec.ts (#1853). See the constants' header
  // in e2e/logins/training.ts for why it is a dedicated, write-granted profile.
  const pid = fixtureProfileId(LAB_GOAL_PROFILE);
  seedMemberLogin(E2E_LOGIN_LAB_GOAL, pid, "write");
  setUserBirthdate(pid, "1984-02-19");
  setUserSex(pid, "male");
  const anchor = today(pid);

  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN (?, ?, ?)`
  ).run(pid, LAB_GOAL_TRACKED, LAB_GOAL_OVERDUE, LAB_GOAL_IN_RANGE);
  const insRecord = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, source)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'manual')`
  );
  // The goal's baseline draw, then a later one that has moved toward the target but
  // has not reached it — so the card renders a partial bar rather than 0% or "met".
  insRecord.run(
    pid,
    shiftDateStr(anchor, -200),
    LAB_GOAL_TRACKED,
    "160",
    "mg/dL",
    LAB_GOAL_TRACKED,
    160
  );
  insRecord.run(
    pid,
    shiftDateStr(anchor, -40),
    LAB_GOAL_TRACKED,
    "130",
    "mg/dL",
    LAB_GOAL_TRACKED,
    130
  );
  // Overdue on its 90-day cadence, so the picker's relevance group leads with it.
  insRecord.run(
    pid,
    shiftDateStr(anchor, -400),
    LAB_GOAL_OVERDUE,
    "5.4",
    "%",
    LAB_GOAL_OVERDUE,
    5.4
  );
  // Measured, in range, fresh: the profile's own marker and nothing more, which is
  // what puts a row under the picker's "Your markers" header.
  insRecord.run(
    pid,
    shiftDateStr(anchor, -30),
    LAB_GOAL_IN_RANGE,
    "4.5",
    "g/dL",
    LAB_GOAL_IN_RANGE,
    4.5
  );
  reconcileFlags(pid);

  // The goal itself is seeded DIRECTLY (#1901): the rendered progress/pacing line is
  // what this half of the spec is about, and driving a create form first would make
  // every assertion depend on a second feature's UI. The form IS exercised, on the
  // OTHER analyte, by the picker half.
  //
  // The window is chosen so the two pacing models DISAGREE, which is what makes the
  // rendered tone worth asserting: created 200 days ago, due in 160, so the goal is
  // 200/360 = 56% through its calendar but only 50% of the way to its number. A
  // DAILY-paced goal would read "behind" here. The last RESULT landed 40 days ago,
  // at 160/360 = 44% of the window, so on the evidence the goal is on pace — and it
  // cannot fall behind until a new draw says so.
  db.prepare(`DELETE FROM goals WHERE profile_id = ?`).run(pid);
  db.prepare(
    `INSERT INTO goals
       (profile_id, title, category, status, archived, target_value, unit,
        biomarker_name, target_direction, target_date, baseline_value, created_at)
     VALUES (?, ?, 'biomarker', 'active', 0, ?, 'mg/dL', ?, 'below', ?, 160, ?)`
  ).run(
    pid,
    `${LAB_GOAL_TRACKED} under ${LAB_GOAL_TARGET}`,
    LAB_GOAL_TARGET,
    LAB_GOAL_TRACKED,
    shiftDateStr(anchor, 160),
    `${shiftDateStr(anchor, -200)} 09:00:00`
  );
}
