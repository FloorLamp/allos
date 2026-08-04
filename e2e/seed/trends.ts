// e2e seed fixtures — trends domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { shiftDateStr } from "../../lib/date";
import { createFixtureProfile } from "../fixture-profile";
import { setUserBirthdate, setUserSex } from "../../lib/settings";
import { reconcileFlags } from "../../lib/queries";
import {
  E2E_LOGIN_TRENDS_CURATE,
  TRENDS_CURATE_PROFILE,
  TRENDS_CURATE_EMPTY_ANALYTE,
  E2E_LOGIN_TRENDS_BODY,
  TRENDS_BODY_PROFILE,
  TRENDS_BODY_OLD_DAY,
  E2E_LOGIN_TRENDS_COMPARE,
  TRENDS_COMPARE_PROFILE,
  E2E_LOGIN_TRENDS_READINGS,
  TRENDS_READINGS_PROFILE,
  TRENDS_READINGS_HRV_MANUAL,
  TRENDS_READINGS_HRV_SYNCED,
  E2E_LOGIN_TRENDS_FITNESS,
  TRENDS_FITNESS_PROFILE,
  TRENDS_FITNESS_LIFT,
  TRENDS_FITNESS_OLD_LIFT,
  E2E_LOGIN_TRENDS_RANK_PEDS,
  TRENDS_RANK_PEDS_PROFILE,
  E2E_LOGIN_TRENDS_RANK_GOAL,
  TRENDS_RANK_GOAL_PROFILE,
  E2E_LOGIN_TRENDS_RANK_PLAIN,
  TRENDS_RANK_PLAIN_PROFILE,
  E2E_LOGIN_TRENDS_PIN,
  TRENDS_PIN_PROFILE,
  E2E_LOGIN_DAY_ONE,
  DAY_ONE_PROFILE,
  E2E_LOGIN_METRIC_JUDGMENT,
  METRIC_JUDGMENT_PROFILE,
  METRIC_JUDGMENT_CLINIC_BPM,
  E2E_LOGIN_BIOMARKER_PICKER,
  BIOMARKER_PICKER_PROFILE,
  BIOMARKER_PICKER_OVERDUE,
  BIOMARKER_PICKER_FLAGGED,
  BIOMARKER_PICKER_MEASURED,
} from "../fixture-logins";
import { ins, seedMemberLogin, fixtureProfileId } from "./common";

// ── Trends -> Body mobile overhaul ──
export function seedBodyMobile(): void {
  // ── Trends → Body mobile overhaul fixture (#1067 Phase 1) ─────────────────────
  // A dedicated adult profile with a KNOWN, PARTIAL set of synced body metrics so
  // the chart-jump chips + per-chart anchors are deterministic in the browser:
  //   present → Weight/resting-HR/BMI (body-composition block), Steps, Sleep,
  //             HR (daily)
  //   ABSENT  → hydration / BMR / calories / lean-mass / bone-mass / macros
  // so the spec can assert BOTH that present metrics get a chip (and a `#id` anchor
  // that lands on the card) AND that a chartless metric's chip is hidden. Read-only
  // (spec navigates + scrolls only). Relative dates → never stale; UTC instants
  // (the e2e default timezone) → deterministic regardless of host TZ. Idempotent:
  // hard-clear this profile's fixture rows first.
  {
    const tbId = fixtureProfileId(TRENDS_BODY_PROFILE);
    const tbToday = today(tbId);
    db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(tbId);
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric IN ('steps', 'sleep_min', 'height_cm')`
    ).run(tbId);
    db.prepare(`DELETE FROM hr_minutes WHERE profile_id = ?`).run(tbId);

    // Body-composition block: two manual weigh-ins with resting HR, plus a synced
    // series on the same days. The overlap makes the metric detail page's source
    // comparison and primary-source picker deterministic on mobile.
    const insBm = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:trends-body')`
    );
    // −9d, not −7d: the metric page's rolling windows cover COMPLETE days (#1909),
    // so the 7-day window spans yesterday back through tbToday−7. A weigh-in ON
    // that boundary would land inside all three windows and collapse them into one
    // card, costing the partial-collapse signal the spec measures. Nine days back
    // keeps the old weigh-in outside 7d and inside 30d/90d, which is the point.
    const oldBodyDay = shiftDateStr(tbToday, -9);
    const recentBodyDay = shiftDateStr(tbToday, -1);
    insBm.run(tbId, oldBodyDay, 78.4, 58);
    insBm.run(tbId, recentBodyDay, 77.9, 56);
    const insSyncedBm = db.prepare(
      `INSERT INTO body_metrics
         (profile_id, date, weight_kg, resting_hr, source, notes)
       VALUES (?, ?, ?, ?, 'health-connect', 'e2e:trends-body-source')`
    );
    insSyncedBm.run(tbId, oldBodyDay, 78.6, 59);
    insSyncedBm.run(tbId, recentBodyDay, 78.1, 57);

    // One stable height makes BMI derivable on both weigh-in days. It specifically
    // gives the tile full-series history outside a 1D range, pinning the empty-in-
    // range state instead of letting the derived tile disappear.
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'height_cm', ?, ?, ?, 178)`
    ).run(
      tbId,
      oldBodyDay,
      `${oldBodyDay}T08:00:00Z`,
      `${oldBodyDay}T08:00:00Z`
    );

    // Steps (additive) — three recent days so the chart + chip render and are recent.
    const insSteps = db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', 'steps', ?, ?, ?, ?)`
    );
    for (const [ago, steps] of [
      [2, 8200],
      [1, 9100],
      [0, 7600],
    ] as const) {
      const day = shiftDateStr(tbToday, -ago);
      insSteps.run(tbId, day, `${day}T00:00:00Z`, `${day}T23:59:59Z`, steps);
    }

    // A deep-past sleep night proves a historical range summarizes that night
    // instead of deciding presence from the newer global latest session.
    const oldSleepPrev = shiftDateStr(TRENDS_BODY_OLD_DAY, -1);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 420)`
    ).run(
      tbId,
      TRENDS_BODY_OLD_DAY,
      `${oldSleepPrev}T23:00:00Z`,
      `${TRENDS_BODY_OLD_DAY}T06:00:00Z`
    );

    // One sleep night ending today → the default compact Sleep tile renders.
    const sleepPrev = shiftDateStr(tbToday, -1);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 445)`
    ).run(tbId, tbToday, `${sleepPrev}T23:10:00Z`, `${tbToday}T06:35:00Z`);

    // One day of heart-rate minutes → the "Heart rate (daily avg)" chart renders.
    const insHrTb = db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, 6, 'health-connect')`
    );
    for (let m = 0; m < 20; m++) {
      const mm = String(m).padStart(2, "0");
      insHrTb.run(tbId, `${tbToday}T08:${mm}`, 62 + (m % 5));
    }
    // Deep-past HR makes an exact historical query observable. The selected day
    // must show 88 bpm without aggregating or returning the newer buckets above.
    for (let m = 0; m < 5; m++) {
      const mm = String(m).padStart(2, "0");
      insHrTb.run(tbId, `${TRENDS_BODY_OLD_DAY}T08:${mm}`, 88);
    }

    seedMemberLogin(E2E_LOGIN_TRENDS_BODY, tbId, "read");
    console.log(
      `e2e: seeded Trends → Body mobile fixture — profile ${tbId} (${TRENDS_BODY_PROFILE}) (#1067)`
    );
  }
}

// ── Curated Trends Overview ──
export function seedCuratedOverview(): void {
  // ── Curated Trends Overview fixture (#1487 rendering half / #1485 A+B) ────────
  // Overview renders the SAVED set and nothing else now, so the spec that proves it
  // needs a profile whose saved set it can churn without touching a neighbour. This
  // one is created through fixtureProfileId → createFixtureProfile, so it carries the
  // same standard metric seeds a production-created profile does (weight, body fat,
  // resting HR, training volume) — the fixture IS the day-one state.
  //
  // On top of that: two weigh-ins carrying resting HR (so exactly TWO tiles draw a
  // sparkline and the two-column phone grid is measurable), no body-fat readings and
  // no activities (so those two tiles are the truly-empty case), and one starred
  // analyte with no readings anywhere (the never-measured case #1485 A compacts).
  // Idempotent: its own fixture rows are cleared first.
  {
    const curateId = fixtureProfileId(TRENDS_CURATE_PROFILE);
    const curateToday = today(curateId);
    db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(curateId);
    const insCurate = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:trends-curate')`
    );
    insCurate.run(curateId, shiftDateStr(curateToday, -9), 74.2, 57);
    insCurate.run(curateId, shiftDateStr(curateToday, -2), 73.6, 55);
    db.prepare(
      `INSERT OR IGNORE INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)`
    ).run(curateId, TRENDS_CURATE_EMPTY_ANALYTE);
    seedMemberLogin(E2E_LOGIN_TRENDS_CURATE, curateId, "write");
    console.log(
      `e2e: seeded curated-Overview fixture — profile ${curateId} (${TRENDS_CURATE_PROFILE}) (#1487/#1485)`
    );
  }
}

// ── Compare folds into Insights, gate moves to the section ──
export function seedCompareFold(): void {
  // ── Compare-into-Insights fixture (#1489) ────────────────────────────────────
  // A TRAINING-RESTRICTED profile that can actually run a comparison: an age UNDER
  // the instance gate (13, set by e2e/seed/coverage-gaps.ts) with TWO overlappable
  // series — weight + resting HR on the same dates — so the compare overlay draws
  // its dual-axis chart for a minor. It is dedicated rather than shared because the
  // seeded "Riley (child)" has no second metric to overlay.
  // (It also carried a stored saved view on the retired `tab: "compare"` until
  // #1653 deleted the saved-views feature; the retired tab name is covered by the
  // deep link the compare-fold spec navigates, which is what a stored view resolved
  // through anyway.)
  // Dates are RELATIVE (inside the 90-day default window) so the fixture never goes
  // stale; the spec only reads, so it stays repeat-safe.
  // Idempotent: its own fixture rows are cleared and rewritten.
  const cmpId = fixtureProfileId(TRENDS_COMPARE_PROFILE);
  const cmpToday = today(cmpId);

  // ~10 years old → under the 13-year gate → training-restricted. (Set, not
  // ignored, on a re-seed: a stale birthdate would silently un-restrict it.)
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(cmpId, shiftDateStr(cmpToday, -3650));

  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(cmpId);
  const insCmp = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:trends-compare')`
  );
  for (const [ago, kg, hr] of [
    [21, 32.4, 78],
    [14, 32.7, 76],
    [7, 32.9, 74],
    [2, 33.1, 75],
  ] as const) {
    insCmp.run(cmpId, shiftDateStr(cmpToday, -ago), kg, hr);
  }

  // Write grant so the member gets the ORDINARY hub chrome the tab-strip and
  // section assertions are written against, not the read-only variant. The spec
  // itself only navigates — it writes nothing.
  seedMemberLogin(E2E_LOGIN_TRENDS_COMPARE, cmpId, "write");
  console.log(
    `e2e: seeded compare-fold fixture — profile ${cmpId} (${TRENDS_COMPARE_PROFILE}) (#1489)`
  );
}

// ── Fitness becomes the windowed analytics lens ──
export function seedFitnessLens(): void {
  // ── Trends → Fitness windowed-lens fixture (#1492) ───────────────────────────
  // A dedicated ADULT profile whose training data STRADDLES the 90-day default
  // window, so the browser tier can watch a range change re-window every chart:
  //
  //   INSIDE (relative dates, 5–70 days ago → always within 90D)
  //     • six Front Squat sessions on a rising load → the est-1RM trend + a mover
  //     • four runs with per-component minutes → weekly cardio volume + intensity mix
  //     • two tennis matches → the Sport section
  //   OUTSIDE (DEEP PAST, 2026-01-* — never inside a relative window)
  //     • two Pendlay Row sessions + one long ride + one long match, all of which
  //       must be ABSENT at 90D and PRESENT at All time
  //
  // The inside dates are relative so the fixture never goes stale; the outside ones
  // are fixed deep-past per the #1511 rule (relative OR deep-past, never fixed
  // near-present). Read-only in its spec. Idempotent: its own rows are cleared and
  // rewritten (child exercise_sets go first — they reach profile through the
  // activity, so the parents can't be deleted under them).
  const fitId = fixtureProfileId(TRENDS_FITNESS_PROFILE);
  const fitToday = today(fitId);

  db.prepare(
    `DELETE FROM exercise_sets WHERE activity_id IN
       (SELECT id FROM activities WHERE profile_id = ?)`
  ).run(fitId);
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(fitId);

  const insActivity = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, intensity, components, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
  );
  const insSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, warmup)
     VALUES (?, ?, ?, ?, ?, 0)`
  );

  const lift = (date: string, exercise: string, weightKg: number): void => {
    const id = Number(
      insActivity.run(fitId, date, "strength", "Lift day", 50, null, null, null)
        .lastInsertRowid
    );
    for (let set = 1; set <= 3; set++)
      insSet.run(id, exercise, set, weightKg, 5);
  };
  const run = (date: string, minutes: number, intensity: string): void => {
    insActivity.run(
      fitId,
      date,
      "cardio",
      "Run",
      minutes,
      8,
      intensity,
      JSON.stringify([
        {
          name: "Running",
          type: "cardio",
          duration_min: minutes,
          distance_km: 8,
        },
      ])
    );
  };
  const match = (date: string, minutes: number): void => {
    insActivity.run(
      fitId,
      date,
      "sport",
      "Tennis match",
      minutes,
      null,
      null,
      JSON.stringify([{ name: "Tennis", type: "sport", duration_min: minutes }])
    );
  };

  // Inside the 90-day window: a rising Front Squat, four runs, two matches.
  for (const [ago, kg] of [
    [70, 90],
    [56, 95],
    [42, 100],
    [28, 105],
    [14, 110],
    [5, 115],
  ] as const) {
    lift(shiftDateStr(fitToday, -ago), TRENDS_FITNESS_LIFT, kg);
  }
  for (const [ago, minutes, intensity] of [
    [60, 35, "easy"],
    [40, 45, "easy"],
    [20, 30, "moderate"],
    [6, 40, "easy"],
  ] as const) {
    run(shiftDateStr(fitToday, -ago), minutes, intensity);
  }
  match(shiftDateStr(fitToday, -33), 60);
  match(shiftDateStr(fitToday, -11), 75);

  // Deep past — outside every relative window, visible only at All time.
  lift("2026-01-06", TRENDS_FITNESS_OLD_LIFT, 70);
  lift("2026-01-13", TRENDS_FITNESS_OLD_LIFT, 75);
  run("2026-01-09", 120, "hard");
  match("2026-01-16", 150);

  seedMemberLogin(E2E_LOGIN_TRENDS_FITNESS, fitId, "read");
  console.log(
    `e2e: seeded Trends → Fitness windowed-lens fixture — profile ${fitId} (${TRENDS_FITNESS_PROFILE}) (#1492)`
  );
}

// ── Chart tap-through: the metric detail page's readings table (issue #1488) ──
export function seedTrendsReadings(): void {
  // A dedicated WRITE profile whose readings the spec edits and deletes: two HRV
  // samples (one manual, one imported from Health Connect) plus two weigh-ins. The
  // two HRV values are DISTINCT and named in fixture-logins, so the spec can address
  // one row by its value rather than by position on a shared surface. Relative
  // dates → never stale; UTC instants (the e2e default timezone) → host-TZ
  // independent. Idempotent: this profile's fixture rows are hard-cleared first.
  const rdId = fixtureProfileId(TRENDS_READINGS_PROFILE);
  const rdToday = today(rdId);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'hrv_ms'`
  ).run(rdId);
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(rdId);

  const insHrv = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, ?, 'hrv_ms', ?, ?, ?, ?)`
  );
  const manualDay = shiftDateStr(rdToday, -1);
  insHrv.run(
    rdId,
    "manual",
    manualDay,
    `${manualDay}T07:00:00Z`,
    `${manualDay}T07:01:00Z`,
    TRENDS_READINGS_HRV_MANUAL
  );
  insHrv.run(
    rdId,
    "health-connect",
    rdToday,
    `${rdToday}T07:00:00Z`,
    `${rdToday}T07:01:00Z`,
    TRENDS_READINGS_HRV_SYNCED
  );

  const insRdBm = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
     VALUES (?, ?, ?, 'e2e:trends-readings')`
  );
  insRdBm.run(rdId, shiftDateStr(rdToday, -5), 80.5);
  insRdBm.run(rdId, shiftDateStr(rdToday, -1), 80.1);

  seedMemberLogin(E2E_LOGIN_TRENDS_READINGS, rdId, "write");
  console.log(
    `e2e: seeded Trends readings-table fixture — profile ${rdId} (${TRENDS_READINGS_PROFILE}) (#1488)`
  );
}

// ── Ranked default chart-card order (#1490) ──
export function seedRankedCardOrder(): void {
  // Three profiles, one per ranker scenario (#1490). Each is a NEVER-ARRANGED
  // profile — no `trends_card_order` setting — because the ranked default is
  // precisely what serves those and nothing else. Dedicated ON PURPOSE (#868): the
  // claim is about the ORDER of a whole tab, which a neighbour's goal, condition or
  // stray reading would flip. Relative dates so presence stays "rich"; idempotent.

  // 1. PEDIATRIC — heights + weigh-ins for a ~6-year-old. Growth leads.
  {
    const id = fixtureProfileId(TRENDS_RANK_PEDS_PROFILE);
    const anchor = today(id);
    db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(id);
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'height_cm'`
    ).run(id);
    setUserSex(id, "female");
    setUserBirthdate(id, shiftDateStr(anchor, -365 * 6 - 30));

    const insHeight = db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'height_cm', ?, ?, ?, ?)`
    );
    const insBm = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
       VALUES (?, ?, ?, 'e2e:trends-rank-peds')`
    );
    for (const [ago, cm, kg] of [
      [120, 113.5, 20.2],
      [60, 114.4, 20.6],
      [10, 115.1, 20.9],
      [2, 115.3, 21.0],
    ] as const) {
      const day = shiftDateStr(anchor, -ago);
      insHeight.run(id, day, `${day}T08:00:00Z`, `${day}T08:01:00Z`, cm);
      insBm.run(id, day, kg);
    }
    seedMemberLogin(E2E_LOGIN_TRENDS_RANK_PEDS, id, "read");
    console.log(
      `e2e: seeded Trends rank PEDS fixture — profile ${id} (${TRENDS_RANK_PEDS_PROFILE}) (#1490)`
    );
  }

  // 2. WEIGHT GOAL and 3. PLAIN — the SAME data shape (weigh-ins, heights, a
  // systolic/diastolic pair, HRV and steps), differing ONLY in whether a live weight
  // goal exists. That is what makes the pair a controlled comparison: any order
  // difference between them is the goal signal and nothing else.
  //
  // The heights are there for BMI (#1659): under the everyday-first base layout the
  // Composition run leads for BOTH profiles, so "the goal lifts weight" stopped
  // being a DIFFERENCE between them. BMI is the goal's other card (GOAL_CARDS maps a
  // weight goal to weight + bmi) and it sits in the synced composition TAIL, so the
  // pair still has one card whose position only the goal can explain.
  for (const [profileName, loginName, withGoal] of [
    [TRENDS_RANK_GOAL_PROFILE, E2E_LOGIN_TRENDS_RANK_GOAL, true],
    [TRENDS_RANK_PLAIN_PROFILE, E2E_LOGIN_TRENDS_RANK_PLAIN, false],
  ] as const) {
    const id = fixtureProfileId(profileName);
    const anchor = today(id);
    db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(id);
    db.prepare(
      `DELETE FROM medical_records WHERE profile_id = ? AND source = 'e2e:trends-rank'`
    ).run(id);
    db.prepare(`DELETE FROM goals WHERE profile_id = ?`).run(id);
    setUserSex(id, "male");
    setUserBirthdate(id, shiftDateStr(anchor, -365 * 41));

    const insBm = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
       VALUES (?, ?, ?, 'e2e:trends-rank')`
    );
    const insVital = db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, canonical_name, value, value_num, unit, source)
       VALUES (?, ?, 'vitals', ?, ?, ?, ?, 'mmHg', 'e2e:trends-rank')`
    );
    // Oxygen saturation, in its own unit — this is what makes these two profiles
    // the BOTH-RICH wearable case #1674 reports: a clinical card and an everyday
    // synced card, evenly tracked, so their relative order is pure rank. Under the
    // retired section boxes SpO₂ rendered above steps (its box-mates lifted it and
    // steps sat outside the ordering); flat, the everyday-first base decides.
    const insSpo2 = db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, canonical_name, value, value_num, unit, source)
       VALUES (?, ?, 'vitals', 'Oxygen Saturation', 'Oxygen Saturation', ?, ?, '%', 'e2e:trends-rank')`
    );
    const insSample = db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'e2e-device', ?, ?, ?, ?, ?)`
    );
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND source = 'e2e-device'`
    ).run(id);
    for (const [ago, kg, sys, dia, hrv, steps, spo2] of [
      [21, 84.2, 124, 79, 44, 8100, 97],
      [14, 83.8, 122, 78, 47, 9400, 98],
      [7, 83.5, 126, 80, 43, 7700, 96],
      [1, 83.1, 121, 77, 46, 10200, 97],
    ] as const) {
      const day = shiftDateStr(anchor, -ago);
      insBm.run(id, day, kg);
      // HRV and steps give the tab a third vitals card and a synced card, so the
      // identity assertion spans every run rather than one pair.
      insSample.run(
        id,
        "hrv_ms",
        day,
        `${day}T06:00:00Z`,
        `${day}T06:01:00Z`,
        hrv
      );
      insSample.run(
        id,
        "steps",
        day,
        `${day}T00:00:00Z`,
        `${day}T23:59:59Z`,
        steps
      );
      // A stable adult height, so BMI is a real derived card for both profiles.
      insSample.run(
        id,
        "height_cm",
        day,
        `${day}T06:30:00Z`,
        `${day}T06:31:00Z`,
        181.0
      );
      insVital.run(
        id,
        day,
        "Blood Pressure Systolic",
        "Blood Pressure Systolic",
        String(sys),
        sys
      );
      insVital.run(
        id,
        day,
        "Blood Pressure Diastolic",
        "Blood Pressure Diastolic",
        String(dia),
        dia
      );
      insSpo2.run(id, day, String(spo2), spo2);
    }
    if (withGoal) {
      db.prepare(
        `INSERT INTO goals (profile_id, title, status, body_metric, target_value, baseline_value, archived)
         VALUES (?, 'Reach 78 kg', 'active', 'weight', 78, 84.2, 0)`
      ).run(id);
    }
    seedMemberLogin(loginName, id, "read");
    console.log(
      `e2e: seeded Trends rank ${withGoal ? "GOAL" : "PLAIN"} fixture — profile ${id} (${profileName}) (#1490)`
    );
  }
}

// ── ★-pinned Body card order (#1643) ──
export function seedPinnedCardOrder(): void {
  // A dedicated WRITE fixture for the arrangement substrate (#868): the spec stars,
  // re-sequences and unstars, so it must own its profile outright — a churned saved
  // set is exactly the state a neighbour's Trends assertion would read wrong.
  //
  // The shape is deliberately minimal: TWO Body cards with data. `weight` is one of
  // the standard metric seeds every profile is created with, so it starts STARRED
  // and leads; `steps` is not seeded, so it starts unstarred in its ranked slot
  // behind weight. Everything the issue claims is a move between those two states.
  //
  // Relative dates keep both series "rich" forever; idempotent, so a reused dev
  // server re-seeds cleanly. The saved set is left exactly as creation made it —
  // each test restores it.
  const id = fixtureProfileId(TRENDS_PIN_PROFILE);
  const anchor = today(id);
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(id);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND source = 'e2e-pin'`
  ).run(id);
  setUserSex(id, "female");
  setUserBirthdate(id, shiftDateStr(anchor, -365 * 38));

  const insBm = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
     VALUES (?, ?, ?, 'e2e:trends-pin')`
  );
  const insSample = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'e2e-pin', 'steps', ?, ?, ?, ?)`
  );
  for (const [ago, kg, steps] of [
    [18, 66.4, 7300],
    [12, 66.1, 8800],
    [6, 65.9, 9100],
    [2, 65.7, 10400],
  ] as const) {
    const day = shiftDateStr(anchor, -ago);
    insBm.run(id, day, kg);
    insSample.run(id, day, `${day}T00:00:00Z`, `${day}T23:59:59Z`, steps);
  }

  seedMemberLogin(E2E_LOGIN_TRENDS_PIN, id, "write");
  console.log(
    `e2e: seeded Trends ★-pin fixture — profile ${id} (${TRENDS_PIN_PROFILE}) (#1643)`
  );
}

// ── Day one and the trailing-average labels (#1909 / #1917) ──
export function seedDayOneAverages(): void {
  // Seeded EMPTY on purpose — see the constants' header in e2e/logins/trends.ts.
  // The state under test is the absence of history, so the only thing a shared
  // seeder can safely give this fixture is a profile, a login and an adult
  // birthdate; every reading is the spec's, written and cleared at test start so
  // --repeat-each starts from the same nothing.
  const id = fixtureProfileId(DAY_ONE_PROFILE);
  const anchor = today(id);
  setUserBirthdate(id, shiftDateStr(anchor, -365 * 34));
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(id);
  db.prepare(`DELETE FROM protein_log WHERE profile_id = ?`).run(id);
  db.prepare(`DELETE FROM food_log WHERE profile_id = ?`).run(id);
  seedMemberLogin(E2E_LOGIN_DAY_ONE, id, "write");
  console.log(
    `e2e: seeded day-one averages fixture — profile ${id} (${DAY_ONE_PROFILE}) (#1909/#1917)`
  );
}

// ── Relevance-ranked biomarker pickers (#1675) ──
export function seedBiomarkerPickerRank(): void {
  // The fixture behind e2e/biomarker-picker-rank.spec.ts. See the constants' header in
  // e2e/logins/trends.ts for why it is a dedicated, write-granted profile.
  //
  // Three analytes, one per group boundary the rank has to draw, and deliberately in
  // ANTI-alphabetical relevance order: Albumin (the alphabetically first, and the one
  // a plain A–Z picker led with) is the LEAST relevant of the three.
  const pid = fixtureProfileId(BIOMARKER_PICKER_PROFILE);
  seedMemberLogin(E2E_LOGIN_BIOMARKER_PICKER, pid, "write");
  setUserBirthdate(pid, "1985-04-12");
  setUserSex(pid, "female");
  const pickerToday = today(pid);

  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name IN (?, ?, ?)`
  ).run(
    pid,
    BIOMARKER_PICKER_OVERDUE,
    BIOMARKER_PICKER_FLAGGED,
    BIOMARKER_PICKER_MEASURED
  );
  const insRecord = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, source)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'manual')`
  );
  // Overdue: HbA1c redraws every 90 days, so ~400 days is unambiguously stale.
  insRecord.run(
    pid,
    shiftDateStr(pickerToday, -400),
    BIOMARKER_PICKER_OVERDUE,
    "5.4",
    "%",
    BIOMARKER_PICKER_OVERDUE,
    5.4
  );
  // Flagged but FRESH — the flag is what promotes it, not a stale draw.
  insRecord.run(
    pid,
    shiftDateStr(pickerToday, -10),
    BIOMARKER_PICKER_FLAGGED,
    "205",
    "mg/dL",
    BIOMARKER_PICKER_FLAGGED,
    205
  );
  // Measured, in range, fresh: the profile's own marker, and nothing more.
  insRecord.run(
    pid,
    shiftDateStr(pickerToday, -10),
    BIOMARKER_PICKER_MEASURED,
    "4.5",
    "g/dL",
    BIOMARKER_PICKER_MEASURED,
    4.5
  );
  reconcileFlags(pid);

  // The spec stars through the picker and unstars from the tile; make sure a previous
  // run (or a reused dev server) can't leave the analyte already saved, which would
  // withdraw it from the picker's options.
  db.prepare(
    `DELETE FROM saved_items WHERE profile_id = ? AND kind = 'biomarker'`
  ).run(pid);
}

// ── One judgement per identity (#1996 / #1997) ──
export function seedMetricJudgment(): void {
  // A CHILD whose resting heart rate arrives ONLY from a wearable — the reported
  // #1996 case: the curated age bands live in the canonical vocabulary, keyed by
  // biomarker name, while the readings stream into `body_metrics`, so before the
  // identity lookup the trend was charted against nothing.
  //
  // Values are chosen so the age band is OBSERVABLE: ~120 bpm is normal for a
  // toddler (1–3 band: 80–150) and "Above range" against the adult 50–100, so a
  // page judging it correctly and a page judging it as an adult cannot look alike.
  //
  // Relative dates → never stale. Read-only in its spec, and idempotent: it clears
  // its own fixture rows first.
  const pid = fixtureProfileId(METRIC_JUDGMENT_PROFILE);
  const pToday = today(pid);
  // ~2 years old → the 1–3 band applies on every reading date below.
  setUserBirthdate(pid, shiftDateStr(pToday, -800));
  setUserSex(pid, "female");

  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(pid);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Resting Heart Rate'`
  ).run(pid);

  const insStream = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source, notes)
     VALUES (?, ?, ?, 'health-connect', 'e2e:metric-judgment')`
  );
  for (const [ago, bpm] of [
    [12, 121],
    [9, 119],
    [6, 122],
    [3, 118],
    [1, 120],
  ] as const) {
    insStream.run(pid, shiftDateStr(pToday, -ago), bpm);
  }

  // ONE clinic-measured reading of the SAME quantity, in the observation store, on
  // a day the stream does not cover — so the metric surface folding it in is a
  // visible ADDITION to the trend, and the row is marked as living elsewhere.
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, notes)
     VALUES (?, ?, 'vitals', 'Pulse', ?, 'bpm', 'Resting Heart Rate', ?, 'e2e:metric-judgment')`
  ).run(
    pid,
    shiftDateStr(pToday, -20),
    String(METRIC_JUDGMENT_CLINIC_BPM),
    METRIC_JUDGMENT_CLINIC_BPM
  );
  reconcileFlags(pid);

  seedMemberLogin(E2E_LOGIN_METRIC_JUDGMENT, pid, "read");
  console.log(
    `e2e: seeded metric-judgment fixture — profile ${pid} (${METRIC_JUDGMENT_PROFILE}) (#1996)`
  );
}
