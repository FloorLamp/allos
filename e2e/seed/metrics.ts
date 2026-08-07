// e2e seed fixtures — metrics domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import path from "node:path";
import { db, today } from "../../lib/db";
import {
  shiftDateStr,
  utcMinute,
  utcSqlString,
  zonedWallTimeToUtc,
} from "../../lib/date";
import { practiceIdentity } from "../../lib/practice";
import { EDIT_LOCK_SIGNATURE } from "../edit-lock-fixture";
import {
  E2E_LOGIN_COMPARE,
  E2E_LOGIN_BADGE,
  E2E_LOGIN_BULKFIX,
  BULKFIX_PROFILE,
  E2E_LOGIN_SHELL,
  SHELL_PROFILE,
  SHELL_DOSE_ITEM,
  SHELL_DOSE_AMOUNT,
  SHELL_PRACTICE,
  SHELL_PRACTICE_PER_WEEK,
  E2E_LOGIN_VITALS_DAY,
  VITALS_DAY_PROFILE,
  VITALS_DAY_TEMP_TIME,
  VITALS_DAY_RESTING_HR,
  VITALS_DAY_WEIGHT_KG,
  VITALS_DAY_BODY_FAT,
  VITALS_DAY_STEPS,
  APP_BADGE_PROFILE,
  SOURCE_COMPARE_PROFILE,
  E2E_LOGIN_CEL_IMPORT,
  CEL_IMPORT_PROFILE,
  E2E_LOGIN_SUN,
  SUN_PROFILE,
  E2E_LOGIN_SKIN_TEMP,
  SKIN_TEMP_PROFILE,
  E2E_LOGIN_SUN_NOHOME,
  SUN_NOHOME_PROFILE,
  E2E_LOGIN_NWAY,
  NWAY_PROFILE,
  E2E_LOGIN_INTRADAY,
  INTRADAY_PROFILE,
  INTRADAY_ACTIVITY,
  INTRADAY_TICK_DOC,
  INTRADAY_TICK_TIME,
} from "../fixture-logins";
import { seedNwayMergeFixture } from "../nway-merge-fixture";
import { getTimezone } from "../../lib/settings";
import { PROFILE_ID, ins, seedMemberLogin, fixtureProfileId } from "./common";

// ── Multi-source metric fixture ──
export function seedMultiSourceMetric(): void {
  // The coaching block (./coaching's seedRestEpisode) anchors this same date; it
  // resolves from the profile's today(), so recomputing here is identical.
  const COACH_TODAY = today(PROFILE_ID);
  // ── Multi-source metric fixture (issue #14) ───────────────────────────────────
  // The SAME metric (nightly HRV) reported by TWO sources — Health Connect and
  // Oura — over the last five nights, so the Trends → Body "Compare sources"
  // overlay has something to render and the primary-source picker can be
  // exercised. HRV is a point (AVG) metric with no standalone Body-tab chart, so
  // this fixture can't disturb the sleep/SRI/zone fixtures above or the seeded
  // charts. Values are plausible synthetic ms figures — no PHI. Idempotent: clear
  // this window's rows for both sources first. Each source keys its own window
  // (source is part of the metric_samples unique key), slightly offset like real
  // devices.
  const insHrv = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, ?, 'hrv_ms', ?, ?, ?, ?)`
  );
  for (let i = 1; i <= 5; i++) {
    const wakeDay = shiftDateStr(COACH_TODAY, -i);
    const bedDay = shiftDateStr(wakeDay, -1);
    db.prepare(
      `DELETE FROM metric_samples
      WHERE profile_id = ? AND metric = 'hrv_ms' AND date = ?
        AND source IN ('health-connect','oura')`
    ).run(PROFILE_ID, wakeDay);
    insHrv.run(
      PROFILE_ID,
      "health-connect",
      wakeDay,
      `${bedDay}T23:00:00Z`,
      `${wakeDay}T07:00:00Z`,
      42 + i
    );
    insHrv.run(
      PROFILE_ID,
      "oura",
      wakeDay,
      `${bedDay}T23:05:00Z`,
      `${wakeDay}T07:10:00Z`,
      55 + i
    );
  }
  console.log(
    "e2e: seeded 5 nights of two-source HRV for profile 1 (compare sources, #14)"
  );
}

// ── Two-document body-metric source comparison ──
export function seedSourceCompare(): void {
  // ── Two-document body-metric source comparison (issue #533) ───────────────────
  // A metric extracted from TWO different documents stays two distinct series, but
  // the legend/picker used to collapse both to one "Document" label and one teal
  // color. Seed two DEXA-style documents on a DEDICATED member profile plus a
  // body-fat reading sourced from each (source 'document:<id>') and one manual
  // reading, so Trends → Body's "Compare sources" renders a body_fat card whose two
  // document series carry distinct filenames + colors. Dedicated profile ON PURPOSE
  // (first landing tried profile 1 and broke two sibling specs): extra documents on
  // profile 1 pluralize review-inbox's re-extract-all "1 scan/PDF" copy, and a
  // multi-source body_fat adds a second "Body fat" heading (the compare card's h3)
  // that collides kids-growth's strict heading locator. Distinct dates per row so
  // the profile never grows a same-day body-metric conflict.
  const compareProfileId = fixtureProfileId(SOURCE_COMPARE_PROFILE);
  seedMemberLogin(E2E_LOGIN_COMPARE, compareProfileId);
  db.prepare(
    `DELETE FROM medical_documents WHERE profile_id = ? AND filename IN ('e2e-dexa-a.pdf', 'e2e-dexa-b.pdf')`
  ).run(compareProfileId);
  const insCompareDoc = db.prepare(
    `INSERT INTO medical_documents
     (profile_id, filename, stored_path, mime_type, size_bytes, doc_type, source,
      document_date, extraction_status, extracted_count, content_hash, uploaded_at)
   VALUES (?, ?, ?, 'application/pdf', 1024, 'dexa', 'upload', ?, 'done', 1, ?, ?)`
  );
  const compareDocs: { id: number; date: string; bodyFat: number }[] = [];
  for (const [filename, date, bodyFat] of [
    ["e2e-dexa-a.pdf", "2022-11-01", 21.4],
    ["e2e-dexa-b.pdf", "2022-11-03", 19.8],
  ] as const) {
    const id = Number(
      insCompareDoc.run(
        compareProfileId,
        filename,
        `data/uploads/medical/${compareProfileId}/${filename}`,
        date,
        `e2e533${filename.replace(/\W/g, "")}`.padEnd(64, "0"),
        `${date} 08:00:00`
      ).lastInsertRowid
    );
    compareDocs.push({ id, date, bodyFat });
  }
  // Reset the profile's body metrics wholesale (it owns nothing else), then one
  // row per document + one manual row on distinct dates.
  db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(
    compareProfileId
  );
  for (const { id, date, bodyFat } of compareDocs) {
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, body_fat_pct, source)
     VALUES (?, ?, ?, ?)`
    ).run(compareProfileId, date, bodyFat, `document:${id}`);
  }
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, body_fat_pct, source)
   VALUES (?, '2022-11-05', 20.6, NULL)`
  ).run(compareProfileId);
  console.log(
    `e2e: seeded two-document body-fat source comparison on profile ${compareProfileId} (#533)`
  );

  // An uncatalogued biomarker lab so the Coverage gaps page (#550) has a real
  // derivable gap to opt into. The canonical name is deliberately synthetic and
  // absent from every curated seed / #482 family, so detection surfaces it as a
  // candidate. Idempotent: cleared then re-inserted on each seed run.
  const COVERAGE_GAP_ANALYTE = "Serum Fictionase (e2e)";
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
  ).run(PROFILE_ID, COVERAGE_GAP_ANALYTE);
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, value_num, unit, canonical_name)
   VALUES (?, '2026-05-01', 'lab', ?, 42, 'U/L', ?)`
  ).run(PROFILE_ID, COVERAGE_GAP_ANALYTE, COVERAGE_GAP_ANALYTE);
  console.log(
    `e2e: seeded uncatalogued biomarker "${COVERAGE_GAP_ANALYTE}" on profile ${PROFILE_ID} for coverage gaps (#550)`
  );

  // Deterministic biomarker→food suggestion fixtures (#577). Currently-flagged-LOW
  // diet-responsive readings on profile 1 so the food-suggestion surfaces render, and a
  // synthetic "fish" allergy so the omega-3 suggestion shows its algae/ALA ALTERNATIVE
  // (the allergy screen). The seeded Warfarin med (scripts/seed.ts) supplies the
  // MEDICATION screen — the folate suggestion carries the vitamin-K consistency note.
  // Idempotent: cleared by canonical_name then re-inserted; value_num is genuinely below
  // the reference low so the flag stays 'low' through any reconcile.
  for (const bm of [
    { name: "Omega-3 Total (OmegaCheck)", value: 3.0, unit: "% by wt" },
    { name: "Folate", value: 2.0, unit: "ng/mL" },
    // #774: an expanded-coverage low nutrient (selenium → brazil nuts).
    { name: "Selenium", value: 45, unit: "ug/L" },
  ]) {
    db.prepare(
      `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
    ).run(PROFILE_ID, bm.name);
    db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value_num, value, unit, canonical_name, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'low')`
    ).run(
      PROFILE_ID,
      shiftDateStr(today(PROFILE_ID), -7),
      bm.name,
      bm.value,
      String(bm.value),
      bm.unit,
      bm.name
    );
  }
  // #775: a flagged-HIGH core-panel reading so the REDUCE direction renders (high LDL →
  // cut-back on fried food / processed meat). Kept off omega-3 so it can't disturb the
  // existing omega-3-alternative assertions. Idempotent by canonical_name.
  {
    const name = "LDL Cholesterol";
    db.prepare(
      `DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = ?`
    ).run(PROFILE_ID, name);
    db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value_num, value, unit, canonical_name, flag)
     VALUES (?, ?, 'lab', ?, 190, '190', 'mg/dL', ?, 'high')`
    ).run(PROFILE_ID, shiftDateStr(today(PROFILE_ID), -7), name, name);
  }
  if (
    !db
      .prepare(
        `SELECT 1 FROM allergies WHERE profile_id = ? AND substance = 'fish' COLLATE NOCASE`
      )
      .get(PROFILE_ID)
  ) {
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, reaction, severity, status, source)
     VALUES (?, 'fish', 'Hives', 'moderate', 'active', 'manual')`
    ).run(PROFILE_ID);
  }
  console.log(
    `e2e: seeded low omega-3/folate/selenium (#577/#774) + high LDL (#775 reduce) readings and a fish allergy on profile ${PROFILE_ID} for food suggestions`
  );

  // A hand-edited imported body-metric row (the user-edit lock, #133) on the default
  // profile so the Trends → Body edit-lock badge + "Resume sync updates" affordance
  // (#659) has a row to render. Synthetic value; source is an integration so the row
  // is genuinely sync-owned (only those carry the lock).
  // The date MUST be a day with no other body-metric row: a Withings weight sharing a
  // day with a manual weight registers as a same-day body-metric conflict
  // (getBodyMetricConflicts) and silently inflates the Data → Review badge, which
  // import-dedup.spec asserts exactly. The old fixed date ('2026-06-05', chosen as a
  // gap when the cadence landed on 06-02/06-09) was a TIME BOMB: scripts/seed.ts's
  // weekly manual weigh-ins are TODAY-relative, so the cadence drifts one day per day
  // and periodically lands ON any fixed date (it hit 06-05 on 2026-07-18 and broke CI
  // suite-wide). Compute a guaranteed-free day instead, anchored ~6 weeks back like
  // the original. Idempotent: the fixture row is re-keyed by its synthetic signature
  // (source + exact weight — the shared EDIT_LOCK_SIGNATURE that edit-lock-badge.spec's
  // beforeEach restores the lock by), so prior seeds' copies are removed wherever they
  // landed.
  db.prepare(
    `DELETE FROM body_metrics WHERE profile_id = ? AND source = ? AND weight_kg = ?`
  ).run(PROFILE_ID, EDIT_LOCK_SIGNATURE.source, EDIT_LOCK_SIGNATURE.weightKg);
  let editLockDate = shiftDateStr(today(PROFILE_ID), -43);
  while (
    db
      .prepare(`SELECT 1 FROM body_metrics WHERE profile_id = ? AND date = ?`)
      .get(PROFILE_ID, editLockDate)
  ) {
    editLockDate = shiftDateStr(editLockDate, 1);
  }
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, source, edited)
   VALUES (?, ?, ?, ?, 1)`
  ).run(
    PROFILE_ID,
    editLockDate,
    EDIT_LOCK_SIGNATURE.weightKg,
    EDIT_LOCK_SIGNATURE.source
  );
  console.log(
    `e2e: seeded an edit-locked (hand-edited) Withings body-metric row on ${editLockDate} (computed cadence-free day) for the edit-lock badge (#659)`
  );

  // A permanently-OPEN weekly frequency target for the pace-tone spec (#780/#782): a
  // region target on Glutes, the ONE muscle region no seeded exercise maps to
  // (regionForExercise: Deadlift/Row/Pull Up → Back, Squat/RDL/Leg Press/Leg Curl/
  // Calf Raise → Legs, Plank → Core — nothing Glutes-primary in scripts/seed.ts or
  // this file), so the seeded history can never satisfy it in ANY week. The dashboard
  // Goals-and-habits card hides MET habits, and by mid-week the four scripts/seed.ts
  // targets are all met — leaving zero chips and a day-of-week-dependent spec. This
  // target stays 0/5 all week → always at least one open chip, whose pace is
  // "on-pace" (day 1) or "behind" (later) — never met, never rose — exactly the
  // invariant pace-tone.spec.ts pins. Idempotent by (profile, kind, value).
  db.prepare(
    `DELETE FROM frequency_targets
    WHERE profile_id = ? AND scope_kind = 'region' AND scope_value = 'Glutes'`
  ).run(PROFILE_ID);
  db.prepare(
    `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
   VALUES (?, 'region', 'Glutes', 5)`
  ).run(PROFILE_ID);
  console.log(
    `e2e: seeded a never-satisfiable Glutes 5x/week frequency target on profile ${PROFILE_ID} for pace-tone.spec (#780)`
  );
}

// ── Legacy imported-Celsius temperature ──
export function seedLegacyCelsius(): void {
  // ── Legacy imported-Celsius temperature fixture (#1018) ───────────────────────
  // A dedicated sick profile whose ONLY temperature is a LEGACY imported Celsius
  // row — unit 'Cel', source 'ccd', external_id set, flag never derived — exactly
  // the shape the CCDA mapper stored before the import-boundary conversion. Seeded
  // AFTER boot (so migration 074 / the flag reconcile never touch it), it proves
  // the episode read gate in the browser: the cockpit's latest temperature renders
  // the CONVERTED 101.3 °F, never raw "38.5" on the °F axis. Spec-owned + read-only
  // (imported-temp-unit.spec.ts); the situation/episode mirrors seedSickEpisode.
  const celImportId = fixtureProfileId(CEL_IMPORT_PROFILE);
  {
    const on = today(celImportId);
    const existingSit = db
      .prepare(
        "SELECT id FROM situations WHERE profile_id = ? AND name = 'Illness'"
      )
      .get(celImportId) as { id: number } | undefined;
    const sitId =
      existingSit?.id ??
      Number(
        db
          .prepare(
            "INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)"
          )
          .run(celImportId).lastInsertRowid
      );
    db.prepare(
      "UPDATE situations SET active = 1, illness_type = 1 WHERE id = ?"
    ).run(sitId);
    db.prepare("DELETE FROM illness_episodes WHERE profile_id = ?").run(
      celImportId
    );
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
    ).run(celImportId, shiftDateStr(on, -1));
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, 'fever', 2, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
    ).run(celImportId, on);
    // Idempotent for a reused dev server: this profile owns exactly one reading.
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND canonical_name = 'Body Temperature'"
    ).run(celImportId);
    db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit,
        canonical_name, source, external_id, notes)
     VALUES (?, ?, 'vitals', 'Body temperature', '38.5', 38.5, 'Cel',
             'Body Temperature', 'ccd', 'ccda:vital:8310-5:e2e-cel:38.5', '09:00')`
    ).run(celImportId, on);
  }
  seedMemberLogin(E2E_LOGIN_CEL_IMPORT, celImportId, "write");
  console.log(
    `e2e: seeded legacy imported-Cel temperature fixture — profile ${celImportId} (${CEL_IMPORT_PROFILE}) (#1018)`
  );
}

// ── Sun / outdoor + free-days ──
export function seedSunOutdoor(): void {
  // ── Sun / outdoor + free-days fixtures (issues #1171, #1241) ───────────────────
  // A dedicated adult profile with a coarse home location (sun features ON) and outdoor
  // DAYTIME activities on several recent days, so Trends → Vitals renders the "Sun /
  // outdoor time" chart over a real multi-day series. The free-days setting spec (#1241)
  // also drives this profile's Settings → Profile checkbox row. Isolated from profile 1
  // so neither the chart reads nor the free_days toggle perturb the shared sleep specs.
  {
    const sunId = fixtureProfileId(SUN_PROFILE);
    const sunTz = "America/New_York";
    const setSunPS = db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    );
    setSunPS.run(sunId, "home_lat", "40.7");
    setSunPS.run(sunId, "home_lng", "-74");
    setSunPS.run(sunId, "timezone", sunTz);
    const sunToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: sunTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    // Outdoor midday walks on four distinct recent days (avg_temp_c present = the
    // persisted outdoor signal), each safely inside the daylight window → four chart
    // points. Idempotent by external_id for a reused dev server.
    const insSunWalk = db.prepare(
      `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, avg_temp_c, source, external_id)
     SELECT ?, ?, 'cardio', 'Outdoor walk', '10:00', '11:30', 19, 'manual', ?
      WHERE NOT EXISTS (SELECT 1 FROM activities WHERE external_id = ?)`
    );
    for (const back of [0, 3, 7, 12]) {
      const d = shiftDateStr(sunToday, -back);
      const ext = `e2e:sun-walk-${back}`;
      insSunWalk.run(sunId, d, ext, ext);
    }
    seedMemberLogin(E2E_LOGIN_SUN, sunId, "write");

    // The home-less negative case: an outdoor walk today but NO home location, so the
    // sun features stay off and the chart is hidden even though the outdoor signal exists.
    const sunNoHomeId = fixtureProfileId(SUN_NOHOME_PROFILE);
    const nhExt = "e2e:sun-nohome-walk";
    db.prepare(
      `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, avg_temp_c, source, external_id)
     SELECT ?, ?, 'cardio', 'Outdoor walk', '10:00', '11:30', 19, 'manual', ?
      WHERE NOT EXISTS (SELECT 1 FROM activities WHERE external_id = ?)`
    ).run(sunNoHomeId, sunToday, nhExt, nhExt);
    seedMemberLogin(E2E_LOGIN_SUN_NOHOME, sunNoHomeId, "write");

    console.log(
      `e2e: seeded sun/outdoor + free-days fixture — profile ${sunId} (${SUN_PROFILE}), no-home ${sunNoHomeId} (${SUN_NOHOME_PROFILE}) (#1171/#1241)`
    );

    // Skin temperature variation: nightly signed deltas from the tracker's own
    // baseline, one per night over five recent nights. The values straddle zero
    // deliberately — a negative night is the normal case, and it is the shape a
    // `min: 0` bound or an additive aggregation would visibly destroy.
    const skinId = fixtureProfileId(SKIN_TEMP_PROFILE);
    setSunPS.run(skinId, "timezone", sunTz);
    const insSkinTemp = db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       SELECT ?, 'health-connect', 'skin_temp_delta_c', ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM metric_samples
           WHERE profile_id = ? AND metric = 'skin_temp_delta_c' AND date = ?
        )`
    );
    const skinDeltas = [-0.1, 0.2, -0.3, 0.6, 0.1];
    skinDeltas.forEach((delta, i) => {
      const d = shiftDateStr(sunToday, -(skinDeltas.length - 1 - i));
      const at = `${d}T03:20:00Z`;
      insSkinTemp.run(skinId, d, at, at, delta, skinId, d);
    });
    seedMemberLogin(E2E_LOGIN_SKIN_TEMP, skinId, "write");
    console.log(
      `e2e: seeded skin-temperature-variation fixture — profile ${skinId} (${SKIN_TEMP_PROFILE})`
    );
  }

  // #1081 — N-way activity duplicate merge fixture. A dedicated adult member profile,
  // isolated from profile 1 so the Review cluster + Journal multi-merge specs (which
  // CONSUME their rows) never race a neighbor. The spec re-seeds both groups in
  // beforeEach; here we create the profile + login and lay down an initial state. Dates
  // are RELATIVE to the frozen clock so the Journal group lands on the feed's first page.
  {
    const nwayId = fixtureProfileId(NWAY_PROFILE);
    const reviewDate = shiftDateStr(today(nwayId), -3);
    const journalDate = shiftDateStr(today(nwayId), -2);
    const conflictDate = shiftDateStr(today(nwayId), -4);
    seedNwayMergeFixture(db, nwayId, reviewDate, journalDate, conflictDate);
    seedMemberLogin(E2E_LOGIN_NWAY, nwayId, "write");
    console.log(
      `e2e: seeded N-way merge fixture — profile ${nwayId} (${NWAY_PROFILE}) (#1081)`
    );
  }
}

// ── Intraday panel ──
export function seedIntradayPanel(): void {
  // ── Intraday panel fixture (issue #1068) ─────────────────────────────────────
  // The Timeline single-day view's intraday panel — the day rotated 90°. A dedicated
  // profile so the panel's layers are deterministic without perturbing profile 1 (whose
  // hr_minutes exist ONLY inside the zone-ride window that training-zones.spec pins).
  //
  // TODAY carries every layer: an overnight sleep session that STARTED before midnight
  // (clipped at the left edge, never re-attributed) with one deep-stage sub-band,
  // per-minute HR from midnight through mid-morning with a workout spike, a windowed
  // cardio activity (the workout block), and two clock-timed document uploads (the tick
  // rail). Because the day is today, the now-marker renders too.
  //
  // THREE DAYS BACK carries only a weigh-in — a real feed event with NO clock time — so
  // the same profile proves the data gate: the day renders, the panel does not.
  //
  // Timezone discipline (#1417): the profile INHERITS the run's pinned instance timezone
  // (frozen local ~13:00), so every absolute instant here is built through
  // zonedWallTimeToUtc(getTimezone(id), …)!. hr_minutes.ts is a UTC INSTANT since migration 164 (#2205), so its minutes convert through the same helper; by design
  // (#94), so those are seeded as wall-clock minute strings — exactly what the ingest
  // writes. Idempotent: this profile's fixture rows are cleared first.
  {
    const idId = fixtureProfileId(INTRADAY_PROFILE);
    const idTz = getTimezone(idId);
    const idToday = today(idId);
    const idPrev = shiftDateStr(idToday, -1);
    const idQuiet = shiftDateStr(idToday, -3);
    const idInstant = (day: string, hhmm: string) =>
      utcSqlString(zonedWallTimeToUtc(idTz, day, hhmm)!);
    const idIso = (day: string, hhmm: string) =>
      zonedWallTimeToUtc(idTz, day, hhmm)!.toISOString();

    db.prepare("DELETE FROM hr_minutes WHERE profile_id = ?").run(idId);
    db.prepare("DELETE FROM metric_samples WHERE profile_id = ?").run(idId);
    db.prepare("DELETE FROM activities WHERE profile_id = ?").run(idId);
    db.prepare("DELETE FROM medical_documents WHERE profile_id = ?").run(idId);
    db.prepare("DELETE FROM body_metrics WHERE profile_id = ?").run(idId);

    // Layer 1 — per-minute HR. Overnight rest sampled every 5 minutes (00:00–06:55),
    // then continuous minutes through the ride: an easy warm-up, the 08:00–09:00 effort,
    // and the recovery tail. Wear stops at 09:30, so the line simply ends there.
    const insIdHr = db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
     VALUES (?, ?, ?, ?, ?, 6, 'health-connect')`
    );
    const idHrStamp = (minute: number) =>
      utcMinute(
        zonedWallTimeToUtc(
          idTz,
          idToday,
          `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
            minute % 60
          ).padStart(2, "0")}`
        )!
      );
    for (let m = 0; m < 7 * 60; m += 5) {
      insIdHr.run(idId, idHrStamp(m), 52, 48, 57);
    }
    for (let m = 7 * 60; m <= 9 * 60 + 30; m++) {
      const bpm = m < 8 * 60 ? 78 : m < 9 * 60 ? 138 : 92;
      insIdHr.run(idId, idHrStamp(m), bpm, bpm - 4, bpm + 5);
    }

    // Layer 2 — the overnight session (23:20 → 06:35) plus one windowed deep stage.
    const insIdSample = db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', ?, ?, ?, ?, ?)`
    );
    insIdSample.run(
      idId,
      "sleep_min",
      idToday,
      idIso(idPrev, "23:20"),
      idIso(idToday, "06:35"),
      435
    );
    insIdSample.run(
      idId,
      "sleep_deep_min",
      idToday,
      idIso(idToday, "01:10"),
      idIso(idToday, "02:20"),
      70
    );

    // Layer 3 — the windowed workout block.
    db.prepare(
      `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, intensity,
        start_time, end_time, components, source, external_id)
     VALUES (?, ?, 'cardio', ?, 60, 22, 'moderate', '08:00', '09:00', ?, 'manual',
             'e2e:intraday-ride')`
    ).run(
      idId,
      idToday,
      INTRADAY_ACTIVITY,
      JSON.stringify([
        { name: "Cycling", type: "cardio", distance_km: 22, duration_min: 60 },
      ])
    );

    // Layer 4 — clock-timed feed events for the tick rail. Two document uploads at
    // known LOCAL wall times (the timeline derives an event's clock time from
    // uploaded_at in the profile's zone), one of them in a terminal failed state so a
    // tone-colored tick is exercised alongside a neutral one.
    const insIdDoc = db.prepare(
      `INSERT INTO medical_documents
       (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
        extraction_status, extracted_count, uploaded_at)
     VALUES (?, ?, '', 'application/pdf', 2048, 'Lab report', ?, ?, ?)`
    );
    insIdDoc.run(
      idId,
      INTRADAY_TICK_DOC,
      "done",
      3,
      idInstant(idToday, INTRADAY_TICK_TIME)
    );
    insIdDoc.run(
      idId,
      "e2e-intraday-evening-panel.pdf",
      "failed",
      0,
      idInstant(idToday, "19:40")
    );

    // #1512 C — an AI insight ON the intraday day. It is stamped by the generation
    // JOB's created_at, so it carries a clock time and used to land on the tick rail
    // at whatever minute the job happened to run. It must render in the feed list
    // BELOW and produce no tick: the chart is a map of the person's day, not of the
    // app's activity.
    db.prepare("DELETE FROM insights WHERE profile_id = ?").run(idId);
    db.prepare(
      `INSERT INTO insights (profile_id, date, summary, model, created_at)
       VALUES (?, ?, ?, 'e2e-fixture', ?)`
    ).run(
      idId,
      idToday,
      "Synthetic fixture insight for the intraday tick-rail exclusion.",
      idInstant(idToday, "03:07")
    );

    // The data-gate day: one weigh-in, no clock time anywhere.
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, 74.2, 'manual')"
    ).run(idId, idQuiet);

    seedMemberLogin(E2E_LOGIN_INTRADAY, idId, "write");
    console.log(
      `e2e: seeded intraday-panel fixture — ${E2E_LOGIN_INTRADAY} granted ${INTRADAY_PROFILE} (${idId}); intraday day ${idToday}, quiet day ${idQuiet} (#1068)`
    );
  }

  // Mobile shell / quick-log-overlay fixture (#1416, extended by #1468): an
  // otherwise-empty adult profile that quick-log-overlay.mobile.spec.ts logs a body
  // weight and a vitals reading onto THROUGH the overlay, plus ONE untaken
  // scheduled dose for the dose overlay to confirm. The spec asserts what it wrote
  // by VALUE, never a count, and clears the dose's own logs at test start, so
  // repeated runs (--repeat-each) need no further reset.
  {
    const shellId = fixtureProfileId(SHELL_PROFILE);
    seedMemberLogin(E2E_LOGIN_SHELL, shellId, "write");
    if (
      !db
        .prepare("SELECT 1 FROM intake_items WHERE profile_id = ? AND name = ?")
        .get(shellId, SHELL_DOSE_ITEM)
    ) {
      const item = db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, condition, obligation, active, source)
         VALUES (?, ?, 'daily', 'should', 1, 'manual')`
        )
        .run(shellId, SHELL_DOSE_ITEM);
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, ?, '08:00', 'any', 0)`
      ).run(Number(item.lastInsertRowid), SHELL_DOSE_AMOUNT);
    }
    // One tracked practice, no sessions (#1633): the quick-log sheet's practice row
    // lists what the profile TRACKS, so a frequency target alone is the whole
    // precondition — the spec logs the session it then asserts.
    if (
      !db
        .prepare(
          `SELECT 1 FROM frequency_targets
            WHERE profile_id = ? AND scope_kind = 'practice' AND scope_value = ?`
        )
        .get(shellId, SHELL_PRACTICE)
    ) {
      db.prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week)
         VALUES (?, 'practice', ?, ?, ?)`
      ).run(
        shellId,
        SHELL_PRACTICE,
        practiceIdentity(SHELL_PRACTICE),
        SHELL_PRACTICE_PER_WEEK
      );
    }
    console.log(
      `e2e: seeded mobile-shell fixture — ${E2E_LOGIN_SHELL} granted ${SHELL_PROFILE} (${shellId}), one due dose, one tracked practice (#1416/#1468/#1633)`
    );
  }
}

// ── Trends -> Vitals today/1D ──
export function seedVitalsToday(): void {
  // ── Trends → Vitals today/1D fixture (issue #1466) ───────────────────────────
  // The Vitals tab's TODAY layer: a Today strip (latest reading per vital, with its
  // clock time) and a 1D window that swaps the windowed daily charts for intraday
  // ones. A dedicated profile so the day is deterministic without perturbing profile
  // 1 (whose hr_minutes exist ONLY inside the zone-ride window training-zones.spec
  // pins, and whose vitals other specs count).
  //
  // The day carries every shape the surface distinguishes:
  //   • per-minute HR across the morning, then a wear gap — the full-bleed 1D chart;
  //   • two TIMED BP pairs + two timed SpO2 readings, written the way the Health
  //     Connect ingest writes them (the reading instant IS the external_id's tail),
  //     so they can be positioned on the clock axis;
  //   • one manual temperature whose clock time rides `notes` (the #800 convention);
  //   • a day-granular resting HR — a strip entry with a value but no time, and
  //     deliberately NOT an intraday chart.
  //
  // Timezone discipline (#1417): the profile inherits the run's pinned instance
  // timezone, so every absolute instant is built through zonedWallTimeToUtc.
  // hr_minutes.ts is profile-LOCAL by design (#94), so those are wall-clock strings.
  // Idempotent: this profile's fixture rows are cleared first.
  {
    const vdId = fixtureProfileId(VITALS_DAY_PROFILE);
    const vdTz = getTimezone(vdId);
    const vdToday = today(vdId);
    const vdIso = (hhmm: string) =>
      zonedWallTimeToUtc(vdTz, vdToday, hhmm)!.toISOString();

    db.prepare("DELETE FROM hr_minutes WHERE profile_id = ?").run(vdId);
    db.prepare("DELETE FROM medical_records WHERE profile_id = ?").run(vdId);
    db.prepare("DELETE FROM body_metrics WHERE profile_id = ?").run(vdId);
    db.prepare("DELETE FROM metric_samples WHERE profile_id = ?").run(vdId);

    // Per-minute HR, 06:00 → 08:30 local, then nothing (the wear gap the 1D chart
    // must render as a BREAK, not a straight line).
    const insVdHr = db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
     VALUES (?, ?, ?, ?, ?, 6, 'health-connect')`
    );
    for (let m = 6 * 60; m <= 8 * 60 + 30; m++) {
      // Resting, a ramp into a moderate effort, then recovery — a shape a reader
      // recognizes as a heart rate rather than a step function.
      const into = Math.max(0, Math.min(60, m - 7 * 60));
      const out = Math.max(0, Math.min(30, m - 8 * 60));
      const bpm = 62 + into - Math.round(out * 1.4);
      insVdHr.run(
        vdId,
        utcMinute(
          zonedWallTimeToUtc(
            vdTz,
            vdToday,
            `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
              m % 60
            ).padStart(2, "0")}`
          )!
        ),
        bpm,
        bpm - 3,
        bpm + 4
      );
    }

    // Timed vitals, ingest-shaped. Distinct values per reading so the dedup partition
    // (value + unit) keeps both — two points is what makes the intraday chart a chart.
    const insVdVital = db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name,
        source, external_id)
     VALUES (?, ?, 'vitals', ?, ?, ?, ?, ?, 'health-connect', ?)`
    );
    const timedVital = (
      canonical: string,
      unit: string,
      value: number,
      hhmm: string
    ) =>
      insVdVital.run(
        vdId,
        vdToday,
        canonical,
        String(value),
        value,
        unit,
        canonical,
        `health-connect:${canonical}:${vdIso(hhmm)}`
      );
    timedVital("Blood Pressure Systolic", "mmHg", 118, "07:10");
    timedVital("Blood Pressure Diastolic", "mmHg", 76, "07:10");
    timedVital("Blood Pressure Systolic", "mmHg", 126, "09:40");
    timedVital("Blood Pressure Diastolic", "mmHg", 82, "09:40");
    timedVital("Oxygen Saturation", "%", 97, "07:12");
    timedVital("Oxygen Saturation", "%", 96, "09:42");
    timedVital("Respiratory Rate", "/min", 15, "09:45");

    // A manual temperature — the OTHER way a reading carries a clock time.
    db.prepare(
      `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name,
        source, notes)
     VALUES (?, ?, 'vitals', 'Body Temperature', '98.6', 98.6, 'degF',
             'Body Temperature', 'manual', ?)`
    ).run(vdId, vdToday, VITALS_DAY_TEMP_TIME);

    // Day-granular body/composition aggregates: values without times. These make
    // the Body → Today card prove that composition is included while the seeded
    // oxygen readings above are deliberately excluded from that concise card.
    db.prepare(
      `INSERT INTO body_metrics
       (profile_id, date, weight_kg, body_fat_pct, resting_hr, source)
       VALUES (?, ?, ?, ?, ?, 'health-connect')`
    ).run(
      vdId,
      vdToday,
      VITALS_DAY_WEIGHT_KG,
      VITALS_DAY_BODY_FAT,
      Number(VITALS_DAY_RESTING_HR)
    );
    db.prepare(
      `INSERT INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'health-connect', 'steps', ?, ?, ?, ?)`
    ).run(
      vdId,
      vdToday,
      `${vdToday}T00:00:00`,
      `${vdToday}T23:59:59`,
      VITALS_DAY_STEPS
    );

    seedMemberLogin(E2E_LOGIN_VITALS_DAY, vdId, "write");
    console.log(
      `e2e: seeded vitals-day fixture — ${E2E_LOGIN_VITALS_DAY} granted ${VITALS_DAY_PROFILE} (${vdId}); vitals day ${vdToday} (#1466)`
    );
  }

  // App-icon badge fixture (#1424). A bare ADULT profile: no activities, no records,
  // no doses — so its care-tier attention set is exactly the two age-derived
  // preventive findings (COVID-19, Influenza) that every adult profile carries.
  // app-badge.mobile.spec.ts asserts navigator.setAppBadge gets that count, dismisses
  // both through the hero's own menu, and asserts the badge is CLEARED once the hero
  // reads "All clear" — the one path that needs a dashboard to actually reach zero.
  // Write grant: dismissing is a write. The spec clears the dismissals itself at test
  // start, so re-runs and --repeat-each all begin from the same non-empty hero.
  {
    const badgeId = fixtureProfileId(APP_BADGE_PROFILE);
    db.prepare("DELETE FROM upcoming_dismissals WHERE profile_id = ?").run(
      badgeId
    );
    seedMemberLogin(E2E_LOGIN_BADGE, badgeId, "write");
    console.log(
      `e2e: seeded app-badge fixture — ${E2E_LOGIN_BADGE} granted ${APP_BADGE_PROFILE} (${badgeId}) for the PWA badge set/clear spec (#1424)`
    );
  }
}

// ── Bulk corrections fixture ──
export function seedBulkCorrection(): void {
  // ── #1603 bulk corrections ("Fix a run of data" on Data → Review) ────────────
  // A dedicated member login + adult profile, seeded EMPTY on purpose: the spec
  // owns every body_metrics row on it, clearing and re-inserting its lb-as-kg
  // Withings run at test start so every run (and --repeat-each) starts from the
  // same series. Dedicated because the spec's apply/undo rewrites a whole run —
  // a blast radius no shared profile's weight assertions could survive.
  const bulkFixId = fixtureProfileId(BULKFIX_PROFILE);
  seedMemberLogin(E2E_LOGIN_BULKFIX, bulkFixId, "write");
  console.log(
    `e2e: seeded bulk-correction fixture — profile ${bulkFixId} (${BULKFIX_PROFILE}) (#1603)`
  );
}
