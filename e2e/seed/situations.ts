// e2e seed fixtures — situations domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { shiftDateStr, zonedWallTimeToUtc } from "../../lib/date";
import { setProfileSetting, getTimezone } from "../../lib/settings";
import {
  E2E_LOGIN_CYCLE,
  CYCLE_PROFILE,
  E2E_LOGIN_DERIVED,
  DERIVED_SITU_PROFILE,
  DERIVED_SITU_PERIOD_ITEM,
  DERIVED_SITU_SLEEP_ITEM,
  E2E_LOGIN_SITIMPACT,
  SITUATION_IMPACT_PROFILE,
} from "../fixture-logins";
import {
  diffSituations,
  serializeSituationEvents,
} from "../../lib/trend-annotations";
import { seedMemberLogin, fixtureProfileId } from "./common";

// ── Menstrual cycle log + derived situations ──
export function seedCycleAndDerived(): void {
  // ── Menstrual cycle log fixture (#714) ────────────────────────────────────────
  // A dedicated adult profile with three completed, roughly-regular periods (~28-day
  // cycles, 5-day bleeding) and NO open period, so the Cycle surface renders a derived
  // phase, the cycle-length + variability stats, and the length trend chart. The cycle
  // spec OWNS its mutations (one-tap start/end, add/delete), so hard-clear any leftover
  // cycles on a reused server. Synthetic, no PHI.
  const cycleProfileId = fixtureProfileId(CYCLE_PROFILE);
  db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(cycleProfileId);
  const cycleAnchor = today(cycleProfileId);
  for (const [startAgo, endAgo, flow] of [
    [75, 71, "medium"],
    [47, 43, "heavy"],
    [19, 15, "light"],
  ] as const) {
    db.prepare(
      `INSERT INTO cycles (profile_id, period_start, period_end, flow)
     VALUES (?, ?, ?, ?)`
    ).run(
      cycleProfileId,
      shiftDateStr(cycleAnchor, -startAgo),
      shiftDateStr(cycleAnchor, -endAgo),
      flow
    );
  }
  // One activity ON the most recent period's start day so the Timeline has a day section
  // there — its header renders the derived phase/period chip ("Period"), the #714 Timeline
  // surface the spec asserts.
  db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(cycleProfileId);
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, distance_km)
   VALUES (?, ?, 'cardio', 'Walk', 3)`
  ).run(cycleProfileId, shiftDateStr(cycleAnchor, -19));
  seedMemberLogin(E2E_LOGIN_CYCLE, cycleProfileId, "write");
  console.log(
    `e2e: seeded cycle-log fixture — profile ${cycleProfileId} (${CYCLE_PROFILE}) (#714)`
  );

  // ── Derived situations fixture (#1292 Poor sleep, #1298 Period) ───────────────
  // A dedicated adult female (premenopausal → cycle-relevant) profile that carries a
  // Period-keyed iron supplement and a Poor-sleep-keyed magnesium, plus a rough last-night
  // sleep session so the DERIVED poor-sleep context is measured-ON. NO open period is
  // seeded, so today starts a gap day (Period context off) until the spec logs a period
  // (its own idempotent inverse). Hard-clear the fixture's cycles / intake / today sleep /
  // override rows first so a reused server re-seeds cleanly. Synthetic, no PHI.
  {
    const dsId = fixtureProfileId(DERIVED_SITU_PROFILE);
    const dsToday = today(dsId);
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
    ).run(dsId);
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value)
     VALUES (?, 'reproductive_status', 'premenopausal')`
    ).run(dsId);
    // Idempotent reset for a reused server.
    db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(dsId);
    db.prepare(`DELETE FROM intake_items WHERE profile_id = ?`).run(dsId);
    db.prepare(`DELETE FROM situations WHERE profile_id = ?`).run(dsId);
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min'`
    ).run(dsId);
    db.prepare(
      `DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'poor-sleep-override:%'`
    ).run(dsId);

    // The two derived situations as inactive vocabulary rows (name-keyed; the derived
    // resolver keys on the names, no manual activation needed).
    const periodSit = Number(
      db
        .prepare(
          `INSERT INTO situations (profile_id, name, active) VALUES (?, 'Period', 0)`
        )
        .run(dsId).lastInsertRowid
    );
    const sleepSit = Number(
      db
        .prepare(
          `INSERT INTO situations (profile_id, name, active) VALUES (?, 'Poor sleep', 0)`
        )
        .run(dsId).lastInsertRowid
    );

    const keyedItem = (name: string, situation: string, sitId: number) => {
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items
             (profile_id, name, kind, condition, obligation, situation, situation_id, active)
         VALUES (?, ?, 'supplement', 'situational', 'should', ?, ?, 1)`
          )
          .run(dsId, name, situation, sitId).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 cap', 'evening', 'any', 0)`
      ).run(itemId);
      return itemId;
    };
    keyedItem(DERIVED_SITU_PERIOD_ITEM, "Period", periodSit);
    keyedItem(DERIVED_SITU_SLEEP_ITEM, "Poor sleep", sleepSit);

    // A rough last-night sleep session (300 min = 5h < the 6h floor) so getSleepSignal
    // trips and the measured poor-sleep context is ON, plus a few good baseline nights.
    //
    // CRITICAL (#1110 pinned instance timezone — the sleep-page fixture's lesson,
    // re-learned here): mainSleepNights groups sessions by the profile-LOCAL calendar
    // date of each session END, so these windows MUST be built through the profile
    // timezone (zonedWallTimeToUtc), NOT naive `T23:00` strings. A naive string parses
    // as host-local (UTC on runners) while the pinned Etc/GMT±N zone rotates with the
    // run's start hour — for offsets ≥ +5 (runs starting ≥ 18:00 UTC) the rough
    // night's 04:00 end slid back a wake-day, merged under the previous 480-min night,
    // and the derived poor-sleep context read OFF for the whole evening band
    // (derived-situations.spec red 18:00–23:59 UTC; the #1417 census).
    const dsTz = getTimezone(dsId);
    const dsSleepIso = (day: string, hm: string) =>
      zonedWallTimeToUtc(dsTz, day, hm).toISOString();
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min'`
    ).run(dsId);
    for (let i = 5; i >= 1; i--) {
      const wake = shiftDateStr(dsToday, -i);
      db.prepare(
        `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 480)`
      ).run(
        dsId,
        wake,
        dsSleepIso(shiftDateStr(wake, -1), "23:00"),
        dsSleepIso(wake, "07:00")
      );
    }
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 300)`
    ).run(
      dsId,
      dsToday,
      dsSleepIso(shiftDateStr(dsToday, -1), "23:00"),
      dsSleepIso(dsToday, "04:00")
    );

    seedMemberLogin(E2E_LOGIN_DERIVED, dsId, "write");
    console.log(
      `e2e: seeded derived-situations fixture — profile ${dsId} (${DERIVED_SITU_PROFILE}) (#1292/#1298)`
    );
  }
}

// ── Situation-window analytics ──
export function seedWindowAnalytics(): void {
  // ── Situation-window analytics fixture (#1297) ────────────────────────────────
  // A dedicated adult profile with a DECLARED "Travel" transition window (start day-14 →
  // stop day-9, so during = [day-14, day-10], baseline = [day-19, day-15]) carrying real
  // weight + resting-HR readings on the during AND baseline days, so Trends → Insights renders
  // the pooled "Situation impact" card for Travel. A one-day "High stress" toggle has too
  // little windowed history to render (the absent-pillar negative case). Read-only in the
  // spec, so the pooled deltas stay stable under --repeat-each. Idempotent; synthetic only.
  {
    const siId = fixtureProfileId(SITUATION_IMPACT_PROFILE);
    const siToday = today(siId);
    db.prepare(
      `DELETE FROM body_metrics WHERE profile_id = ? AND notes = 'e2e:sit-impact'`
    ).run(siId);

    const travelStart = shiftDateStr(siToday, -14);
    const travelStop = shiftDateStr(siToday, -9);
    const stressStart = shiftDateStr(siToday, -3);
    const stressStop = shiftDateStr(siToday, -2);
    const events = [
      ...diffSituations([], ["Travel"], travelStart),
      ...diffSituations(["Travel"], [], travelStop),
      ...diffSituations([], ["High stress"], stressStart),
      ...diffSituations(["High stress"], [], stressStop),
    ];
    setProfileSetting(
      siId,
      "situation_events",
      serializeSituationEvents([], events)
    );

    const insSi = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:sit-impact')`
    );
    // Baseline [day-19, day-15]: weight 80.0, resting HR 50. During [day-14, day-10]: weight
    // 80.8 (+0.8 kg), resting HR 56 (+6 bpm — "worse", lower_better). Enough on each side to
    // clear the pooled 3-sample floor.
    for (let d = -19; d <= -15; d++)
      insSi.run(siId, shiftDateStr(siToday, d), 80.0, 50);
    for (let d = -14; d <= -10; d++)
      insSi.run(siId, shiftDateStr(siToday, d), 80.8, 56);

    seedMemberLogin(E2E_LOGIN_SITIMPACT, siId, "read");
    console.log(
      `e2e: seeded situation-impact fixture — profile ${siId} (${SITUATION_IMPACT_PROFILE}) (#1297)`
    );
  }
}
