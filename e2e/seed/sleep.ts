// e2e seed fixtures — sleep domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { shiftDateStr, zonedWallTimeToUtc } from "../../lib/date";
import { getTimezone } from "../../lib/settings";
import { PROFILE_ID, fixtureProfileId, seedMemberLogin } from "./common";
import {
  E2E_LOGIN_SLEEP_WAITING,
  SLEEP_WAITING_PROFILE,
  E2E_LOGIN_SLEEP_INPROGRESS,
  SLEEP_INPROGRESS_PROFILE,
} from "../fixture-logins";

// ── Sleep regularity, Sleep page, Oura vendor daily scores ──
export function seedSleep(): void {
  // The coaching block (./coaching's seedRestEpisode) anchors these same two dates;
  // both resolve from the profile's today(), so recomputing here is identical.
  const COACH_TODAY = today(PROFILE_ID);
  const COACH_YESTERDAY = shiftDateStr(COACH_TODAY, -1);
  // ── Sleep Regularity Index fixture (issue #160) ───────────────────────────────
  // 28 nightly sleep sessions (wake-days today-1 … today-28), each bed 23:00 → wake
  // 07:00 in UTC (the e2e default profile timezone), so the rolling 28-night window
  // clears the minimum-nights gate and the Trends → Body "Sleep regularity" card
  // (SRI) renders. Weekend nights (Sat/Sun wake) shift 90 min later so the companion
  // social-jetlag line is non-trivial. Relative dates → never stale; instants carry
  // a Z so they're timezone-unambiguous. Idempotent: clear this range first (the
  // coaching low-sleep row on wake-day `today` is outside it and untouched).
  const sriInsert = db.prepare(
    `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
  );
  for (let i = 1; i <= 28; i++) {
    const wakeDay = shiftDateStr(COACH_TODAY, -i);
    const bedDay = shiftDateStr(wakeDay, -1);
    db.prepare(
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?`
    ).run(PROFILE_ID, wakeDay);
    const dow = new Date(wakeDay + "T00:00:00Z").getUTCDay(); // 0=Sun … 6=Sat
    const weekend = dow === 0 || dow === 6;
    // Weekday 23:00→07:00 (480 min); weekend 00:30→08:30 (still 480 min, later).
    const start = weekend ? `${wakeDay}T00:30:00Z` : `${bedDay}T23:00:00Z`;
    const end = weekend ? `${wakeDay}T08:30:00Z` : `${wakeDay}T07:00:00Z`;
    sriInsert.run(PROFILE_ID, wakeDay, start, end, 480);
  }
  console.log(
    "e2e: seeded 28 nightly sleep sessions for profile 1 (SRI, #160)"
  );

  // ── Sleep page fixture (issue #1066) ──[SLEEP-PAGE-1066]───────────────────────
  // Self-contained block layered on the #160 SRI nights above — keep it standalone
  // and clearly marked so a parallel #1117 edit to this file merges trivially.
  // Adds, for profile 1:
  //   (a) per-night sleep STAGE samples for the last 14 wake-days (today-13 … today),
  //       so the Sleep page "Stage composition" chart and the hero stage bar render;
  //   (b) a deterministic LAST NIGHT on wake-day `today` — a 5h main overnight
  //       (23:00 → 04:00 LOCAL) plus an afternoon NAP (13:00 → 13:45 LOCAL) — so the
  //       hero shows the 5h main session and the nap as a SEPARATE line, never summed
  //       (the #1118 main-vs-nap split; asserted by sleep-page.spec).
  //
  // CRITICAL (#1110 pinned instance timezone): `lastNightSummary` groups sessions by
  // the profile-LOCAL calendar date of each session END, so the fixture MUST build
  // instants through the profile timezone (zonedWallTimeToUtc), NOT bare UTC. A bare
  // `…Z` string under the run's Etc/GMT±N zone lands on the wrong wake-day (e.g. a
  // 13:00Z nap becomes tomorrow-02:00 local), which strands the nap alone on the
  // latest wake-day and makes the hero render the NAP instead of the night. The
  // overnight is seeded here (not relied on from the naive-timestamp coaching block
  // above) precisely so its wake-day placement is tz-correct and deterministic.
  // Synthetic values only (no PHI). Idempotent: clears its own windows first.
  const sleepTz = getTimezone(PROFILE_ID);
  const iso = (d: Date) => d.toISOString();
  const sleepStageInsert = db.prepare(
    `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i <= 13; i++) {
    const wakeDay = shiftDateStr(COACH_TODAY, -i);
    const bedDay = shiftDateStr(wakeDay, -1);
    // Stage rows are grouped by the stored `date` column (getSleepStageDailyTotals),
    // not by the window, so tz placement doesn't affect them; still build the window
    // through the profile tz for consistency.
    const start = iso(zonedWallTimeToUtc(sleepTz, bedDay, "23:00")!);
    const end = iso(zonedWallTimeToUtc(sleepTz, wakeDay, "07:00")!);
    // deterministic light jitter so the stacked areas aren't perfectly flat
    const jitter = (i * 5) % 20;
    const stages: [string, number][] = [
      ["sleep_deep_min", 80 + jitter],
      ["sleep_rem_min", 100 - jitter],
      ["sleep_light_min", 250 + jitter],
      ["sleep_awake_min", 25 + (jitter % 10)],
    ];
    for (const [metric, value] of stages) {
      db.prepare(
        `DELETE FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = 'manual' AND date = ?`
      ).run(PROFILE_ID, metric, wakeDay);
      sleepStageInsert.run(PROFILE_ID, metric, wakeDay, start, end, value);
    }
  }
  // Last night on `today`: a 5h main overnight (23:00 prev → 04:00 today, LOCAL) and
  // a 45-min afternoon nap (13:00 → 13:45 today, LOCAL). Both land on wake-day
  // `today` in the profile tz; mainSleepSession keeps the 5h overnight and the nap is
  // a separate figure. Idempotent by the exact tz-correct windows.
  const overnightStart = iso(
    zonedWallTimeToUtc(sleepTz, COACH_YESTERDAY, "23:00")!
  );
  const overnightEnd = iso(zonedWallTimeToUtc(sleepTz, COACH_TODAY, "04:00")!);
  const napStart = iso(zonedWallTimeToUtc(sleepTz, COACH_TODAY, "13:00")!);
  const napEnd = iso(zonedWallTimeToUtc(sleepTz, COACH_TODAY, "13:45")!);
  const sleepSessionInsert = db.prepare(
    `INSERT OR IGNORE INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
  );
  // Own wake-day `today` entirely: clear ALL of today's manual sleep_min sessions —
  // crucially the NAIVE-timestamp overnight the coaching block above seeded for
  // COACH_TODAY (23:00→04:00 as bare, non-tz strings → fixed 23:00Z→04:00Z). Its
  // old per-start_time DELETE only matched THIS block's own tz-correct start, so the
  // coaching duplicate survived: two 300-min overnights on today, and mainSleepSession's
  // duration-tie → earliest-END tiebreak flipped to the coaching row whenever the
  // pinned tz is west of UTC (ALLOS_TEST_NOW hour ≥ 14:00 UTC — utcHour drives the
  // Etc/GMT offset), rendering "22:00 → 03:00" and lumping the real overnight into a
  // 345-min "nap" (sleep-page:194 time-window flake). The coaching REST signal is
  // preserved: the tz-correct overnight is also 300 min (5h), so getSleepSignal still
  // trips the absolute floor.
  db.prepare(
    `DELETE FROM metric_samples
    WHERE profile_id = ? AND metric = 'sleep_min' AND source = 'manual'
      AND date = ?`
  ).run(PROFILE_ID, COACH_TODAY);
  for (const [start, end, value] of [
    [overnightStart, overnightEnd, 300],
    [napStart, napEnd, 45],
  ] as [string, string, number][]) {
    sleepSessionInsert.run(PROFILE_ID, COACH_TODAY, start, end, value);
  }
  console.log(
    "e2e: seeded sleep stages (14 nights) + a tz-correct 5h night & nap for profile 1 (#1066)"
  );

  // Bedtime-supplement context for the same two most-recent overnight sessions.
  // Reuse the base seed's real Before-sleep supplement instead of minting a second
  // schedule. Last night's start-day is taken; the preceding night's is deliberately
  // unlogged so the hero/log exercise both factual states. Move the synthetic dose's
  // lifetime before the fixture window so the shared #430 lifetime guard correctly
  // considers both nights applicable.
  const bedtimeDose = db
    .prepare(
      `SELECT d.id AS dose_id, d.item_id AS item_id
       FROM intake_item_doses d
       JOIN intake_items i ON i.id = d.item_id
      WHERE i.profile_id = ? AND i.name = 'Magnesium Glycinate'
        AND d.retired = 0
      ORDER BY d.id LIMIT 1`
    )
    .get(PROFILE_ID) as { dose_id: number; item_id: number } | undefined;
  if (bedtimeDose) {
    const bedtimeFixtureStart = `${shiftDateStr(COACH_TODAY, -30)} 00:00:00`;
    db.prepare(
      `UPDATE intake_items SET created_at = ? WHERE id = ? AND profile_id = ?`
    ).run(bedtimeFixtureStart, bedtimeDose.item_id, PROFILE_ID);
    db.prepare(
      `UPDATE intake_item_doses SET created_at = ?, updated_at = NULL
      WHERE id = ? AND item_id = ?
        AND EXISTS (
          SELECT 1 FROM intake_items i
           WHERE i.id = intake_item_doses.item_id AND i.profile_id = ?
        )`
    ).run(
      bedtimeFixtureStart,
      bedtimeDose.dose_id,
      bedtimeDose.item_id,
      PROFILE_ID
    );
    const priorSleepDate = shiftDateStr(COACH_YESTERDAY, -1);
    db.prepare(
      `DELETE FROM intake_item_logs
      WHERE dose_id = ? AND item_id = ? AND date IN (?, ?)
        AND EXISTS (
          SELECT 1 FROM intake_items i
           WHERE i.id = intake_item_logs.item_id AND i.profile_id = ?
        )`
    ).run(
      bedtimeDose.dose_id,
      bedtimeDose.item_id,
      COACH_YESTERDAY,
      priorSleepDate,
      PROFILE_ID
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
     VALUES (?, ?, ?, 'taken')`
    ).run(bedtimeDose.dose_id, bedtimeDose.item_id, COACH_YESTERDAY);
  }
  console.log(
    "e2e: seeded taken + unlogged bedtime-supplement nights for profile 1"
  );

  // ── Oura vendor daily scores fixture (issue #1069) ──[OURA-SCORES-1069]────────
  // Profile 1's Oura sleep/readiness scores for the last 14 days, so the Sleep
  // page's attributed "From Oura" tiles + trends render (sleep-page.spec). These are
  // DISPLAY-ONLY, engine-inert vendor numbers under the vendor-prefixed kinds — the
  // parser keys each day at UTC midnight, so match that natural key here. Source
  // 'oura'. Synthetic values only (no PHI). Idempotent: clears its own kind/day rows.
  const ouraScoreInsert = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
   VALUES (?, 'oura', ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i <= 13; i++) {
    const day = shiftDateStr(COACH_TODAY, -i);
    const instant = `${day}T00:00:00.000Z`;
    // Deterministic synthetic 0–100 figures with light jitter; today's = latest.
    const sleepScore = 78 + ((i * 3) % 12);
    const readinessScore = 70 + ((i * 5) % 15);
    for (const [metric, value] of [
      ["oura_sleep_score", sleepScore],
      ["oura_readiness_score", readinessScore],
    ] as [string, number][]) {
      db.prepare(
        `DELETE FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = 'oura' AND date = ?`
      ).run(PROFILE_ID, metric, day);
      ouraScoreInsert.run(PROFILE_ID, metric, day, instant, instant, value);
    }
  }
  console.log(
    "e2e: seeded Oura sleep/readiness daily scores (14 days) for profile 1 (#1069)"
  );
}

// ── The morning waiting window (#2097) ───────────────────────────────────────
//
// Two read-only fixtures, one per side of the wake anchor. Each carries 14 SYNCED
// nights on wake-days today−1 … today−14 and NOTHING on today's wake-day: last night
// is not in hand, the three nights before it are, and no provider is failing — which
// is exactly the state the waiting copy is for.
//
// The branch is fixed by the wake anchor, not by the run's start hour. The suite pins
// local time to 13:mm (e2e/pinned-timezone.ts), so a 12:00 median wake puts the render
// an hour past the anchor (inside the arrival window → "waiting"), and a 15:00 median
// wake puts it before the anchor entirely (→ "in progress"). Wake times are written as
// WALL CLOCK in each profile's own zone, so the median is the stated hour whatever the
// pinned offset is.
//
// Deliberately NO integration_sync_rows: with no measured arrival lag the ETA is
// withheld and the copy degrades to the plain wording — the common state on a young
// profile, and the one worth pinning in a browser test.
function seedWaitingNights(profileId: number, wakeHhmm: string): void {
  db.prepare(`DELETE FROM metric_samples WHERE profile_id = ?`).run(profileId);
  const anchor = today(profileId);
  const tz = getTimezone(profileId);
  const insert = db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', 'sleep_min', ?, ?, ?, 450)`
  );
  for (let back = 1; back <= 14; back++) {
    const wakeDay = shiftDateStr(anchor, -back);
    const bedDay = shiftDateStr(wakeDay, -1);
    insert.run(
      profileId,
      wakeDay,
      zonedWallTimeToUtc(tz, bedDay, "23:30")!.toISOString(),
      zonedWallTimeToUtc(tz, wakeDay, wakeHhmm)!.toISOString()
    );
  }
}

export function seedSleepWaiting(): void {
  const waitingId = fixtureProfileId(SLEEP_WAITING_PROFILE);
  seedWaitingNights(waitingId, "12:00");
  seedMemberLogin(E2E_LOGIN_SLEEP_WAITING, waitingId, "read");

  const inProgressId = fixtureProfileId(SLEEP_INPROGRESS_PROFILE);
  seedWaitingNights(inProgressId, "15:00");
  seedMemberLogin(E2E_LOGIN_SLEEP_INPROGRESS, inProgressId, "read");

  console.log(
    `e2e: seeded morning-waiting fixtures — profile ${waitingId} (${SLEEP_WAITING_PROFILE}, inside the arrival window) and profile ${inProgressId} (${SLEEP_INPROGRESS_PROFILE}, before the wake anchor) (#2097)`
  );
}
