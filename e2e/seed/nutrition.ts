// e2e seed fixtures — nutrition domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { now as clockNow } from "../../lib/clock";
import {
  shiftDateStr,
  utcSqlString,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "../../lib/date";
import { saveFitnessEntry } from "../../lib/fitness-assessment";
import { reconcileFlags } from "../../lib/queries";
import {
  E2E_LOGIN_DUP,
  E2E_LOGIN_NUTRITION,
  NUTRITION_PROFILE,
  E2E_LOGIN_NOGEAR,
  E2E_LOGIN_FITNESS,
  E2E_LOGIN_FITNESS_SENIOR,
  E2E_LOGIN_MOBILITY,
  MOBILITY_PROFILE,
  DUP_REVIEW_PROFILE,
  NO_GEAR_PROFILE,
  FITNESS_PROFILE,
  FITNESS_SENIOR_PROFILE,
  E2E_LOGIN_PRESENCE,
  PRESENCE_PROFILE,
  E2E_LOGIN_RECAP,
  RECAP_PROFILE,
  E2E_LOGIN_FOODSLOT,
  FOOD_SLOT_PROFILE,
  E2E_LOGIN_FOODPIN,
  FOOD_PIN_PROFILE,
  FOOD_PIN_GROUP,
} from "../fixture-logins";
import { getTimezone, setTimezone } from "../../lib/settings";
import { ins, seedMemberLogin, fixtureProfileId } from "./common";

// ── Nutrition trio (protein gauge / preferences / fiber) ──
export function seedNutritionTrio(): void {
  // ── Nutrition trio (#974 protein gauge / #975 preferences / #976 fiber) ──────
  // A dedicated adult profile carrying everything the three nutrition surfaces read: a
  // recent weigh-in (a target to scale), this-week food servings across protein- AND
  // fiber-bearing groups, a CONFIRMED capsule fiber supplement today (the honest
  // grams-unknown note), sex = male (a DRI fiber target), and one flagged low omega-3 (the
  // #577 engine fires → the vegetarian preset's plant substitution is observable). Isolated
  // on purpose: the preferences spec mutates the excluded set, which on profile 1 would race
  // the coaching specs' suggestion reads. Idempotent — every owned table is cleared first.
  const nutritionId = fixtureProfileId(NUTRITION_PROFILE);
  seedMemberLogin(E2E_LOGIN_NUTRITION, nutritionId);
  {
    const nToday = today(nutritionId);
    // Clear prior fixture data so a reused dev server re-seeds cleanly.
    db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(nutritionId);
    db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(
      nutritionId
    );
    db.prepare(
      `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Omega-3 Total (OmegaCheck)'`
    ).run(nutritionId);
    db.prepare(
      `DELETE FROM intake_item_logs WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ? AND name = 'Fiber capsules')`
    ).run(nutritionId);
    db.prepare(
      `DELETE FROM intake_item_doses WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ? AND name = 'Fiber capsules')`
    ).run(nutritionId);
    db.prepare(
      `DELETE FROM intake_items WHERE profile_id = ? AND name = 'Fiber capsules'`
    ).run(nutritionId);
    db.prepare(
      `DELETE FROM profile_settings WHERE profile_id = ? AND key IN ('sex', 'dietary_excluded_groups')`
    ).run(nutritionId);

    // Sex → a DRI fiber target (adult male = 38 g/day).
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
    ).run(nutritionId);
    // A recent weigh-in → a protein target to scale (active band ~95–130 g at 80 kg).
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, notes) VALUES (?, ?, 80, 'e2e:nutrition')`
    ).run(nutritionId, nToday);

    // This-week food servings — protein- AND fiber-bearing groups, plus fatty_fish so the
    // vegetarian preset's demotion of an excluded group is observable. Kept modestly below
    // both targets so the below-verdict copy renders.
    const logFood = (date: string, slug: string, servings: number) =>
      db
        .prepare(
          `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)`
        )
        .run(nutritionId, date, slug, servings);
    for (const [dayOffset, rows] of [
      [
        0,
        [
          ["legumes", 1],
          ["whole_grains", 1],
          ["fatty_fish", 1],
        ],
      ],
      [
        -1,
        [
          ["leafy_greens", 2],
          ["eggs", 1],
        ],
      ],
      [
        -2,
        [
          ["poultry", 1],
          ["berries", 1],
        ],
      ],
    ] as const) {
      for (const [slug, n] of rows)
        logFood(shiftDateStr(nToday, dayOffset), slug, n);
    }

    // A confirmed capsule-unit fiber supplement TODAY → the honest "grams unknown" note.
    const fiberItemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Fiber capsules', 1, 'supplement', 'daily', 'should')`
        )
        .run(nutritionId).lastInsertRowid
    );
    const fiberDoseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 capsule', 'morning', 'any', 0)`
        )
        .run(fiberItemId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, recorded_at, status)
     VALUES (?, ?, ?, '1 capsule', ?, 'taken')`
    ).run(fiberDoseId, fiberItemId, nToday, utcSqlString(clockNow()));

    // One flagged low omega-3 reading → the #577 engine surfaces a fish suggestion the
    // vegetarian preset substitutes to a plant source.
    db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
     VALUES (?, ?, 'lab', 'Omega-3 Total (OmegaCheck)', '3.2', '%', 'Omega-3 Total (OmegaCheck)', 'low', ?)`
    ).run(nutritionId, nToday, utcSqlString(clockNow()));
  }

  // A dedicated profile whose sole Data → Review item is a SAME-SOURCE duplicate:
  // two manual weigh-ins on one day (both source NULL → both "Manual entry"), so the
  // resolver's candidate labels collide and the A/B disambiguation fallback (#531) is
  // exercised without touching profile 1's review inbox. Idempotent: clear the
  // profile's body_metrics first (it owns no others). Distinct weights so the two rows
  // visibly differ; body_metrics allows two NULL-source rows on one day.
  const dupReviewId = fixtureProfileId(DUP_REVIEW_PROFILE);
  seedMemberLogin(E2E_LOGIN_DUP, dupReviewId);

  // A dedicated ADULT profile that owns NO equipment (issue #592) so the activity
  // form's equipment picker renders its empty-state "Add equipment" bootstrap door.
  // It owns nothing else either — the spec only opens the log form and reads the door.
  const noGearId = fixtureProfileId(NO_GEAR_PROFILE);
  db.prepare(`DELETE FROM equipment WHERE profile_id = ?`).run(noGearId);
  seedMemberLogin(E2E_LOGIN_NOGEAR, noGearId);

  // Fitness check (#834) — a dedicated ADULT profile carrying sex + birthdate (so norms
  // resolve) and a PRIOR check ~100 days ago, so the spec can record a test today and see a
  // check-over-check delta. A dedicated SENIOR profile (age 72) renders the older-adult
  // battery variant. Idempotent: clear their fitness sessions first.
  const fitnessId = fixtureProfileId(FITNESS_PROFILE);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
  ).run(fitnessId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1986-05-01')`
  ).run(fitnessId);
  db.prepare(`DELETE FROM fitness_assessments WHERE profile_id = ?`).run(
    fitnessId
  );
  saveFitnessEntry(fitnessId, {
    date: shiftDateStr(today(fitnessId), -100),
    testKey: "grip",
    value: 44,
  });
  // #1129 ambient auto-count fixtures — natural-store readings the check NEVER recorded, so
  // the grid lights up tiles as measured-with-provenance without a check session: a SYNCED
  // VO2 Max (medical_records, source 'oura'), a scale body-fat/resting-HR + a bodyweight
  // (body_metrics, source 'withings'), a logged heavy Back Squat (exercise_sets), and a
  // logged Plank hold (#1135 self-norm rough band). Idempotent-ish: cleared with the
  // profile's fitness sessions is not enough (these aren't sessions), so clear them first.
  const fitnessRecent = shiftDateStr(today(fitnessId), -3);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'VO2 Max' AND source = 'oura'`
  ).run(fitnessId);
  db.prepare(
    `DELETE FROM body_metrics WHERE profile_id = ? AND source = 'withings'`
  ).run(fitnessId);
  db.prepare(
    `DELETE FROM exercise_sets WHERE activity_id IN
     (SELECT id FROM activities WHERE profile_id = ? AND title = 'Fitness log (e2e)')`
  ).run(fitnessId);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND title = 'Fitness log (e2e)'`
  ).run(fitnessId);
  db.prepare(
    `INSERT INTO medical_records
     (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
   VALUES (?, ?, 'biomarker', 'VO2 Max', '48', 48, 'mL/kg/min', 'VO2 Max', 'oura')`
  ).run(fitnessId, fitnessRecent);
  reconcileFlags(fitnessId);
  db.prepare(
    `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, source, profile_id)
   VALUES (?, 82, 18, 55, 'withings', ?)`
  ).run(fitnessRecent, fitnessId);
  {
    const squatActivity = Number(
      db
        .prepare(
          "INSERT INTO activities (date, type, title, profile_id) VALUES (?, 'strength', 'Fitness log (e2e)', ?)"
        )
        .run(fitnessRecent, fitnessId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, 'Back Squat', 1, 140, 3, 0)`
    ).run(squatActivity);
    const holdActivity = Number(
      db
        .prepare(
          "INSERT INTO activities (date, type, title, profile_id) VALUES (?, 'strength', 'Fitness log (e2e)', ?)"
        )
        .run(fitnessRecent, fitnessId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, duration_sec, warmup)
     VALUES (?, 'Plank', 1, 90, 0)`
    ).run(holdActivity);
  }
  seedMemberLogin(E2E_LOGIN_FITNESS, fitnessId);

  const fitnessSeniorId = fixtureProfileId(FITNESS_SENIOR_PROFILE);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
  ).run(fitnessSeniorId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1954-03-01')`
  ).run(fitnessSeniorId);
  seedMemberLogin(E2E_LOGIN_FITNESS_SENIOR, fitnessSeniorId);

  // A dedicated ADULT profile for the mobility spec (#840): sex + birthdate so the
  // fitness-norms percentile gate opens, plus a LOW sit-and-reach vital so the Training
  // overview's Mobility section renders a deficit→habit SUGGESTION (a Legs mobility habit).
  // NO seeded recovery session / mobility_region target — the log bar starts empty and the
  // suggestion is present; the spec owns its own move toggles. Idempotent: clear the
  // profile's recovery activities + mobility_region targets so a reused server re-plants a
  // clean slate.
  const mobilityId = fixtureProfileId(MOBILITY_PROFILE);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'male')`
  ).run(mobilityId);
  db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1985-01-01')`
  ).run(mobilityId);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND type = 'recovery'`
  ).run(mobilityId);
  db.prepare(
    `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'mobility_region'`
  ).run(mobilityId);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Sit-and-Reach'`
  ).run(mobilityId);
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, value_num, unit, canonical_name)
   VALUES (?, ?, 'vitals', 'Sit-and-Reach', 15, 'cm', 'Sit-and-Reach')`
  ).run(mobilityId, today(mobilityId));
  seedMemberLogin(E2E_LOGIN_MOBILITY, mobilityId);

  // A dedicated profile with a LIVE, in-progress strength session (issue #921): an
  // activity today with a start_time (~40 min ago), NO end_time, and a fresh
  // updated_at (auto-save timestamp) — so getWorkoutPresence reads `active`. Drives
  // the workout dock hydration/reopen and the household presence chip. Idempotent:
  // clear the profile's activities first so a reused server re-plants exactly one.
  const presenceId = fixtureProfileId(PRESENCE_PROFILE);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(presenceId);
  {
    const now = clockNow();
    const startIso = new Date(now.getTime() - 40 * 60_000);
    // start_time is HH:MM wall clock IN THE PROFILE'S TIMEZONE (see
    // lib/workout-presence.ts) — a bare UTC slice diverges from it by the pinned
    // offset (top of file), so derive the wall time through the profile's zone.
    const startHHMM = zonedDateParts(getTimezone(presenceId), startIso).hhmm;
    db.prepare(
      `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, created_at, updated_at, source)
     VALUES (?, ?, 'strength', 'Push day', ?, NULL, ?, ?, NULL)`
    ).run(
      presenceId,
      today(presenceId),
      startHHMM,
      utcSqlString(startIso),
      utcSqlString(now)
    );
  }
  seedMemberLogin(E2E_LOGIN_PRESENCE, presenceId);

  // A dedicated profile with a JUST-FINISHED strength session (#924): a manual
  // activity today with a start_time AND a recent end_time (~8 min ago) + two working
  // sets that hit their rep target, plus a prior session of the same lift a week
  // earlier so the recap flags a PR. So getWorkoutPresence reads `finished` and the
  // dashboard renders the finished-window recap card. Idempotent: clear activities first.
  const recapId = fixtureProfileId(RECAP_PROFILE);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(recapId);
  {
    const now = clockNow();
    const startIso = new Date(now.getTime() - 55 * 60_000);
    const endIso = new Date(now.getTime() - 8 * 60_000);
    // Prior session a week earlier — the baseline the finished session beats.
    const priorId = Number(
      db
        .prepare(
          `INSERT INTO activities
           (profile_id, date, type, title, duration_min, source)
         VALUES (?, ?, 'strength', 'Bench day', 45, NULL)`
        )
        .run(recapId, shiftDateStr(today(recapId), -7)).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, target_reps)
       VALUES (?, 'Bench Press', 1, 60, 5, 5)`
    ).run(priorId);
    // Today's just-finished session: a warmup + two working sets at 65 kg × 5 (PR).
    const finishedId = Number(
      db
        .prepare(
          `INSERT INTO activities
           (profile_id, date, type, title, duration_min, start_time, end_time, created_at, updated_at, source)
         VALUES (?, ?, 'strength', 'Push day', 47, ?, ?, ?, ?, NULL)`
        )
        .run(
          recapId,
          today(recapId),
          // Wall clock in the profile's timezone, NOT a UTC slice: presence
          // reconstructs the end instant via zonedWallTimeToUtc, so a UTC slice
          // reads 60×offset minutes off under the pinned instance timezone and
          // pushed the ~8-min-ago finish outside FINISHED_WINDOW_MIN.
          zonedDateParts(getTimezone(recapId), startIso).hhmm,
          zonedDateParts(getTimezone(recapId), endIso).hhmm,
          utcSqlString(startIso),
          utcSqlString(endIso)
        ).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, target_reps, warmup)
       VALUES (?, 'Bench Press', 1, 40, 8, NULL, 1),
              (?, 'Bench Press', 2, 65, 5, 5, 0),
              (?, 'Bench Press', 3, 65, 5, 5, 0)`
    ).run(finishedId, finishedId, finishedId);
  }
  seedMemberLogin(E2E_LOGIN_RECAP, recapId);
}

// ── Food-log slot-aware ranking + N-week habit trend ──
export function seedFoodSlots(): void {
  // ── Food-log slot-aware ranking + N-week habit trend fixture (#950 / #954) ────
  // A dedicated adult profile (no birthdate) whose per-tap food_log_events ledger is
  // slot-SKEWED: exactly one dominant encourage group per window (whole_grains at
  // breakfast, fatty_fish at lunch, berries in the evening). Default timezone is UTC and
  // the default slot boundaries are 11:00/15:00, so the 08:00Z / 12:00Z / 18:00Z taps
  // land in Morning / Midday / Evening — whatever slot the e2e wall clock is in, the
  // one-tap bar's lead matches the slot chip. Idempotent: hard-clear the profile's
  // food_log + food_log_events + food_group targets so a reused server always starts from
  // this exact skew.
  const foodSlotId = fixtureProfileId(FOOD_SLOT_PROFILE);
  // Opt this profile OUT of the pinned instance timezone (top of file): its taps
  // below are stamped at fixed UTC wall-times (08/12/18Z) designed against the
  // UTC slot boundaries this comment block describes, and the spec's
  // whatever-slot-now-is assertion is hour-robust by design — pinning would shift
  // the tap→slot mapping instead of stabilizing anything.
  setTimezone(foodSlotId, "UTC");
  const foodSlotAnchor = today(foodSlotId);
  db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(foodSlotId);
  db.prepare(`DELETE FROM food_log_events WHERE profile_id = ?`).run(
    foodSlotId
  );
  db.prepare(
    `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'food_group'`
  ).run(foodSlotId);
  {
    const fLog = db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
    );
    const fEvent = db.prepare(
      `INSERT INTO food_log_events (profile_id, group_key, date, logged_at) VALUES (?, ?, ?, ?)`
    );
    const log = (date: string, group: string, n: number, hourZ: string) => {
      fLog.run(foodSlotId, date, group, n);
      for (let i = 0; i < n; i++)
        fEvent.run(foodSlotId, group, date, `${date}T${hourZ}Z`);
    };
    // 8 weeks so the habit trend has real history. One dominant group per slot each day,
    // plus fatty_fish twice a week at lunch (its 2×/week habit target).
    for (let d = 55; d >= 0; d--) {
      const date = shiftDateStr(foodSlotAnchor, -d);
      log(date, "whole_grains", 1, "08:00:00"); // morning dominant
      log(date, "berries", 1, "18:00:00"); // evening dominant
      if (d % 7 === 1 || d % 7 === 4) log(date, "fatty_fish", 1, "12:00:00"); // midday dominant (2×/week)
    }
    // A backdated "fatty fish 2×/week" habit → a real multi-week consistency trend (#954).
    // Created 63 days ago (before the whole 8-week / 56-day trend window) so every cell is
    // applicable — no not-applicable boundary cell to make the strip look like a cold start.
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week, created_at)
       VALUES (?, 'food_group', 'fatty_fish', 2, ?)`
    ).run(foodSlotId, `${shiftDateStr(foodSlotAnchor, -63)} 09:00:00`);
    // A freshly-created "leafy greens 3×/week" habit → an HONEST cold-start trend (weeks
    // before it existed render not-applicable, not misses). created_at defaults to now.
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'food_group', 'leafy_greens', 3)`
    ).run(foodSlotId);
  }
  seedMemberLogin(E2E_LOGIN_FOODSLOT, foodSlotId, "write");
  console.log(
    `e2e: seeded food-slot ranking + habit-trend fixture — profile ${foodSlotId} (${FOOD_SLOT_PROFILE}) (#950/#954)`
  );
}

// ── Deep-linked food quick-log: the protein control's slice point ──
export function seedFoodPinSplit(): void {
  // ── The pinned deep link vs the ranked protein entry (#2061) ─────────────────
  // A dedicated adult profile with NO food log — so the one ranking is the curated
  // catalog order and every rank here is deterministic — carrying two things: a protein
  // quick-add preset (what makes a profile a protein TRACKER, so the reserved protein
  // entry is ranked mid-list and the quick-entry overlay renders the grams control) and
  // an ongoing protocol whose practice is a weekly FOOD_PIN_GROUP floor. That protocol's
  // "Log servings" button opens the food bar with the group pinned to the front of the
  // quick rows, which is the only way the rendered order stops matching the ranked one.
  // Idempotent: every fixture-owned row is cleared first, so a reused server re-seeds
  // into exactly this state.
  const pinId = fixtureProfileId(FOOD_PIN_PROFILE);
  const pinAnchor = today(pinId);
  db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(pinId);
  db.prepare(`DELETE FROM food_log_events WHERE profile_id = ?`).run(pinId);
  db.prepare(`DELETE FROM protein_log WHERE profile_id = ?`).run(pinId);
  db.prepare(`DELETE FROM protocols WHERE profile_id = ?`).run(pinId);
  db.prepare(`DELETE FROM frequency_targets WHERE profile_id = ?`).run(pinId);
  // The preset the bar re-offers, and the tracker bit the ranking reads.
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value)
     VALUES (?, 'protein_quickadd_last', '25')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(pinId);
  const pinTargetId = Number(
    db
      .prepare(
        `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week, created_at)
         VALUES (?, 'food_group', ?, 2, ?)`
      )
      .run(pinId, FOOD_PIN_GROUP, `${shiftDateStr(pinAnchor, -28)} 09:00:00`)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO protocols
       (profile_id, name, start_date, end_date, notes, outcome_keys,
        frequency_target_id, owns_frequency_target)
     VALUES (?, 'Red meat 2×/week (e2e)', ?, NULL, NULL, ?, ?, 1)`
  ).run(pinId, shiftDateStr(pinAnchor, -28), JSON.stringify([]), pinTargetId);
  seedMemberLogin(E2E_LOGIN_FOODPIN, pinId, "write");
  console.log(
    `e2e: seeded deep-linked food pin fixture — profile ${pinId} (${FOOD_PIN_PROFILE}) (#2061)`
  );
}
