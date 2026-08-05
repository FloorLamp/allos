// e2e seed fixtures — coaching domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { shiftDateStr, zonedWallTimeToUtc } from "../../lib/date";
import { getTimezone, setProfileSetting } from "../../lib/settings";
import {
  E2E_LOGIN_REST,
  REST_CARD_PROFILE,
  E2E_LOGIN_WELLSYM,
  WELL_SYMPTOM_PROFILE,
} from "../fixture-logins";
import { PROFILE_ID, seedMemberLogin, fixtureProfileId } from "./common";

// ── Coaching rest-episode continuity ──
export function seedRestEpisode(): void {
  // ── Coaching rest-episode continuity fixtures (#44 item 3b) ───────────────────
  // Force a rest nudge for profile 1 today (a short night, below the 6h floor) and
  // pre-seed a rest episode that started YESTERDAY, so the Training → Overview
  // "Next workout" card reads "Rest or take it easy — 2nd day" (a persisting
  // recommendation, #752) rather than a fresh "Rest or take it easy today" alert.
  // Dates follow the app timezone
  // via today()/shiftDateStr so this is deterministic regardless of the host TZ.
  // Synthetic values only — no real PHI.
  const COACH_TODAY = today(PROFILE_ID);
  const COACH_YESTERDAY = shiftDateStr(COACH_TODAY, -1);

  // A single low sleep_min sample for last night → getSleepSignal trips the
  // absolute floor and restRecommendation fires a rest nudge. Clear any prior
  // fixture row first so re-seeding stays idempotent.
  db.prepare(
    `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
  ).run(PROFILE_ID, COACH_TODAY);
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 300)`
  ).run(
    PROFILE_ID,
    COACH_TODAY,
    `${COACH_YESTERDAY}T23:00`,
    `${COACH_TODAY}T04:00`
  );

  // The persisted episode marker (mirrors the refill nudge's dedup marker). Started
  // yesterday and last seen yesterday → today's rest rec continues it into day 2.
  setProfileSetting(
    PROFILE_ID,
    "coaching_rest_episode",
    JSON.stringify({
      startDate: COACH_YESTERDAY,
      lastDate: COACH_YESTERDAY,
      reasonId: "rest-sleep",
    })
  );

  console.log(
    `e2e: seeded a low-sleep sample + a day-2 rest episode for profile 1 (${COACH_YESTERDAY} → ${COACH_TODAY})`
  );
}

// ── Coaching rest card: multi-signal + "Training anyway" ──
export function seedRestCard(): void {
  // ── Coaching rest card: multi-signal + "Training anyway" (#1148 / #1150) ──────────
  // A dedicated adult profile tripping TWO concurrent under-recovery signals so the
  // dashboard coaching card leads with the salience-ordered primary (rest-sleep) AND
  // shows the "Also: …" secondary line (rest-rhr, #1148), and the "Training anyway"
  // acknowledgment (#1150) has a real rest rec to transform. Isolated from profile 1 so
  // this spec's ack/snooze writes never race the neighbor coaching specs. Idempotent —
  // clears its own fixture rows first. Synthetic values only; relative dates never stale.
  {
    const rcId = fixtureProfileId(REST_CARD_PROFILE);
    const rcToday = today(rcId);
    const rcPrevNight = shiftDateStr(rcToday, -1);
    db.prepare(`DELETE FROM body_metrics WHERE profile_id = ?`).run(rcId);
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min'`
    ).run(rcId);
    db.prepare(
      `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:rest-card-context'`
    ).run(rcId);

    // Signal 1 — a short overnight (300 min < the 6h floor) → rest-sleep fires.
    // CRITICAL (#2159, the #1110 wake-day rule): getSleepSignal reads the MAIN
    // overnight per wake-day, and a wakeDay is the PROFILE-LOCAL calendar date the
    // session ENDED (mainSleepNights → zonedDateParts). So the window MUST be built
    // through the profile timezone (zonedWallTimeToUtc) — the pinned e2e zone,
    // seeded by seedPrelude before this runs — NOT bare `…Z` stamps. Bare
    // `${rcToday}T04:00:00Z` reads as 23:00 the PREVIOUS local evening once the
    // pinned zone crosses to UTC−5 (any run starting ≥ 18:00 UTC), landing the
    // night on wakeDay rcPrevNight; isLastNight then refuses it, rest-sleep drops,
    // rest-rhr becomes the lone primary, and the "Also:" line vanishes.
    const rcTz = getTimezone(rcId);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 300)`
    ).run(
      rcId,
      rcToday,
      zonedWallTimeToUtc(rcTz, rcPrevNight, "23:00").toISOString(),
      zonedWallTimeToUtc(rcTz, rcToday, "04:00").toISOString()
    );

    // Signal 2 — resting HR elevated today (62) over a ~54 baseline (prior days) →
    // rest-rhr fires with a fixed threshold (a flat baseline has zero spread).
    const insRcHr = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, resting_hr, notes)
     VALUES (?, ?, ?, 'e2e:rest-card')`
    );
    insRcHr.run(rcId, rcToday, 62);
    for (let d = 1; d <= 5; d++)
      insRcHr.run(rcId, shiftDateStr(rcToday, -d), 54);

    // Training context (one old strength day, well outside any streak/load window) so
    // the engine evaluates recovery at all — rest presupposes a training context.
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
     VALUES (?, ?, 'strength', 'Rest Card context lift', 40, 'hard', 'manual', 'e2e:rest-card-context')`
    ).run(rcId, shiftDateStr(rcToday, -10));

    seedMemberLogin(E2E_LOGIN_REST, rcId, "write");
    console.log(
      `e2e: seeded coaching rest-card fixture — profile ${rcId} (${REST_CARD_PROFILE}) (#1148/#1150)`
    );
  }
}

// ── Well-day symptom + reported-burden coaching tilt ──
export function seedWellDayTilt(): void {
  // ── Well-day symptom + reported-burden coaching tilt fixture (#1300) ───────────
  // A dedicated adult WELL profile (no illness, no rest signals) with a small strength history
  // so coaching has content — the spec logs a severe symptom from the check-in Report entry
  // and asserts the coaching card tilts toward an easier session naming the symptom, with the
  // suggest-only illness bridge present but not required. Isolated so the symptom write never
  // perturbs a neighbor coaching fixture. Idempotent; synthetic only.
  {
    const wsId = fixtureProfileId(WELL_SYMPTOM_PROFILE);
    const wsToday = today(wsId);
    db.prepare(
      `DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:well-symptom'`
    ).run(wsId);
    db.prepare(`DELETE FROM symptom_logs WHERE profile_id = ?`).run(wsId);
    db.prepare(`DELETE FROM mood_logs WHERE profile_id = ?`).run(wsId);

    // One old strength day, well outside any streak/load window, so the engine evaluates
    // recovery at all (rest presupposes a training context) but no schedule-based rest fires.
    const wsAid = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
         VALUES (?, ?, 'strength', 'Well Symptom context lift', 40, 'hard', 'manual', 'e2e:well-symptom')`
        )
        .run(wsId, shiftDateStr(wsToday, -10)).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Back Squat', 1, 100, 5)`
    ).run(wsAid);

    seedMemberLogin(E2E_LOGIN_WELLSYM, wsId, "write");
    console.log(
      `e2e: seeded well-symptom fixture — profile ${wsId} (${WELL_SYMPTOM_PROFILE}) (#1300)`
    );
  }
}
