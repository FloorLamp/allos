// e2e seed fixtures — findings domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { shiftDateStr } from "../../lib/date";
import { now as clockNow } from "../../lib/clock";
import { syncInstantBefore } from "../sync-instants";
import { upsertConnection } from "../../lib/integrations/connections";
import {
  E2E_LOGIN_WEATHER,
  WEATHER_PROFILE,
  E2E_LOGIN_GOAL_PACE,
  E2E_LOGIN_PHOTOS,
  E2E_LOGIN_SUPPRESSED,
  GOAL_PACE_PROFILE,
  PROGRESS_PHOTOS_PROFILE,
  SUPPRESSED_PROFILE,
  E2E_LOGIN_VIDEO,
  VIDEO_PROFILE,
  E2E_LOGIN_PAIRED_OBS,
  PAIRED_OBS_PROFILE,
} from "../fixture-logins";
import { PROFILE_ID, ins, seedMemberLogin, fixtureProfileId } from "./common";

// ── Rule-domain findings fixtures ──
export function seedRuleDomains(): void {
  // ---- issue #45 rule-domain fixtures (domains 4–6) --------------------------
  // Deterministic fixtures so the new observational-findings surfaces have something
  // to render in e2e: the training plateau (domain 4) and the body-metric weight jump
  // (domain 5). All idempotent. Goal pacing (domain 6) is NOT here — it owns a whole
  // profile of its own, see seedGoalPacing below (#2353).

  // Domain 4 — a PLATEAUED lift: six weekly Skullcrusher sessions at a FIXED 30 kg × 10,
  // so the estimated 1RM is flat across ~5 weeks and the plateau rule fires on
  // Training → Overview. Skullcrusher is outside the seeded PPL routine, so it doesn't
  // disturb the progressing lifts.
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id LIKE 'e2e:plateau-%'`
  ).run(PROFILE_ID);
  const insPlateauAct = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
   VALUES (1, ?, 'strength', 'Arms — Skullcrusher', 30, 'hard', 'manual', ?)`
  );
  const insPlateauSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, 'Skullcrusher', ?, 30, 10)`
  );
  for (let w = 0; w < 6; w++) {
    const date = shiftDateStr(today(PROFILE_ID), -(w * 7 + 2));
    const actId = Number(
      insPlateauAct.run(date, `e2e:plateau-${w}`).lastInsertRowid
    );
    for (let s = 1; s <= 3; s++) insPlateauSet.run(actId, s);
  }

  // #449 — a DEDICATED plateaued lift ("E2E Dismiss Press") whose ONLY purpose is the
  // coaching-observations dashboard-dismiss spec. That spec mutates the shared
  // suppression store (dismissing the finding), and "dismiss once, silence everywhere"
  // would then hide the finding on Training → Overview too — so it must NOT reuse the
  // Skullcrusher plateau, which rule-findings.spec.ts asserts is visible. Built exactly
  // like the Skullcrusher fixture (six weekly sessions at a FIXED 30 kg × 10 → flat 1RM →
  // plateau rule fires), with a unique name no other spec references. Idempotent; outside
  // the seeded PPL routine so it doesn't disturb the progressing lifts.
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND external_id LIKE 'e2e:dismiss-plateau-%'`
  ).run(PROFILE_ID);
  const insDismissAct = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
   VALUES (1, ?, 'strength', 'Arms — E2E Dismiss Press', 30, 'hard', 'manual', ?)`
  );
  const insDismissSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, 'E2E Dismiss Press', ?, 30, 10)`
  );
  for (let w = 0; w < 6; w++) {
    const date = shiftDateStr(today(PROFILE_ID), -(w * 7 + 2));
    const actId = Number(
      insDismissAct.run(date, `e2e:dismiss-plateau-${w}`).lastInsertRowid
    );
    for (let s = 1; s <= 3; s++) insDismissSet.run(actId, s);
  }

  // #789 — a CUSTOM-ONLY strength session for the per-session muscle-figure spec's
  // negative case: one strength activity whose only lift is a made-up, non-catalog
  // name, so `musclesWorked` resolves to the empty set and the Journal card's
  // per-session anatomy figure degrades to nothing. Unique title so the spec targets
  // it exactly; a recent date so it lands in the Journal's first (newest) page. The
  // custom lift has no catalog muscle tags, so it adds nothing to weekly coverage and
  // leaves the coverage/volume-band specs undisturbed. Idempotent.
  const MUSCLE_FIG_CUSTOM = "Custom-only lift day (e2e)";
  db.prepare(`DELETE FROM activities WHERE profile_id = ? AND title = ?`).run(
    PROFILE_ID,
    MUSCLE_FIG_CUSTOM
  );
  const muscleFigActId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
       VALUES (?, ?, 'strength', ?, 40, 'hard', 'manual', 'e2e:muscle-fig-custom')`
      )
      .run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -1), MUSCLE_FIG_CUSTOM)
      .lastInsertRowid
  );
  const insMuscleFigSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, 'E2E Bespoke Machine Press', ?, 40, 10)`
  );
  for (let s = 1; s <= 3; s++) insMuscleFigSet.run(muscleFigActId, s);

  console.log(
    `e2e: seeded a custom-only strength session "${MUSCLE_FIG_CUSTOM}" for the per-session muscle-figure spec (#789)`
  );

  // Domain 5 — a probable-error weight JUMP: one outlier reading (92 kg) three days
  // after the prior weekly weigh-in (~80.5 kg), ~14% above it — a scale-glitch
  // signature the body-hygiene rule flags on Trends → Body.
  const jumpDate = shiftDateStr(today(PROFILE_ID), -12);
  db.prepare(
    `DELETE FROM body_metrics WHERE profile_id = ? AND notes = 'e2e:weight-jump'`
  ).run(PROFILE_ID);
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, notes)
   VALUES (1, ?, 92, 'e2e:weight-jump')`
  ).run(jumpDate);

  console.log(
    `e2e: seeded a 6-week Skullcrusher plateau, a dedicated E2E Dismiss Press plateau (#449), and a weight jump on ${jumpDate} (#45)`
  );

  // Domain 3 — an adherence PATTERN: a daily Evening supplement taken every day for
  // ~8 weeks EXCEPT every Friday. The weekday-miss rule then flags "you miss your
  // evening dose most Fridays" and suggests moving it earlier, on Supplements & Meds.
  // Fully synthetic. Idempotent: re-created from scratch each boot (the item + its
  // dose + logs), so today-relative dates stay correct across days.
  const ADHERE_ITEM = "Evening Vitamin C (e2e)";
  db.prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name = ?`).run(
    PROFILE_ID,
    ADHERE_ITEM
  );
  // Backdated created_at: the #430 lifetime clamp bounds each dose's adherence
  // strip to max(item created, dose created/re-timed), so the item + dose must
  // PREDATE the 63-day backfilled log window or the pattern rules see no history.
  const adhereBorn = `${shiftDateStr(today(PROFILE_ID), -70)} 08:00:00`;
  const adhereItemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
         (profile_id, name, condition, obligation, active, source, created_at)
         VALUES (?, ?, 'daily', 'must', 1, 'manual', ?)`
      )
      .run(PROFILE_ID, ADHERE_ITEM, adhereBorn).lastInsertRowid
  );
  const adhereDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at, updated_at)
       VALUES (?, '500 mg', 'Evening', 'any', 0, ?, ?)`
      )
      .run(adhereItemId, adhereBorn, adhereBorn).lastInsertRowid
  );
  const insAdhereLog = db.prepare(
    `INSERT OR IGNORE INTO intake_item_logs (dose_id, item_id, date, status)
   VALUES (?, ?, ?, 'taken')`
  );
  // 63 days back → nine Fridays in the window; log taken on every non-Friday.
  for (let i = 1; i <= 63; i++) {
    const date = shiftDateStr(today(PROFILE_ID), -i);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 5) continue; // Friday → missed (no taken-log)
    insAdhereLog.run(adhereDoseId, adhereItemId, date);
  }

  console.log(
    `e2e: seeded an every-Friday evening-dose miss pattern for ${ADHERE_ITEM} (#45 domain 3)`
  );
}

// ── Goal-pacing fixture (#45 domain 6, isolated by #2353) ──
//
// Domain 6 used to be asserted on PROFILE 1, against the base seed's "Reach 74 kg"
// and "Cut to 78 kg" goals. Goal pacing is a verdict over the profile's WEIGHT
// SERIES (buildGoalPacingFindings feeds getBodyMetricDailySeries into projectGoal),
// and profile 1's weight series is written by many specs — so the finding's
// existence depended on which of them had already run in the same worker. One
// earlier test saving a single 72.5 kg weight (palette-actions' "Log weight",
// #2184) bent the fitted pace steeply downwards, both seeded goals then projected
// as reaching EARLY, and the card rendered nothing. Because Playwright shards by
// test index, adding any spec file anywhere in the suite could slide that test in
// front of rule-findings.spec.ts and red an unrelated PR.
//
// So the case owns its fixture: a dedicated profile, its own weight series, its own
// goal, and its own member login. Nothing else in the suite writes here, so the
// verdict is a property of this data and of nothing else.
//
// The series RISES while the goal asks for a lower weight, which is the
// `status: "away"` branch — the one verdict that stays off pace no matter how the
// deadline moves, so the fixture cannot drift back on pace as the frozen clock
// changes. Twelve weekly points (≥ CONFIDENT_MIN_POINTS, perfectly collinear so the
// pairwise slopes don't scatter) keep the projection at confidence "ok", i.e. no
// "(rough estimate)" hedge. All values synthetic. Idempotent: the profile's own
// weights and goals are recreated from scratch each boot, so the today-relative
// dates stay correct across days.
export function seedGoalPacing(): void {
  const gpId = fixtureProfileId(GOAL_PACE_PROFILE);
  seedMemberLogin(E2E_LOGIN_GOAL_PACE, gpId, "write");
  const setGp = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  );
  // An adult, so /training is never age-gated for this login (lib/age-gate.ts).
  setGp.run(gpId, "birthdate", "1988-03-12");
  setGp.run(gpId, "sex", "male");

  const gpToday = today(gpId);
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(gpId);
  db.prepare(`DELETE FROM goals WHERE profile_id = ?`).run(gpId);

  // Weekly weigh-ins over the trailing pacing window (GOAL_PACE_WINDOW_DAYS = 90),
  // oldest first, creeping UP by 150 g a week.
  const GP_BASELINE_KG = 86.4;
  const GP_GAIN_PER_WEEK = 0.15;
  const insGpWeight = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
     VALUES (?, ?, ?, 'manual')`
  );
  for (let week = 11; week >= 1; week--) {
    insGpWeight.run(
      gpId,
      shiftDateStr(gpToday, -7 * week),
      GP_BASELINE_KG + (11 - week) * GP_GAIN_PER_WEEK
    );
  }

  // …and the goal that pace is measured against: down to 82 kg six weeks out, from a
  // baseline the trend has been moving away from ever since.
  const GP_GOAL_TITLE = "Reach 82 kg (e2e)";
  db.prepare(
    `INSERT INTO goals
       (profile_id, title, category, target_value, body_metric, baseline_value, target_date, status)
     VALUES (?, ?, 'body', 82, 'weight', ?, ?, 'active')`
  ).run(gpId, GP_GOAL_TITLE, GP_BASELINE_KG, shiftDateStr(gpToday, 45));

  console.log(
    `e2e: seeded goal-pacing fixture — profile ${gpId} (${GOAL_PACE_PROFILE}), "${GP_GOAL_TITLE}" off pace (#45 domain 6, #2353)`
  );
}

// ── Suppressed-center fixture ──
export function seedSuppressedCenter(): void {
  // ── Suppressed-center fixture (#1151) ─────────────────────────────────────────
  // A dedicated profile whose "Snoozed & dismissed" section spans all three
  // classes: a CARE snooze (future appointment), a COACHING dismissal (a
  // training-obs plateau key — no backing rows needed; the dismissal IS the fact),
  // and a SUGGESTION dismissal (a med-bridge key resolved purely from its prefix —
  // post-#1178/092 no backing medical_records 'prescription' row can exist, and a
  // dismissal that outlived its record is a REAL current-state shape, #1232).
  // Idempotent: the spec ALSO resets these suppression rows itself before each
  // test (retries / --repeat-each), so this boot-time seed only guarantees the
  // backing data + a first-run state. All synthetic.
  {
    const scId = fixtureProfileId(SUPPRESSED_PROFILE);
    seedMemberLogin(E2E_LOGIN_SUPPRESSED, scId, "write");
    const scToday = today(scId);

    // Backing appointment (future, scheduled) — recreated each boot so its date
    // stays in the future relative to the frozen clock.
    db.prepare(
      `DELETE FROM appointments WHERE profile_id = ? AND title = 'E2E Suppressed Appointment'`
    ).run(scId);
    const scApptId = Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, date, time_of_day, title, status)
         VALUES (?, ?, '10:00', 'E2E Suppressed Appointment', 'scheduled')`
        )
        .run(scId, shiftDateStr(scToday, 5)).lastInsertRowid
    );

    // The three suppression rows (the spec re-asserts these per test). The
    // med-bridge key needs no backing row — the section's resolver labels it from
    // the key alone (lib/suppression-display.ts), and Restore simply clears it.
    db.prepare(`DELETE FROM upcoming_dismissals WHERE profile_id = ?`).run(
      scId
    );
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until)
     VALUES (?, ?, ?)`
    ).run(scId, `appointment:${scApptId}`, shiftDateStr(scToday, 3));
    const scDismiss = db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
     VALUES (?, ?, datetime('now'))`
    );
    scDismiss.run(scId, "training-obs:plateau:e2e suppressed lift");
    scDismiss.run(scId, "med-bridge:e2e suppressed rx");

    console.log(
      `e2e: seeded suppressed-center fixture — profile ${scId} (${SUPPRESSED_PROFILE}), appointment ${scApptId} (#1151)`
    );
  }

  // #1119 — progress photos: a dedicated, initially PHOTO-LESS profile + write
  // member. The spec itself uploads/deletes photos (and clears the table for this
  // profile in beforeAll), so the seed only guarantees the login/profile exist —
  // keeping the data-gated nav flip and the exact-count grid assertions isolated
  // from profile 1 (whose sidebar order nav-consolidation.spec.ts pins verbatim).
  {
    const photosId = fixtureProfileId(PROGRESS_PHOTOS_PROFILE);
    seedMemberLogin(E2E_LOGIN_PHOTOS, photosId, "write");
    console.log(
      `e2e: seeded progress-photos fixture — profile ${photosId} (${PROGRESS_PHOTOS_PROFILE}) (#1119)`
    );
  }

  // #1224 — video capture: a dedicated ADULT profile (birthdate so /training isn't
  // age-gated) with ONE seeded strength activity the spec attaches a form-check clip
  // to. The spec clears the profile's activity_videos / symptom_videos rows itself,
  // so its clip counts stay isolated. Idempotent for a reused server.
  {
    const videoId = fixtureProfileId(VIDEO_PROFILE);
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1990-04-01')`
    ).run(videoId);
    db.prepare(
      `INSERT OR IGNORE INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', 'female')`
    ).run(videoId);
    const hasActivity = db
      .prepare(
        `SELECT id FROM activities WHERE profile_id = ? AND title = 'Squat session (e2e)'`
      )
      .get(videoId) as { id: number } | undefined;
    if (!hasActivity) {
      db.prepare(
        `INSERT INTO activities (profile_id, date, type, title, source)
         VALUES (?, ?, 'strength', 'Squat session (e2e)', 'manual')`
      ).run(videoId, today(videoId));
    }
    seedMemberLogin(E2E_LOGIN_VIDEO, videoId, "write");
    console.log(
      `e2e: seeded video-capture fixture — profile ${videoId} (${VIDEO_PROFILE}) (#1224)`
    );
  }

  // The stamped day's max temperature — comfortably over the #1726 heatwave ENTRY
  // bound (32 °C), so three consecutive such days genuinely make today notable AND give
  // the journal card an unmistakable figure. Kept above the bound rather than at it, so
  // the fixture doesn't sit on the hysteresis edge the predicate exists to smooth.
  const WEATHER_STAMP_TEMP_C = 34;

  // #1172 — the Open-Meteo weather/UV integration + two-sided UV-dose sun model. A
  // dedicated adult profile seeded so the weather spec is fully isolated from profile
  // 1: a coarse home location (New York; timezone matched so the local hour labels line
  // up), Fitzpatrick skin type II, the weather connection ENABLED, an outdoor daytime
  // activity TODAY (10:00–12:00, avg_temp_c present = the outdoor signal), and cached
  // LIVE UV for that day+location — so /integrations/weather renders Connected and the
  // timeline renders the live UV badge. All UV values are low-entropy synthetic.
  {
    const wxId = fixtureProfileId(WEATHER_PROFILE);
    seedMemberLogin(E2E_LOGIN_WEATHER, wxId, "write");
    const wxTz = "America/New_York";
    const wxLat = 40.7;
    const wxLng = -74;
    // Home location + timezone + skin type (profile_settings key/value — no migration).
    const setPS = db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    );
    setPS.run(wxId, "home_lat", String(wxLat));
    setPS.run(wxId, "home_lng", String(wxLng));
    setPS.run(wxId, "timezone", wxTz);
    setPS.run(wxId, "skin_type", "2");
    // Today in the profile's timezone (YYYY-MM-DD).
    const wxToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: wxTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    // The two seeded runs' instants, an hour and two hours before the frozen clock —
    // the SAME derivation weather-uv.spec.ts reads them back with.
    const wxNow = clockNow();
    const WX_SYNC_EVENTS = [
      syncInstantBefore(wxNow, 2),
      syncInstantBefore(wxNow, 1),
    ];
    // Enable the keyless weather connection (the enable flag the tick + grid read).
    upsertConnection(wxId, "weather", { status: "connected", config: null });
    // An outdoor daytime walk today, well inside the daylight window.
    db.prepare(
      `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, avg_temp_c)
     VALUES (?, ?, 'cardio', 'Lunch walk', '10:00', '12:00', 20)`
    ).run(wxId, wxToday);
    // Cached live UV (+ irradiance) for the location's hours that day — the values the
    // dose model crosses with the walk. High-ish UV so the badge is unmistakable; the
    // overexposure side needs the skin type above.
    const insUv = db.prepare(
      `INSERT INTO weather_uv_hours
       (lat, lng, hour_ts, uv_index, uv_index_clear_sky,
        shortwave_radiation, direct_radiation, diffuse_radiation, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open-meteo')
     ON CONFLICT(lat, lng, hour_ts) DO NOTHING`
    );
    for (const [hr, uv] of [
      ["10", 7],
      ["11", 8],
      ["12", 8],
    ] as [string, number][]) {
      insUv.run(wxLat, wxLng, `${wxToday}T${hr}:00`, uv, uv + 1, 600, 500, 100);
    }
    // ---- Conditions stamps + notable Timeline days (#1728) ----
    // An outdoor RIDE today (the outdoor catalog flag decides which sessions get a
    // stamp; the walk above is deliberately not an outdoor-flagged name, so only this
    // one is stamped) plus a cached DAILY row for its day, so the journal card renders
    // "31°C · clear". A three-day hot spell ending today additionally makes today a
    // NOTABLE day under the #1726 heatwave predicate, so the Timeline day header
    // carries its conditions summary — quiet by default, notable by exception.
    db.prepare(
      `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, duration_min)
     VALUES (?, ?, 'cardio', 'Cycling', '07:00', '08:00', 60)`
    ).run(wxId, wxToday);
    const insDay = db.prepare(
      `INSERT INTO weather_days
         (lat, lng, date, temp_max_c, temp_min_c, precipitation_mm, weather_code, source)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'e2e')
       ON CONFLICT(lat, lng, date) DO NOTHING`
    );
    for (let back = 2; back >= 0; back--) {
      const d = new Date(`${wxToday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - back);
      insDay.run(
        wxLat,
        wxLng,
        d.toISOString().slice(0, 10),
        WEATHER_STAMP_TEMP_C,
        22
      );
    }

    // ---- Forecast-ahead planning (#1724 part 5) ----
    // A behind weekly CARDIO target plus a season of rides (so the tolerance envelope is
    // REVEALED, not assumed) plus a forecast whose only dry day is two days out — the
    // scarcity that makes the plan signal rather than filler. The week is pinned to
    // START TODAY so the fixture always has a full six remaining on-days regardless of
    // which weekday CI runs on; with a fixed week start the days-left count drifts and
    // the plan would appear on a Monday and vanish on a Friday.
    setPS.run(wxId, "week_mode", "calendar");
    setPS.run(
      wxId,
      "week_start",
      String(new Date(`${wxToday}T12:00:00Z`).getUTCDay())
    );
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'type', 'cardio', 2)`
    ).run(wxId);
    const shiftWx = (n: number): string => {
      const d = new Date(`${wxToday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    // A season of rides in mild-to-warm conditions.
    [10, 12, 14, 16, 18, 20, 22, 24].forEach((t, i) => {
      const date = shiftWx(-7 * (i + 1));
      db.prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'cardio', 'Cycling', 60)`
      ).run(wxId, date);
      insDay.run(wxLat, wxLng, date, t, t - 6);
    });
    // The week ahead: wet everywhere except day+2. (Today itself is already cached hot
    // above, which is fine — the plan names the best FUTURE window.)
    const insWet = db.prepare(
      `INSERT INTO weather_days
         (lat, lng, date, temp_max_c, temp_min_c, precipitation_mm, weather_code, source)
       VALUES (?, ?, ?, 16, 10, ?, 61, 'e2e')
       ON CONFLICT(lat, lng, date) DO UPDATE SET
         temp_max_c = excluded.temp_max_c,
         precipitation_mm = excluded.precipitation_mm`
    );
    for (let i = 1; i <= 6; i++) {
      insWet.run(wxLat, wxLng, shiftWx(i), i === 2 ? 0 : 60);
    }

    // Two successful weather syncs so the profile's Connected-sources card renders
    // with a latest-state line AND an expandable history (#1614): before that fix
    // Weather was excluded from getConnectedSources by kind, so the "Sync history"
    // link on its own setup page led nowhere.
    //
    // Dated RELATIVE TO THE FROZEN RUN CLOCK, an hour and two hours back. The standing
    // composes the silence tolerance (#1685, unified in #2263), and weather's is 12
    // hours — so a fixed time-of-day would read as a silent stop and flip this healthy
    // fixture to "Sync failing" for every run that starts more than twelve hours after
    // it. The WINDOW stamps stay fixed — they are data, not freshness.
    ins.run(
      wxId,
      "weather",
      WX_SYNC_EVENTS[0],
      1,
      "2026-06-25",
      "2026-07-09",
      336, // received
      336, // written
      336, // inserted
      0, // updated
      0, // unchanged
      0, // skipped
      null, // raw_ref
      null
    );
    ins.run(
      wxId,
      "weather",
      WX_SYNC_EVENTS[1],
      1,
      "2026-06-25",
      "2026-07-09",
      336, // received
      336, // written
      12, // inserted
      4, // updated
      320, // unchanged
      0, // skipped
      null, // raw_ref
      null
    );
    console.log(
      `e2e: seeded weather/UV fixture — profile ${wxId} (${WEATHER_PROFILE}), day ${wxToday} (#1172)`
    );
  }
}

// ── Paired observations ──
export function seedPairedObservations(): void {
  // ── Paired-observations fixture (#2177) ───────────────────────────────────────
  // #2177's motivating fixture, laid on real days for a dedicated ADULT profile: 30
  // evenings ending yesterday, 21 of them carrying one standard drink (the curated
  // `alcohol` food group — a standard drink IS one serving, #998), each with the
  // overnight HRV recorded on the morning AFTER. Drink evenings run 7-in-10 so both
  // arms appear in both halves of the window (the spread gate), and the arm values are
  // the issue's measured means, so Trends → Insights renders "42 ms" vs "54 ms" with
  // n=21 and n=9. Its own profile: the arms span the whole 90-day window, so any shared
  // profile's stray drink or HRV row would move the numbers the spec asserts.
  // Idempotent; synthetic only.
  const poId = fixtureProfileId(PAIRED_OBS_PROFILE);
  seedMemberLogin(E2E_LOGIN_PAIRED_OBS, poId, "write");
  // An adult: the substance pairs are adult CONTENT (#1174/#1279), declared per row
  // in the registry's `adultOnly` field.
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', '1985-06-04')
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(poId);

  const poToday = today(poId);
  db.prepare(
    `DELETE FROM food_log WHERE profile_id = ? AND group_key = 'alcohol'`
  ).run(poId);
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'hrv_ms'`
  ).run(poId);
  db.prepare(
    `DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'paired-obs:%'`
  ).run(poId);

  const insDrink = db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, 'alcohol', 1)
       ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
  );
  const insHrv = db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'oura', 'hrv_ms', ?, ?, ?, ?)`
  );
  for (let i = 0; i < 30; i++) {
    const evening = shiftDateStr(poToday, -(i + 1));
    const morning = shiftDateStr(poToday, -i);
    const drank = i % 10 < 7;
    if (drank) insDrink.run(poId, evening);
    insHrv.run(
      poId,
      morning,
      `${morning}T02:00:00Z`,
      `${morning}T02:05:00Z`,
      drank ? 42.4 : 54.4
    );
  }

  console.log(
    `e2e: seeded paired-observations fixture — profile ${poId} (${PAIRED_OBS_PROFILE}), alcohol↔HRV 21 vs 9 nights (#2177)`
  );
}
