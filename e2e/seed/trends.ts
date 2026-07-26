// e2e seed fixtures — trends domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { shiftDateStr } from "../../lib/date";
import { createFixtureProfile } from "../fixture-profile";
import { setTrendViews } from "../../lib/settings";
import {
  E2E_LOGIN_TRENDS_CURATE,
  TRENDS_CURATE_PROFILE,
  TRENDS_CURATE_EMPTY_ANALYTE,
  E2E_LOGIN_TRENDS_BODY,
  TRENDS_BODY_PROFILE,
  E2E_LOGIN_TRENDS_COMPARE,
  TRENDS_COMPARE_PROFILE,
  TRENDS_COMPARE_VIEW,
} from "../fixture-logins";
import { ins, seedMemberLogin, fixtureProfileId } from "./common";

// ── Trends -> Body mobile overhaul ──
export function seedBodyMobile(): void {
  // ── Trends → Body mobile overhaul fixture (#1067 Phase 1) ─────────────────────
  // A dedicated adult profile with a KNOWN, PARTIAL set of synced body metrics so
  // the chart-jump chips + per-chart anchors are deterministic in the browser:
  //   present → Weight/resting-HR (body-composition block), Steps, Sleep, HR (daily)
  //   ABSENT  → hydration / BMR / calories / lean-mass / bone-mass / BMI / macros
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
      `DELETE FROM metric_samples WHERE profile_id = ? AND metric IN ('steps', 'sleep_min')`
    ).run(tbId);
    db.prepare(`DELETE FROM hr_minutes WHERE profile_id = ?`).run(tbId);

    // Body-composition block: two weigh-ins with resting HR.
    const insBm = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, notes)
     VALUES (?, ?, ?, ?, 'e2e:trends-body')`
    );
    insBm.run(tbId, shiftDateStr(tbToday, -7), 78.4, 58);
    insBm.run(tbId, shiftDateStr(tbToday, -1), 77.9, 56);

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

    // One sleep night ending today → the compact Sleep summary tile renders.
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
  // A TRAINING-RESTRICTED profile that can actually run a comparison. Two things
  // make it the fixture this needs and the seeded "Riley (child)" is not:
  //   • an age UNDER the instance gate (13, set by e2e/seed/coverage-gaps.ts) with
  //     TWO overlappable series — weight + resting HR on the same dates — so the
  //     compare overlay draws its dual-axis chart for a minor;
  //   • a stored saved view carrying the RETIRED `tab: "compare"`, i.e. a
  //     trend_views row exactly as one saved before #1489 looks. It lives here
  //     rather than on a shared profile because a saved view is a visible chip in
  //     the Views bar every other Trends spec renders.
  // Dates are RELATIVE (inside the 90-day default window) so the fixture never goes
  // stale; the spec only reads and applies the view, so it stays repeat-safe.
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

  // The legacy saved view: no from/to (an all-time view, which viewToQuery re-emits
  // as ?range=all) so the readings above are always inside its window.
  setTrendViews(cmpId, [
    {
      name: TRENDS_COMPARE_VIEW,
      params: {
        tab: "compare",
        cmpA: "metric:weight",
        cmpB: "metric:resting_hr",
      },
    },
  ]);

  // Write grant: applying a saved view goes through applyTrendView, a
  // requireWriteAccess Server Action (it redirects and stores nothing).
  seedMemberLogin(E2E_LOGIN_TRENDS_COMPARE, cmpId, "write");
  console.log(
    `e2e: seeded compare-fold fixture — profile ${cmpId} (${TRENDS_COMPARE_PROFILE}) (#1489)`
  );
}
