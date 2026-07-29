// e2e seed fixtures — dashboard domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { db, today } from "../../lib/db";
import { now as clockNow } from "../../lib/clock";
import {
  shiftDateStr,
  utcSqlString,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "../../lib/date";
import {
  setDashboardLayout,
  setWeekMode,
  getTimezone,
  setTimezone,
} from "../../lib/settings";
import {
  resetOnboardingProfileRows,
  writeWizardEntryState,
} from "../onboarding-reset";
import {
  E2E_LOGIN_EMPTY_TRAINING,
  E2E_LOGIN_SLEEP_EDIT,
  E2E_LOGIN_SLEEP_PHASE,
  E2E_LOGIN_SLEEP_SEGMENTED,
  E2E_LOGIN_MENTAL,
  MENTAL_HEALTH_PROFILE,
  E2E_LOGIN_SUBSTANCE,
  SUBSTANCE_PROFILE,
  E2E_LOGIN_PREVENTIVE,
  PREVENTIVE_PROFILE,
  E2E_LOGIN_CRISIS,
  CRISIS_PROFILE,
  E2E_LOGIN_NOWSTRIP,
  NOW_STRIP_PROFILE,
  NOW_STRIP_APPOINTMENT,
  E2E_LOGIN_NOWSAFETY,
  NOW_SAFETY_PROFILE,
  E2E_LOGIN_FOLDREOPEN,
  FOLD_REOPEN_PARENT_PROFILE,
  FOLD_REOPEN_KID_A_PROFILE,
  FOLD_REOPEN_KID_B_PROFILE,
  FOLD_REOPEN_KID_A_SITUATION,
  FOLD_REOPEN_KID_B_SITUATION,
  E2E_LOGIN_FOLDTAIL,
  FOLD_TAIL_PARENT_PROFILE,
  FOLD_TAIL_KID_PROFILE,
  E2E_LOGIN_FOLDWELL,
  FOLD_WELL_PARENT_PROFILE,
  FOLD_WELL_KID_PROFILE,
  CRISIS_OVERRIDE_LABEL,
  CRISIS_OVERRIDE_CONTACT,
  E2E_LOGIN_DAILY,
  DAILY_LOOP_PROFILE,
  E2E_LOGIN_WEIGHT_QA,
  WEIGHT_QUICKADD_PROFILE,
  E2E_LOGIN_NAV_FEMALE,
  NAV_FEMALE_PROFILE,
  E2E_LOGIN_NAV_MALE,
  NAV_MALE_PROFILE,
  E2E_LOGIN_ROUTINE,
  E2E_LOGIN_ROUTINE_BUILDER,
  E2E_LOGIN_ROUTINE_DELOAD,
  E2E_LOGIN_ONBOARDING,
  E2E_LOGIN_ONBOARDING_CAREGIVER,
  EMPTY_TRAINING_PROFILE,
  SLEEP_EDIT_PROFILE,
  SLEEP_PHASE_PROFILE,
  SLEEP_SEGMENTED_PROFILE,
  ROUTINE_BUILDER_PROFILE,
  ROUTINE_DELOAD_PROFILE,
  ROUTINE_PROFILE,
  ONBOARDING_CAREGIVER_PROFILE,
  ONBOARDING_PROFILE,
  E2E_LOGIN_WHATSNEW,
  WHATS_NEW_PROFILE,
  NO_GEAR_PROFILE,
  DUP_REVIEW_PROFILE,
} from "../fixture-logins";
import { adoptTemplate, activateRoutine } from "../../lib/routines";
import { collectAttentionModel, dismissFinding } from "../../lib/queries";
import {
  PROFILE_ID,
  ins,
  seedMemberLogin,
  fixtureProfileId,
  grantProfile,
} from "./common";

// ── Weekly recap + milestones ──
export function seedWeeklyRecap(): void {
  // ── Weekly recap + milestones fixtures (issue #32) ────────────────────────────
  // The Weekly-recap dashboard widget is off by default (it stays quiet), so pin a
  // layout for profile 1 that makes ONLY it a known-visible widget; every other
  // widget falls back to its registry default. This gives the recap spec a
  // deterministic card to assert on. Synthetic — no PHI.
  setDashboardLayout(PROFILE_ID, { order: ["weekly-recap"], hidden: [] });

  // Pin profile 1 to rolling week_mode so the recap covers a trailing seven days
  // (issue #223): the recap now honors week_mode, and under the default calendar
  // mode the current-week window would shrink toward the week-start day, so on some
  // weekdays the last seeded workout (daysAgo(1)) would fall outside it and the card
  // would render its empty-state nudge instead of the summary rows. Rolling keeps
  // the spec deterministic across every CI run day. Calendar-mode window behavior is
  // covered by the pure unit tests (lib/__tests__/week-window.test.ts).
  setWeekMode(PROFILE_ID, "rolling");

  // A fired milestone so the Timeline's `milestone` category has a deterministic
  // entry to render (the milestone engine also fires live on the notify tick, but
  // e2e never runs that). achieved_on is today so it lands at the top of the feed.
  const milestoneDate = clockNow().toISOString().slice(0, 10);
  db.prepare(
    `DELETE FROM milestones WHERE profile_id = ? AND key = 'workouts:50'`
  ).run(PROFILE_ID);
  db.prepare(
    `INSERT INTO milestones (profile_id, key, kind, threshold, title, detail, achieved_on)
   VALUES (?, 'workouts:50', 'workouts', 50, '50 workouts logged',
           'You''ve logged 50 workouts. Consistency is the point — nice going.', ?)`
  ).run(PROFILE_ID, milestoneDate);

  console.log(
    "e2e: seeded weekly-recap dashboard layout + a milestone timeline entry for profile 1"
  );
}

// ── Time-aware Today panel ──
export function seedTodayPanel(): void {
  // ── Time-aware Today panel fixtures (issue #852 item 1) ──────────────────────
  // Two SCHEDULED, active medications whose alphabetical order REVERSES their bucket
  // order: "Zeta Morning Med" is a MORNING dose, "Alpha Evening Med" an EVENING dose.
  // Data/alphabetical order would put Alpha first; the shared doseSortKey ordering must
  // put Zeta (Morning) first — the same order Upcoming derives. Both daily + active with
  // no taken-log today, so they surface as due on the Medications Today panel AND in
  // Upcoming. Fully synthetic, no rxcui (no interaction/food dataset hit). Idempotent.
  for (const [name, timeOfDay] of [
    ["Zeta Morning Med (e2e)", "morning"],
    ["Alpha Evening Med (e2e)", "evening"],
  ] as const) {
    db.prepare(
      `DELETE FROM intake_items WHERE profile_id = ? AND name = ?`
    ).run(PROFILE_ID, name);
    const medId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
           (profile_id, name, condition, priority, kind, active, as_needed)
         VALUES (?, ?, 'daily', 'low', 'medication', 1, 0)`
        )
        .run(PROFILE_ID, name).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tablet', ?, 'any', 0)`
    ).run(medId, timeOfDay);
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
     VALUES (?, ?, NULL, NULL, 'e2e Today-order fixture')`
    ).run(medId, shiftDateStr(today(PROFILE_ID), -30));
  }
  console.log(
    `e2e: seeded morning + evening scheduled meds on profile ${PROFILE_ID} for the Today-order spec (#852)`
  );
}

// ── Dashboard "Now" strip + collapsible hero ──
export function seedNowStrip(): void {
  const iso = (d: Date) => d.toISOString();
  // ── Dashboard "Now" strip + collapsible hero fixtures (issue #1413) ──────────
  // A profile whose dashboard deterministically shows BOTH halves of #1413: a
  // just-finished session (the Now strip's top-ranked card, same shape as the RECAP
  // fixture above) and one appointment scheduled TODAY, which gives the
  // "Needs attention" hero a stable non-zero count for the collapse test.
  //
  // Why a just-finished workout rather than relying on the clock: the e2e run pins
  // local time to 13:mm (e2e/pinned-timezone.ts), which sits inside the default 13:00
  // Midday meal anchor — so `nutrition-today` would fire only if this profile had
  // nutrition data, and the morning/evening signals never fire at all. The recap
  // signal is time-of-day independent (a 60-minute window off the frozen clock), so
  // it is the one the spec can assert without depending on the run's start hour.
  // Idempotent: clear activities + appointments first.
  const nowStripId = fixtureProfileId(NOW_STRIP_PROFILE);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(nowStripId);
  db.prepare(`DELETE FROM appointments WHERE profile_id = ?`).run(nowStripId);
  {
    const now = clockNow();
    const startIso = new Date(now.getTime() - 50 * 60_000);
    const endIso = new Date(now.getTime() - 6 * 60_000);
    const finishedId = Number(
      db
        .prepare(
          `INSERT INTO activities
           (profile_id, date, type, title, duration_min, start_time, end_time, created_at, updated_at, source)
         VALUES (?, ?, 'strength', 'Pull day', 44, ?, ?, ?, ?, NULL)`
        )
        .run(
          nowStripId,
          today(nowStripId),
          // Wall clock in the profile's timezone, not a UTC slice — presence
          // reconstructs the end instant via zonedWallTimeToUtc (the #924 note on
          // the RECAP fixture above applies verbatim).
          zonedDateParts(getTimezone(nowStripId), startIso).hhmm,
          zonedDateParts(getTimezone(nowStripId), endIso).hhmm,
          utcSqlString(startIso),
          utcSqlString(endIso)
        ).lastInsertRowid
    );
    // Working sets so the recap has something to say (the page gates the card on
    // totalWorkingSets > 0).
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, target_reps)
       VALUES (?, 'Barbell Row', 1, 55, 8, 8),
              (?, 'Barbell Row', 2, 55, 8, 8)`
    ).run(finishedId, finishedId);
    // One appointment TODAY → a due-today attention item, so the hero has a count.
    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, title, location, status)
     VALUES (?, ?, ?, 'Test Clinic (e2e)', 'scheduled')`
    ).run(nowStripId, `${today(nowStripId)} 16:00`, NOW_STRIP_APPOINTMENT);

    // A bodyweight + a couple of protein-bearing servings today, so the
    // `nutrition-today` widget has real content rather than its onboarding CTA.
    // The e2e clock is pinned to 13:mm local (e2e/pinned-timezone.ts), which sits
    // inside the default 13:00 Midday intake anchor — so this makes the SECOND
    // strip card fire deterministically, exercising the two-card band (its
    // 2-column layout and the NOW_STRIP_CAP) rather than only the single-card path.
    const nowStripDay = today(nowStripId);
    db.prepare(
      `INSERT OR IGNORE INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 78)`
    ).run(nowStripId, nowStripDay);
    for (const [slug, servings] of [
      ["poultry", 2],
      ["eggs", 1],
    ] as const) {
      db.prepare(
        `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
      ).run(nowStripId, nowStripDay, slug, servings);
    }
  }
  seedMemberLogin(E2E_LOGIN_NOWSTRIP, nowStripId);

  // The safety-locked counterpart: a SEVERE PHQ-9 reading with a positive item 9
  // (index 8, 0-based). Either alone escalates (crisisDecision = severe || selfHarm);
  // seeding both keeps the fixture robust to a band-threshold edit. That makes
  // mentalHealthCrisisItems emit a `suppressionPolicy: "safety-ungated"` attention
  // item, which attentionHeroState must refuse to collapse (#449/#942).
  // Synthetic score on a fictional profile — no PHI. Idempotent.
  const nowSafetyId = fixtureProfileId(NOW_SAFETY_PROFILE);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND category = 'instrument'`
  ).run(nowSafetyId);
  {
    const scoreId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
           (date, category, name, value, value_num, unit, canonical_name, profile_id)
         VALUES (?, 'instrument', 'PHQ-9', '22', 22, NULL, 'PHQ-9', ?)`
        )
        .run(today(nowSafetyId), nowSafetyId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO instrument_responses (profile_id, medical_record_id, item_index, answer)
     VALUES (?, ?, 8, 2)`
    ).run(nowSafetyId, scoreId);
  }
  seedMemberLogin(E2E_LOGIN_NOWSAFETY, nowSafetyId);

  console.log(
    `e2e: seeded #1413 Now-strip fixtures — profile ${nowStripId} (${NOW_STRIP_PROFILE}, finished session + due appointment) and profile ${nowSafetyId} (${NOW_SAFETY_PROFILE}, safety-locked hero)`
  );

  // Truly empty, isolated profiles for the goal-based onboarding paths (#719).
  // Explicit state opts them into onboarding; every other fixture profile without
  // the marker behaves as an existing profile and is never forced through setup.
  // The reset/entry-state functions are shared with the spec's per-repeat reset
  // (e2e/onboarding-reset.ts) so boot-time seed and mid-suite reset can't drift.
  const onboardingId = fixtureProfileId(ONBOARDING_PROFILE);
  resetOnboardingProfileRows(db, onboardingId);
  writeWizardEntryState(db, onboardingId);
  seedMemberLogin(E2E_LOGIN_ONBOARDING, onboardingId);

  const caregiverOnboardingId = fixtureProfileId(ONBOARDING_CAREGIVER_PROFILE);
  resetOnboardingProfileRows(db, caregiverOnboardingId);
  writeWizardEntryState(db, caregiverOnboardingId);
  seedMemberLogin(E2E_LOGIN_ONBOARDING_CAREGIVER, caregiverOnboardingId);

  // The no-gear and dup-review fixture profiles are created by ./nutrition
  // (seedNutritionTrio), which runs earlier — fixtureProfileId resolves them by name.
  const noGearId = fixtureProfileId(NO_GEAR_PROFILE);
  const dupReviewId = fixtureProfileId(DUP_REVIEW_PROFILE);

  // One logged activity so the Training "Log" tab renders the Journal (with its "New
  // activity" button) instead of the empty state — the spec opens that add form to
  // reach the equipment picker's empty-state door. An activity creates no equipment,
  // so the profile's inventory stays empty. Idempotent by external_id.
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:nogear-seed'`
  ).run(noGearId);
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, source, external_id, edited)
   VALUES (?, ?, 'cardio', 'E2E No Gear Walk', 20, 'manual', 'e2e:nogear-seed', 0)`
  ).run(noGearId, today(noGearId));
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(dupReviewId);
  const insDupWeighIn = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
   VALUES (?, '2026-06-15', ?, NULL)`
  );
  insDupWeighIn.run(dupReviewId, 80.2);
  insDupWeighIn.run(dupReviewId, 81.4);
  // Issue #1615: two CROSS-SOURCE days on the same profile. body_metrics keeps one
  // row per (profile_id, date, source) on purpose (#14), so two devices covering one
  // day is normal storage — when they AGREE there is nothing to decide and the day
  // must not reach Review, while a real DISAGREEMENT still must. Distinct dates from
  // the manual pair above so each spec assertion scopes to its own day; the whole
  // profile's body_metrics are cleared just above, so these are collision-free.
  const insDupSourced = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
   VALUES (?, ?, ?, ?)`
  );
  insDupSourced.run(dupReviewId, "2026-06-16", 55, "health-connect");
  insDupSourced.run(dupReviewId, "2026-06-16", 55, "oura");
  insDupSourced.run(dupReviewId, "2026-06-17", 55, "health-connect");
  insDupSourced.run(dupReviewId, "2026-06-17", 56, "oura");
  console.log(
    `e2e: seeded a same-source (two manual weigh-ins) duplicate plus agreeing/disagreeing cross-source days on profile ${dupReviewId} (#531/#1615)`
  );

  // A dedicated ADULT profile for the routine-BUILDER specs (#739), SEPARATE from the
  // routine-recommendation fixture below: that spec needs its profile's routine to stay
  // ACTIVE (the Today's-session card), while the builder spec activates/deactivates
  // routines — sharing a profile would let one spec break the other. Activating a
  // routine also REPLACES the profile's training-scope frequency_targets, which is why
  // neither fixture is profile 1 (whose seeded PPL targets other specs rely on). Seed a
  // clean slate — no routines — plus two training-scope frequency targets so the
  // activate-confirm dialog (which only appears when there ARE targets to replace) is
  // exercised. Idempotent.
  const routineBuilderProfileId = fixtureProfileId(ROUTINE_BUILDER_PROFILE);
  seedMemberLogin(E2E_LOGIN_ROUTINE_BUILDER, routineBuilderProfileId);
  db.prepare(
    `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id WHERE r.profile_id = ?)`
  ).run(routineBuilderProfileId);
  db.prepare(
    `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?)`
  ).run(routineBuilderProfileId);
  db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(
    routineBuilderProfileId
  );
  db.prepare(
    `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind IN ('region','group','type')`
  ).run(routineBuilderProfileId);
  const insRoutineTarget = db.prepare(
    `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
     VALUES (?, ?, ?, ?)`
  );
  insRoutineTarget.run("group", "Upper", 2, routineBuilderProfileId);
  insRoutineTarget.run("group", "Lower", 2, routineBuilderProfileId);
  console.log(
    `e2e: seeded routine-builder fixture profile ${routineBuilderProfileId} (${ROUTINE_BUILDER_PROFILE}) with two training-scope frequency targets (#739)`
  );

  // A dedicated ADULT profile with NOTHING logged (#809): the brand-new/post-onboarding
  // first-run state that every other fixture profile lacks. Kept activity-free so the
  // training-first-run spec can assert the Journal's first-run empty variant renders the
  // action row (Start workout + New activity, no Repeat last). Idempotent: hard-clear any
  // activities (and their sets) on a reused server so the profile can never drift out of
  // its empty contract.
  const emptyTrainingId = fixtureProfileId(EMPTY_TRAINING_PROFILE);
  db.prepare(
    `DELETE FROM exercise_sets WHERE activity_id IN (
     SELECT id FROM activities WHERE profile_id = ?)`
  ).run(emptyTrainingId);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(
    emptyTrainingId
  );
  seedMemberLogin(E2E_LOGIN_EMPTY_TRAINING, emptyTrainingId);
  console.log(
    `e2e: seeded activity-free first-run fixture profile ${emptyTrainingId} (${EMPTY_TRAINING_PROFILE}) for the Training Log empty state (#809)`
  );

  // Dedicated write surface for historical sleep/mood editing. The spec seeds and
  // clears its own observation rows around the test; boot only guarantees the
  // isolated write-granted login/profile exists.
  const sleepEditId = fixtureProfileId(SLEEP_EDIT_PROFILE);
  db.prepare(`DELETE FROM mood_logs WHERE profile_id = ?`).run(sleepEditId);
  db.prepare(`DELETE FROM metric_samples WHERE profile_id = ?`).run(
    sleepEditId
  );
  seedMemberLogin(E2E_LOGIN_SLEEP_EDIT, sleepEditId);
  console.log(
    `e2e: seeded isolated historical sleep/mood editor profile ${sleepEditId} (${SLEEP_EDIT_PROFILE})`
  );

  // Dedicated, read-only post-noon-wake fixture (#1190). Pin UTC so the intended
  // wall-clock labels are explicit and independent of the suite's run-hour timezone
  // pin. Rebuild its tiny observation set on every seed; no browser test writes or
  // cleans this profile, so fully-parallel and --repeat-each runs cannot contend.
  const sleepPhaseId = fixtureProfileId(SLEEP_PHASE_PROFILE);
  setTimezone(sleepPhaseId, "UTC");
  db.prepare(`DELETE FROM metric_samples WHERE profile_id = ?`).run(
    sleepPhaseId
  );
  const sleepPhaseToday = today(sleepPhaseId);
  const lateRiserDate = shiftDateStr(sleepPhaseToday, -1);
  const daytimeSleepDate = shiftDateStr(sleepPhaseToday, -2);
  const insertSleepPhase = db.prepare(
    `INSERT INTO metric_samples
     (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'oura', 'sleep_min', ?, ?, ?, ?)`
  );
  insertSleepPhase.run(
    sleepPhaseId,
    lateRiserDate,
    iso(zonedWallTimeToUtc("UTC", lateRiserDate, "04:00")),
    iso(zonedWallTimeToUtc("UTC", lateRiserDate, "13:00")),
    540
  );
  insertSleepPhase.run(
    sleepPhaseId,
    daytimeSleepDate,
    iso(zonedWallTimeToUtc("UTC", daytimeSleepDate, "08:00")),
    iso(zonedWallTimeToUtc("UTC", daytimeSleepDate, "16:00")),
    480
  );
  seedMemberLogin(E2E_LOGIN_SLEEP_PHASE, sleepPhaseId, "read");
  console.log(
    `e2e: seeded read-only late/daytime sleep-phase profile ${sleepPhaseId} (${SLEEP_PHASE_PROFILE}, #1190)`
  );

  // Dedicated, read-only SEGMENTED-night fixture (#1191/#1283). Every wake-day is a
  // biphasic 23:00→03:00 (4h) + 04:00→08:00 (4h) pair — neither block reaches the 6h
  // main-sleep floor — so the merge must read them as ONE ~8h night (bed 23:00 → wake
  // 08:00, no nap), the behavior f53892f shipped with no browser test for the rendered
  // hero/tile. Pin UTC so the wall-clock labels are explicit; the latest wake-day is
  // "today" so the hero + dashboard tile both render it. Rebuilt every seed; no browser
  // test writes or cleans this profile, so parallel / --repeat-each runs cannot contend.
  const sleepSegmentedId = fixtureProfileId(SLEEP_SEGMENTED_PROFILE);
  setTimezone(sleepSegmentedId, "UTC");
  db.prepare(`DELETE FROM metric_samples WHERE profile_id = ?`).run(
    sleepSegmentedId
  );
  const sleepSegmentedToday = today(sleepSegmentedId);
  const insertSegmentedSleep = db.prepare(
    `INSERT INTO metric_samples
     (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'health-connect', 'sleep_min', ?, ?, ?, 240)`
  );
  for (let offset = 14; offset >= 0; offset--) {
    const wakeDay = shiftDateStr(sleepSegmentedToday, -offset);
    const bedDay = shiftDateStr(wakeDay, -1);
    // First fragment: 23:00 the prior evening → 03:00 the wake-day (4h).
    insertSegmentedSleep.run(
      sleepSegmentedId,
      wakeDay,
      iso(zonedWallTimeToUtc("UTC", bedDay, "23:00")),
      iso(zonedWallTimeToUtc("UTC", wakeDay, "03:00"))
    );
    // Second fragment after a 1h awake gap: 04:00 → 08:00 the same wake-day (4h).
    insertSegmentedSleep.run(
      sleepSegmentedId,
      wakeDay,
      iso(zonedWallTimeToUtc("UTC", wakeDay, "04:00")),
      iso(zonedWallTimeToUtc("UTC", wakeDay, "08:00"))
    );
  }
  seedMemberLogin(E2E_LOGIN_SLEEP_SEGMENTED, sleepSegmentedId, "read");
  console.log(
    `e2e: seeded read-only segmented-night profile ${sleepSegmentedId} (${SLEEP_SEGMENTED_PROFILE}, #1191/#1283)`
  );

  // A dedicated, score-free ADULT profile for the mental-health-instruments spec (#716).
  // The spec administers PHQ-9/GAD-7 in-app, so it OWNS every write here. Idempotent:
  // hard-clear any instrument scores (and their per-item answers) on a reused server so
  // the profile can never drift out of its empty contract.
  const mentalHealthId = fixtureProfileId(MENTAL_HEALTH_PROFILE);
  db.prepare(`DELETE FROM instrument_responses WHERE profile_id = ?`).run(
    mentalHealthId
  );
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN ('PHQ-9','GAD-7')`
  ).run(mentalHealthId);
  seedMemberLogin(E2E_LOGIN_MENTAL, mentalHealthId);
  console.log(
    `e2e: seeded score-free mental-health fixture profile ${mentalHealthId} (${MENTAL_HEALTH_PROFILE}) for the instruments spec (#716)`
  );

  // A dedicated, substance-data-free ADULT profile for the substance-use spec (#998).
  // The spec OWNS every write (an AUDIT-C tap-through, an outside DAST-10 total,
  // one-tap drinks, the weekly-cap target). Idempotent: hard-clear its substance
  // rows on a reused server so the profile can never drift out of its empty contract
  // (the spec's own assertions stay relative for --repeat-each).
  const substanceId = fixtureProfileId(SUBSTANCE_PROFILE);
  db.prepare(
    `DELETE FROM instrument_responses WHERE profile_id = ? AND medical_record_id IN (
     SELECT id FROM medical_records WHERE profile_id = ?
       AND canonical_name IN ('AUDIT-C','AUDIT','DAST-10'))`
  ).run(substanceId, substanceId);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN ('AUDIT-C','AUDIT','DAST-10')`
  ).run(substanceId);
  db.prepare(
    `DELETE FROM food_log_events WHERE profile_id = ? AND group_key = 'alcohol'`
  ).run(substanceId);
  db.prepare(
    `DELETE FROM food_log WHERE profile_id = ? AND group_key = 'alcohol'`
  ).run(substanceId);
  // The non-food ledger (#1078: nicotine/cannabis one-tap counts) — same empty
  // contract as the alcohol food-log rows above.
  db.prepare(`DELETE FROM substance_log WHERE profile_id = ?`).run(substanceId);
  db.prepare(
    `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'substance'`
  ).run(substanceId);
  seedMemberLogin(E2E_LOGIN_SUBSTANCE, substanceId);
  console.log(
    `e2e: seeded substance-data-free fixture profile ${substanceId} (${SUBSTANCE_PROFILE}) for the substance-use spec (#998)`
  );

  // A dedicated OLDER-ADULT (sex=female, ~60yo) profile with NO satisfying records, so
  // EVERY preventive screening class stays due on /upcoming — the preventive-deeplinks
  // spec (#1083) reads its rows to prove each class deep-links to the concrete next
  // action (lab/vital/instrument/procedure). Sex + a fixed birthdate drive the age
  // assessor; nothing satisfies any rule (no labs, vitals, instruments, procedures), so
  // the read-only spec is deterministic year-round. Idempotent for a reused server.
  const preventiveDeeplinksId = fixtureProfileId(PREVENTIVE_PROFILE);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(preventiveDeeplinksId);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1966-01-01')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(preventiveDeeplinksId);
  seedMemberLogin(E2E_LOGIN_PREVENTIVE, preventiveDeeplinksId);
  console.log(
    `e2e: seeded record-free preventive fixture profile ${preventiveDeeplinksId} (${PREVENTIVE_PROFILE}) for the deep-links spec (#1083)`
  );

  // A dedicated ADULT profile for the mental-health-visit sensitivity + crisis specs
  // (#997/#996). Calendar feed set to FULL detail (so the spec can prove a
  // mental_health visit STILL renders as "Medical appointment" — the privacy default),
  // plus a per-profile crisis-resources override so the passive surface + inline
  // finding render the profile's own line. The spec OWNS the appointments it books.
  const crisisProfileId = fixtureProfileId(CRISIS_PROFILE);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'calendar_feed_detail', 'full')
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(crisisProfileId);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'crisis_resources', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(
    crisisProfileId,
    JSON.stringify([
      { label: CRISIS_OVERRIDE_LABEL, contact: CRISIS_OVERRIDE_CONTACT },
    ])
  );
  // Idempotent: clear any appointments a prior run's spec booked so the profile keeps
  // a clean contract across a reused server.
  db.prepare(`DELETE FROM appointments WHERE profile_id = ?`).run(
    crisisProfileId
  );
  seedMemberLogin(E2E_LOGIN_CRISIS, crisisProfileId);
  console.log(
    `e2e: seeded crisis/mental-health-visit fixture profile ${crisisProfileId} (${CRISIS_PROFILE}) for #997/#996`
  );

  // A dedicated ADULT profile with an ACTIVE Push/Pull/Legs routine (#740) at
  // position 0 (Push day) and NO recovery data, so the Training overview resolves
  // today's routine session and renders the "Today's session" card without a rest
  // override. Idempotent: reset the routine tables for this profile, then adopt +
  // activate the PPL template fresh (activate resets position to 0 → Push day).
  const routineProfileId = fixtureProfileId(ROUTINE_PROFILE);
  db.prepare(
    `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id
      WHERE r.profile_id = ?
   )`
  ).run(routineProfileId);
  db.prepare(
    `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?
   )`
  ).run(routineProfileId);
  db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(routineProfileId);
  const routineId = adoptTemplate(routineProfileId, "push-pull-legs-6x");
  activateRoutine(routineProfileId, routineId);
  seedMemberLogin(E2E_LOGIN_ROUTINE, routineProfileId);
  console.log(
    `e2e: seeded an active PPL routine on profile ${routineProfileId} (Today's session card, #740)`
  );

  // A dedicated ADULT profile with an ACTIVE PPL routine whose mesocycle places TODAY
  // in the DELOAD week (#741): a 2-week cycle whose started_date is backdated 7 days
  // (weekInCycle = floor(7/7) % 2 = 1 = the last, deload week). No credited sessions in
  // that 7-day span, so the pause re-anchor never trips (gap 7 < 21). SEPARATE from
  // ROUTINE_PROFILE so the #740 recommendation spec's non-deload copy stays intact.
  const deloadProfileId = fixtureProfileId(ROUTINE_DELOAD_PROFILE);
  db.prepare(
    `DELETE FROM routine_slots WHERE routine_day_id IN (
     SELECT rd.id FROM routine_days rd
       JOIN routines r ON r.id = rd.routine_id
      WHERE r.profile_id = ?
   )`
  ).run(deloadProfileId);
  db.prepare(
    `DELETE FROM routine_days WHERE routine_id IN (
     SELECT id FROM routines WHERE profile_id = ?
   )`
  ).run(deloadProfileId);
  db.prepare(`DELETE FROM routines WHERE profile_id = ?`).run(deloadProfileId);
  const deloadRoutineId = adoptTemplate(deloadProfileId, "push-pull-legs-6x");
  activateRoutine(deloadProfileId, deloadRoutineId);
  db.prepare(
    `UPDATE routines SET cycle_weeks = 2, started_date = ? WHERE id = ?`
  ).run(shiftDateStr(today(deloadProfileId), -7), deloadRoutineId);
  seedMemberLogin(E2E_LOGIN_ROUTINE_DELOAD, deloadProfileId);
  console.log(
    `e2e: seeded an active PPL routine in its deload week on profile ${deloadProfileId} (#741)`
  );
}

// ── Dashboard daily-loop ──
export function seedDailyLoop(): void {
  // ── Dashboard daily-loop fixture (#1221) ──────────────────────────────────────
  // A dedicated adult female profile carrying one reading in every domain the four new
  // dashboard cards read, all dated to the fixture's "today" so each card renders
  // populated. Read-only in its spec; hard-clear the fixture rows first for a reused
  // server. Synthetic, no PHI.
  {
    const dailyId = fixtureProfileId(DAILY_LOOP_PROFILE);
    const dToday = today(dailyId);

    // Female + premenopausal so cycle tracking is relevant even before the cycle rows
    // below (data wins regardless, but this mirrors a realistic profile).
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
    ).run(dailyId);
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value)
     VALUES (?, 'reproductive_status', 'premenopausal')`
    ).run(dailyId);

    // Body composition: a recent weigh-in (the protein target's mass) + resting HR (two
    // readings so the Latest-vitals card shows a resting-HR trend arrow).
    db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(dailyId);
    const insBm = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:daily-loop')`
    );
    insBm.run(dailyId, shiftDateStr(dToday, -3), 64.0, 60);
    insBm.run(dailyId, dToday, 63.6, 58);

    // Steps: today + a trailing week (additive; one source per day) so the Steps-today
    // card shows today vs the 7-day average with a direction arrow.
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'steps'`
    ).run(dailyId);
    const insSteps = db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', 'steps', ?, ?, ?, ?)`
    );
    for (const [ago, steps] of [
      [7, 6800],
      [6, 7200],
      [5, 8100],
      [4, 6500],
      [3, 7700],
      [2, 8300],
      [1, 7100],
      [0, 9400], // today, above the trailing average → "up"
    ] as const) {
      const day = shiftDateStr(dToday, -ago);
      insSteps.run(dailyId, day, `${day}T00:00:00Z`, `${day}T23:59:59Z`, steps);
    }

    // Blood pressure: a recent pair of readings (systolic + diastolic) stored as
    // biomarker medical_records, so the Latest-vitals card shows "118/76" with a trend.
    db.prepare(
      `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN ('Blood Pressure Systolic', 'Blood Pressure Diastolic')`
    ).run(dailyId);
    const insBp = db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, reference_range, value_num, canonical_name)
     VALUES (?, ?, 'vitals', ?, ?, 'mmHg', ?, ?, ?)`
    );
    for (const [ago, sys, dia] of [
      [10, 122, 80],
      [2, 118, 76],
    ] as const) {
      const day = shiftDateStr(dToday, -ago);
      insBp.run(
        dailyId,
        day,
        "Blood Pressure Systolic",
        String(sys),
        "90-120",
        sys,
        "Blood Pressure Systolic"
      );
      insBp.run(
        dailyId,
        day,
        "Blood Pressure Diastolic",
        String(dia),
        "60-80",
        dia,
        "Blood Pressure Diastolic"
      );
    }

    // Food today: a few protein-bearing food-group servings so getProteinToday reads a
    // non-zero floor against the goal band (the Nutrition-today card).
    db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(dailyId);
    const insFood = db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)`
    );
    for (const [ago, group, servings] of [
      [0, "legumes", 2],
      [0, "fatty_fish", 1],
      [0, "leafy_greens", 2],
      [1, "legumes", 1],
      [1, "red_meat", 1],
    ] as const) {
      insFood.run(dailyId, shiftDateStr(dToday, -ago), group, servings);
    }

    // Cycles: three completed, roughly-regular periods (no open period) so cycle tracking
    // is relevant and a phase + cycle-day derive for the Cycle-phase card.
    db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(dailyId);
    for (const [startAgo, endAgo, flow] of [
      [70, 66, "medium"],
      [42, 38, "medium"],
      [14, 10, "light"],
    ] as const) {
      db.prepare(
        `INSERT INTO cycles (profile_id, period_start, period_end, flow) VALUES (?, ?, ?, ?)`
      ).run(
        dailyId,
        shiftDateStr(dToday, -startAgo),
        shiftDateStr(dToday, -endAgo),
        flow
      );
    }

    // One active PRN medication so the check-in "Take any meds?" branch renders on this
    // profile's dashboard too (the folded quick-log, #1221).
    db.prepare(
      `DELETE FROM intake_items WHERE profile_id = ? AND name = 'Daily Loop PRN (e2e)'`
    ).run(dailyId);
    db.prepare(
      `INSERT INTO intake_items (profile_id, kind, name, active, as_needed)
     VALUES (?, 'medication', 'Daily Loop PRN (e2e)', 1, 1)`
    ).run(dailyId);

    // A custom NON-clinical situation (starts inactive) + a situational supplement keyed
    // to it, so the check-in "Anything going on?" chips include a custom fixture situation
    // and toggling it flips a situational supplement due — the #662 activation line the
    // Part-6 spec asserts on both the check-in card and the Supplements bar. Hard-clear for
    // a reused server (the situations UNIQUE(profile_id, name NOCASE) would otherwise clash).
    db.prepare(
      `DELETE FROM intake_items WHERE profile_id = ? AND name = 'Focus Blend (e2e)'`
    ).run(dailyId);
    db.prepare(
      `DELETE FROM situations WHERE profile_id = ? AND name = 'Deadline (e2e)'`
    ).run(dailyId);
    const dailySitId = Number(
      db
        .prepare(
          `INSERT INTO situations (profile_id, name, active, illness_type)
         VALUES (?, 'Deadline (e2e)', 0, 0)`
        )
        .run(dailyId).lastInsertRowid
    );
    const dailySuppId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
           (profile_id, kind, name, condition, priority, situation, situation_id, active)
         VALUES (?, 'supplement', 'Focus Blend (e2e)', 'situational', 'low', 'Deadline (e2e)', ?, 1)`
        )
        .run(dailyId, dailySitId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'Anytime', 'any', 0)`
    ).run(dailySuppId);

    seedMemberLogin(E2E_LOGIN_DAILY, dailyId, "write");
    console.log(
      `e2e: seeded dashboard daily-loop fixture — profile ${dailyId} (${DAILY_LOOP_PROFILE}) (#1221)`
    );
  }
}

// ── Nav relevance gating + weight quick-add ──
export function seedNavGating(): void {
  // ── Nav relevance gating fixtures (#1042 phase 1) ─────────────────────────────
  // Two dedicated, read-only profiles for the nav-consolidation spec:
  //   • NAV_FEMALE — sex=female + explicit premenopausal status, NO cycle rows, so
  //     the Cycle nav entry shows via cycleTrackingRelevant's status arm; no
  //     vision/dental rows either, so those data-gated entries are hidden for it.
  //   • NAV_MALE — sex=male + adult birthdate, NO cycle rows → Cycle hidden.
  // Idempotent on a reused server: hard-clear the relevance-bearing rows and
  // re-write the profile attributes.
  for (const [profileName, loginName, attrs] of [
    [
      NAV_FEMALE_PROFILE,
      E2E_LOGIN_NAV_FEMALE,
      [
        ["sex", "female"],
        ["reproductive_status", "premenopausal"],
      ],
    ],
    [
      NAV_MALE_PROFILE,
      E2E_LOGIN_NAV_MALE,
      [
        ["sex", "male"],
        ["birthdate", "1988-04-01"],
      ],
    ],
  ] as const) {
    const pid = fixtureProfileId(profileName);
    db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(pid);
    db.prepare(`DELETE FROM optical_prescriptions WHERE profile_id = ?`).run(
      pid
    );
    db.prepare(`DELETE FROM dental_procedures WHERE profile_id = ?`).run(pid);
    db.prepare(
      `DELETE FROM profile_settings WHERE profile_id = ? AND key IN ('sex', 'reproductive_status', 'birthdate', 'age')`
    ).run(pid);
    for (const [key, value] of attrs) {
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)`
      ).run(pid, key, value);
    }
    seedMemberLogin(loginName, pid, "read");
    console.log(
      `e2e: seeded nav-relevance fixture — profile ${pid} (${profileName}) (#1042)`
    );
  }

  // ── Dashboard weight quick-add fixture (#1042 phase 2) ────────────────────────
  // A dedicated adult profile with exactly two seeded weigh-ins so the dashboard
  // weight-trend widget renders its chart state; the weight-quick-add spec owns
  // every non-seed body_metrics row (it clears them itself at test start).
  // Idempotent: hard-clear and re-insert the seed rows.
  const weightQaId = fixtureProfileId(WEIGHT_QUICKADD_PROFILE);
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(weightQaId);
  const weightQaAnchor = today(weightQaId);
  for (const [daysAgo, kg] of [
    [7, 70],
    [3, 70.6],
  ] as const) {
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
     VALUES (?, ?, ?, 'e2e:seed-weight')`
    ).run(weightQaId, shiftDateStr(weightQaAnchor, -daysAgo), kg);
  }
  seedMemberLogin(E2E_LOGIN_WEIGHT_QA, weightQaId, "write");
  console.log(
    `e2e: seeded weight quick-add fixture — profile ${weightQaId} (${WEIGHT_QUICKADD_PROFILE}) (#1042)`
  );
}

// ── "What's new" fixture ──
export function seedWhatsNew(): void {
  // ── #1421 "What's new" fixture ───────────────────────────────────────────────
  // A dedicated member login + profile for the release-notes spec. The page's content
  // comes from the checked-in lib/release-notes.json, so this fixture carries NO health
  // data — it exists purely to own a LOGIN whose `whats_new_seen_date` marker the spec
  // can clear and re-assert per iteration without touching any other session's dot.
  // Idempotent for a reused dev server (fixtureProfileId + seedMemberLogin both upsert).
  {
    const whatsNewId = fixtureProfileId(WHATS_NEW_PROFILE);
    seedMemberLogin(E2E_LOGIN_WHATSNEW, whatsNewId, "write");
    console.log(
      `e2e: seeded what's-new fixture — login ${E2E_LOGIN_WHATSNEW} granted profile ${whatsNewId} (${WHATS_NEW_PROFILE}) (#1421)`
    );
  }
}

// ── Just-recovered household band folds (#1548 / #1549) ──
export function seedHouseholdFolds(): void {
  // Three caregiver fixtures, one per state of the household-history promo's
  // placement — see the header block in e2e/logins/dashboard.ts for what each state
  // is and why the distances (3/5, 10, 20 days) are the whole fixture.
  //
  // ended_at is EXCLUSIVE, so an episode whose LAST ACTIVE day is `daysAgo` days back
  // ends at today - (daysAgo - 1). That is the same arithmetic
  // episodeReopenEligibility measures against, so the fixtures land on the intended
  // side of both the 7-day reopen window and the 14-day promo window rather than on
  // a boundary. Dates derive from today(profileId) — the run's FROZEN clock — never
  // the wall clock.
  //
  // Idempotent for a reused dev server: each profile's episodes are cleared first,
  // and the logins/grants upsert.
  const resolveKid = (
    profileName: string,
    situation: string,
    daysAgo: number
  ): number => {
    const kidId = fixtureProfileId(profileName);
    const on = today(kidId);
    db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(kidId);
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      kidId,
      situation,
      shiftDateStr(on, -(daysAgo + 6)),
      shiftDateStr(on, -(daysAgo - 1))
    );
    return kidId;
  };

  // Parents first so they hold the lowest id and become the acting profile.
  const reopenParentId = fixtureProfileId(FOLD_REOPEN_PARENT_PROFILE);
  db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
    reopenParentId
  );
  const reopenKidAId = resolveKid(
    FOLD_REOPEN_KID_A_PROFILE,
    FOLD_REOPEN_KID_A_SITUATION,
    3
  );
  const reopenKidBId = resolveKid(
    FOLD_REOPEN_KID_B_PROFILE,
    FOLD_REOPEN_KID_B_SITUATION,
    5
  );
  const reopenLoginId = seedMemberLogin(E2E_LOGIN_FOLDREOPEN, reopenParentId);
  grantProfile(reopenLoginId, reopenKidAId);
  grantProfile(reopenLoginId, reopenKidBId);
  // The spec MUTATES this login's dismissal set, so clear it at seed time too — a
  // reused dev server would otherwise start with a previous run's hides in place.
  db.prepare(
    "DELETE FROM login_settings WHERE login_id = ? AND key = 'recently_resolved_dismissed'"
  ).run(reopenLoginId);

  const tailParentId = fixtureProfileId(FOLD_TAIL_PARENT_PROFILE);
  db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
    tailParentId
  );
  const tailKidId = resolveKid(FOLD_TAIL_KID_PROFILE, "Ear infection", 10);
  const tailLoginId = seedMemberLogin(E2E_LOGIN_FOLDTAIL, tailParentId);
  grantProfile(tailLoginId, tailKidId);
  // A household that has already dealt with its standing preventive nudges, so the
  // strip has NO chips (its chips are filtered to members with a NON-ZERO attention
  // count). That is the ORPHAN state the promo's second home has to survive: with no
  // chips, a strip gated on chips alone would not render, and the link the 8–14-day
  // tail is supposed to carry would have nowhere to go. Every fixture profile carries
  // the season's immunization findings by default, so this has to be seeded rather
  // than assumed — dismissed through the SAME suppression bus the product uses, and
  // read back from collectAttentionModel rather than hardcoding suppression keys
  // that shift with the season.
  for (const pid of [tailParentId, tailKidId]) {
    for (const item of collectAttentionModel(pid, today(pid))) {
      dismissFinding(pid, item.key);
    }
  }

  const wellParentId = fixtureProfileId(FOLD_WELL_PARENT_PROFILE);
  db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
    wellParentId
  );
  const wellKidId = resolveKid(
    FOLD_WELL_KID_PROFILE,
    "Hand foot and mouth",
    20
  );
  const wellLoginId = seedMemberLogin(E2E_LOGIN_FOLDWELL, wellParentId);
  grantProfile(wellLoginId, wellKidId);

  console.log(
    `e2e: seeded household band-fold fixtures — reopen ${reopenParentId}/${reopenKidAId}/${reopenKidBId}, tail ${tailParentId}/${tailKidId}, well ${wellParentId}/${wellKidId} (#1548/#1549)`
  );
}
