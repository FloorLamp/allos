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
  E2E_LOGIN_TTC,
  TTC_PROFILE,
  E2E_LOGIN_CYCLE_STALE,
  CYCLE_STALE_PROFILE,
  E2E_LOGIN_CYCLE_CTA,
  CYCLE_CTA_PROFILE,
  E2E_LOGIN_CYCLE_GAP,
  CYCLE_GAP_PROFILE,
  E2E_LOGIN_DERIVED,
  DERIVED_SITU_PROFILE,
  DERIVED_SITU_PERIOD_ITEM,
  DERIVED_SITU_SLEEP_ITEM,
  DERIVED_SITU_POLLEN_ITEM,
  E2E_LOGIN_SITIMPACT,
  SITUATION_IMPACT_PROFILE,
} from "../fixture-logins";
import {
  diffSituations,
  serializeSituationEvents,
} from "../../lib/trend-annotations";
import { seedMemberLogin, fixtureProfileId } from "./common";

// The coarse home location the derived-situations fixture's weather rows are keyed to
// (~0.1° storage precision). Its own coordinate so the GLOBAL, location-keyed weather
// cache can't collide with another fixture's series.
const DERIVED_SITU_HOME = { lat: 51.5, lng: -0.1 };
// Comfortably over POLLEN_ENTER.grass, so the situation holds without sitting on the
// threshold the predicate's hysteresis band is about.
const DERIVED_SITU_POLLEN_COUNT = 60;

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

  // ── Stale open period fixture (#1682 fix a) ──────────────────────────────────
  // A dedicated adult profile whose latest period was started 18 days ago and NEVER
  // ended — the forgotten "Period ended" tap. Past MAX_PLAUSIBLE_PERIOD_DAYS the
  // derivations stop claiming menstrual and the Cycle surface prompts for the real end
  // date, with the record left exactly as stored. One earlier completed period gives the
  // profile a history to derive against. Its own profile because CYCLE_PROFILE must have
  // no open period; the spec is read-only here, so the stale state survives --repeat-each.
  const staleProfileId = fixtureProfileId(CYCLE_STALE_PROFILE);
  db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(staleProfileId);
  const staleAnchor = today(staleProfileId);
  db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end, flow)
     VALUES (?, ?, ?, 'medium')`
  ).run(
    staleProfileId,
    shiftDateStr(staleAnchor, -46),
    shiftDateStr(staleAnchor, -42)
  );
  db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end, flow)
     VALUES (?, ?, NULL, 'light')`
  ).run(staleProfileId, shiftDateStr(staleAnchor, -18));
  seedMemberLogin(E2E_LOGIN_CYCLE_STALE, staleProfileId, "write");
  console.log(
    `e2e: seeded stale-open-period fixture — profile ${staleProfileId} (${CYCLE_STALE_PROFILE}) (#1682)`
  );

  // ── Cycle log-affordance fixtures (#1892) ────────────────────────────────────
  // Two dedicated adult FEMALE profiles, cycle-relevant by LIFE STAGE (sex +
  // premenopausal status) rather than by data — which is the only way to reach the
  // state this issue is about: a profile the domain applies to that has logged
  // nothing yet. Before #1892 that state hid the dashboard card entirely.
  //
  //   CTA — no cycle rows. The card is the offer ("Period started today"). The spec
  //         OWNS its mutations and clears the profile's cycles before each test.
  //   GAP — one period ended 5 days ago: past the reopen window, short of the
  //         plausible gap, so the card shows the derived phase and NO button. The
  //         spec is read-only here, so it survives --repeat-each untouched.
  //
  // Dates are relative to each profile's own today. Synthetic, no PHI.
  {
    const ctaId = fixtureProfileId(CYCLE_CTA_PROFILE);
    const ctaAnchor = today(ctaId);
    db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(ctaId);
    setProfileSetting(ctaId, "sex", "female");
    setProfileSetting(ctaId, "reproductive_status", "premenopausal");
    setProfileSetting(ctaId, "birthdate", shiftDateStr(ctaAnchor, -365 * 29));
    seedMemberLogin(E2E_LOGIN_CYCLE_CTA, ctaId, "write");
    console.log(
      `e2e: seeded cycle log-CTA fixture — profile ${ctaId} (${CYCLE_CTA_PROFILE}) (#1892)`
    );

    const gapId = fixtureProfileId(CYCLE_GAP_PROFILE);
    const gapAnchor = today(gapId);
    db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(gapId);
    setProfileSetting(gapId, "sex", "female");
    setProfileSetting(gapId, "reproductive_status", "premenopausal");
    setProfileSetting(gapId, "birthdate", shiftDateStr(gapAnchor, -365 * 31));
    db.prepare(
      `INSERT INTO cycles (profile_id, period_start, period_end, flow)
       VALUES (?, ?, ?, 'medium')`
    ).run(gapId, shiftDateStr(gapAnchor, -9), shiftDateStr(gapAnchor, -5));
    seedMemberLogin(E2E_LOGIN_CYCLE_GAP, gapId, "write");
    console.log(
      `e2e: seeded cycle plausible-gap fixture — profile ${gapId} (${CYCLE_GAP_PROFILE}) (#1892)`
    );
  }

  // ── Trying-to-conceive fixture (#1679/#1680) ─────────────────────────────────
  // A dedicated adult FEMALE profile with SIX regular ~28-day cycles (so the next-period
  // forecast is available and NARROW), a DECLARED trying-to-conceive start, and a
  // follicular BBT baseline in the current cycle. The declared start is what turns the TTC
  // surfaces on at all (declared-only doctrine), and it is set far enough back to count
  // several cycles WITHOUT reaching the 12-month workup threshold — the spec asserts the
  // surfaces, not the prompt. Hard-clear the fixture's rows first so a reused server
  // re-seeds cleanly. All dates are relative to the profile's today; synthetic, no PHI.
  const ttcId = fixtureProfileId(TTC_PROFILE);
  const ttcAnchor = today(ttcId);
  db.prepare(`DELETE FROM cycles WHERE profile_id = ?`).run(ttcId);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'bbt_f'`
  ).run(ttcId);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND name = 'Ovulation Test (LH)'`
  ).run(ttcId);
  db.prepare(
    `DELETE FROM symptom_logs WHERE profile_id = ? AND symptom = 'cervical_mucus'`
  ).run(ttcId);
  setProfileSetting(ttcId, "sex", "female");
  setProfileSetting(ttcId, "reproductive_status", "premenopausal");
  // An adult birthdate, deep in the past and relative to the anchor (never a fixed
  // near-present date) — the TTC section is adult-gated.
  setProfileSetting(ttcId, "birthdate", shiftDateStr(ttcAnchor, -365 * 32));
  // Declared ~5 months ago: TTC is on, and the 12-month prompt is not.
  setProfileSetting(ttcId, "ttc_start_date", shiftDateStr(ttcAnchor, -150));
  for (let i = 6; i >= 0; i--) {
    const startAgo = 14 + i * 28;
    db.prepare(
      `INSERT INTO cycles (profile_id, period_start, period_end, flow)
       VALUES (?, ?, ?, 'medium')`
    ).run(
      ttcId,
      shiftDateStr(ttcAnchor, -startAgo),
      shiftDateStr(ttcAnchor, -(startAgo - 4))
    );
  }
  // A flat follicular baseline for the current cycle — deliberately NO sustained rise, so
  // the spec's "no confirmation yet" read is stable and the log bar owns any change.
  for (let i = 9; i >= 1; i--) {
    const d = shiftDateStr(ttcAnchor, -i);
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', NULL, 'bbt_f', ?, ?, ?, ?)`
    ).run(ttcId, d, `${d}T00:00:00`, `${d}T00:00:00`, 97.3);
  }
  seedMemberLogin(E2E_LOGIN_TTC, ttcId, "write");
  console.log(
    `e2e: seeded trying-to-conceive fixture — profile ${ttcId} (${TTC_PROFILE}) (#1679/#1680)`
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
    const pollenSit = Number(
      db
        .prepare(
          `INSERT INTO situations (profile_id, name, active) VALUES (?, 'High pollen', 0)`
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
    keyedItem(DERIVED_SITU_POLLEN_ITEM, "High pollen", pollenSit);

    // The WEATHER derived situation (#1726). Two facts make it hold: a home location
    // (weather features are quietly absent without one) and cached daily rows carrying
    // a grass-pollen count over the family's entry bound. The keyed item above is also
    // what makes weather situations RELEVANT for this profile, so nothing else is
    // needed — and nothing is ever toggled, which is the point of a derived situation.
    setProfileSetting(dsId, "home_lat", String(DERIVED_SITU_HOME.lat));
    setProfileSetting(dsId, "home_lng", String(DERIVED_SITU_HOME.lng));
    db.prepare(`DELETE FROM weather_days WHERE lat = ? AND lng = ?`).run(
      DERIVED_SITU_HOME.lat,
      DERIVED_SITU_HOME.lng
    );
    for (let i = 3; i >= 0; i--) {
      db.prepare(
        `INSERT INTO weather_days
           (lat, lng, date, temp_max_c, pollen_grass, source)
         VALUES (?, ?, ?, 18, ?, 'e2e')`
      ).run(
        DERIVED_SITU_HOME.lat,
        DERIVED_SITU_HOME.lng,
        shiftDateStr(dsToday, -i),
        DERIVED_SITU_POLLEN_COUNT
      );
    }

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
      zonedWallTimeToUtc(dsTz, day, hm)!.toISOString();
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
