// e2e seed fixtures — merge domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db, today } from "../../lib/db";
import { shiftDateStr } from "../../lib/date";
import { seedDupReviewPair } from "../dup-review-fixture";
import { PROFILE_ID, fixtureProfileId, seedMemberLogin } from "./common";
import {
  E2E_LOGIN_OVERLAP,
  OVERLAP_PROFILE,
  OVERLAP_KEEPER_TITLE,
  OVERLAP_TWIN_TITLE,
} from "../fixture-logins";

// ── Duplicate / conflict / set-re-parenting merge fixtures ──
export function seedMergeFixtures(): void {
  // ── Duplicate/conflict fixtures (issue #10, Phase 2) ──────────────────────────
  // A cross-source ACTIVITY pair on one day: a manually-logged "Morning run" and a
  // Strava-imported run with overlapping clock times — a HIGH-confidence duplicate the
  // Review inbox must surface with merge/keep-both/dismiss actions. The seeder lives in
  // e2e/dup-review-fixture.ts so import-dedup.spec.ts (which MERGES the pair) can re-seed
  // it per test and stay repeat-safe (#868). Synthetic data only.
  seedDupReviewPair(db, PROFILE_ID);

  // ── Manual pair-merge fixture (issue #64) ─────────────────────────────────────
  // Two same-day MANUAL cardio activities the Training Log's manual merge test folds
  // together — a deliberate user-directed merge whose clock windows do not overlap,
  // so duplicate detection correctly leaves them alone. Distinct date + titles keep
  // this fixture clear of the cross-source dedup pair above. Synthetic only.
  // RELATIVE date (#1048 frozen-clock follow-up): the training log feed's first page is the
  // newest TRAINING_LOG_PAGE_DAYS (14) days, and the run-start frozen clock advances daily,
  // so the old FIXED "2026-07-05" aged OFF page 1 — the merge specs couldn't see the
  // keeper card and went red suite-wide. Anchor a few days back like the #659 edit-lock
  // fixture so it stays inside the page-1 window; the three pairs stay on DISTINCT days.
  const MERGE_DATE = shiftDateStr(today(PROFILE_ID), -8);
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND date = ? AND title IN ('Training Log merge keeper', 'Training Log merge dupe')`
  ).run(PROFILE_ID, MERGE_DATE);
  const insMerge = db.prepare(
    `INSERT INTO activities
     (profile_id, date, type, title, duration_min, distance_km, start_time,
      end_time, source, external_id, edited)
   VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, NULL, NULL, 0)`
  );
  insMerge.run(
    PROFILE_ID,
    MERGE_DATE,
    "Training Log merge keeper",
    40,
    6,
    "09:00",
    "09:40"
  );
  insMerge.run(
    PROFILE_ID,
    MERGE_DATE,
    "Training Log merge dupe",
    42,
    null,
    "10:00",
    "10:42"
  );

  // ── Conflict-aware merge fixture (issue #100) ─────────────────────────────────
  // Two same-day MANUAL cardio rows that genuinely DISAGREE on duration (42 vs 51
  // min — well beyond the conflict tolerance) but agree on distance. The manual
  // merge must therefore raise the per-field conflict preview; the e2e overrides
  // duration to the discarded row's value and asserts the merged keeper carries it.
  // Distinct date + titles so it never collides with the fixtures above. Synthetic.
  const CONFLICT_DATE = shiftDateStr(today(PROFILE_ID), -9); // relative — see MERGE_DATE (distinct recent day, on page 1)
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND date = ? AND title IN ('Conflict merge keeper', 'Conflict merge dupe')`
  ).run(PROFILE_ID, CONFLICT_DATE);
  insMerge.run(
    PROFILE_ID,
    CONFLICT_DATE,
    "Conflict merge keeper",
    42,
    5,
    null,
    null
  );
  insMerge.run(
    PROFILE_ID,
    CONFLICT_DATE,
    "Conflict merge dupe",
    51,
    5,
    null,
    null
  );

  // ── Overlapping same-day pair (#2870, the discovery banner) ──────────────────
  // Two sessions whose CLOCK WINDOWS overlap — the evidence the duplicate detector
  // treats as its strongest, because a person cannot do two sessions at once. The
  // three fixtures above deliberately carry no clock at all (that is their point:
  // a duplicate no heuristic catches), so none of them can exercise a banner that
  // exists precisely to say "these two windows are the same session". Cross-source
  // on purpose: the banner names WHO ELSE logged it, which is the fact that makes
  // a reader recognise the double-log.
  //
  // On its OWN profile (#868, and a lesson paid for): the Timeline's windowing
  // spec pins a 100-day-old fixture, `getTimeline` returns the newest 250 events
  // across all sources, and profile 1's seeded history sits close enough to that
  // cut that two more activities pushed the old day off the page and turned a
  // training change into a timeline failure.
  {
    const overlapId = fixtureProfileId(OVERLAP_PROFILE);
    seedMemberLogin(E2E_LOGIN_OVERLAP, overlapId);
    const overlapDate = shiftDateStr(today(overlapId), -11);
    db.prepare(
      `DELETE FROM activities WHERE profile_id = ? AND title IN (?, ?)`
    ).run(overlapId, OVERLAP_KEEPER_TITLE, OVERLAP_TWIN_TITLE);
    const insOverlap = db.prepare(
      `INSERT INTO activities
         (profile_id, date, type, title, duration_min, distance_km, start_time,
          end_time, source, external_id, edited)
       VALUES (?, ?, 'cardio', ?, ?, 8, ?, ?, ?, ?, 0)`
    );
    insOverlap.run(
      overlapId,
      overlapDate,
      OVERLAP_KEEPER_TITLE,
      45,
      "06:00",
      "06:45",
      null,
      null
    );
    insOverlap.run(
      overlapId,
      overlapDate,
      OVERLAP_TWIN_TITLE,
      44,
      "06:10",
      "06:54",
      "strava",
      "e2e:overlap-twin"
    );
  }

  // ── Set-re-parenting merge fixture (issues #199/#200) ─────────────────────────
  // Two same-day MANUAL STRENGTH activities that conflict on duration (30 vs 45 min),
  // so the manual merge raises the per-field conflict preview — the surface that now
  // shows how many logged sets will move (#199). The DROP carries two typed-in sets
  // that a merge must RE-PARENT onto the keeper (never destroy). Distinct date + titles
  // so it never collides with the fixtures above. Synthetic only.
  const SETS_DATE = shiftDateStr(today(PROFILE_ID), -3); // relative — see MERGE_DATE (distinct recent day, on page 1)
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND date = ? AND title IN ('Set merge keeper', 'Set merge dupe')`
  ).run(PROFILE_ID, SETS_DATE);
  const insStrength = db.prepare(
    `INSERT INTO activities
     (profile_id, date, type, title, duration_min, source, external_id, edited)
   VALUES (?, ?, 'strength', ?, ?, NULL, NULL, 0)`
  );
  const setsKeeperId = Number(
    insStrength.run(PROFILE_ID, SETS_DATE, "Set merge keeper", 30)
      .lastInsertRowid
  );
  const setsDupeId = Number(
    insStrength.run(PROFILE_ID, SETS_DATE, "Set merge dupe", 45).lastInsertRowid
  );
  const insSeedSet = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
   VALUES (?, ?, ?, ?, ?)`
  );
  // The keeper has one set of its own; the dupe carries the two the merge must move.
  insSeedSet.run(setsKeeperId, "Bench Press", 1, 60, 5);
  insSeedSet.run(setsDupeId, "Back Squat", 1, 80, 5);
  insSeedSet.run(setsDupeId, "Deadlift", 1, 100, 5);

  console.log(
    "e2e: seeded integration_sync_events (strava failing) + a cross-source duplicate activity pair + a same-day manual-merge pair + a conflicting merge pair"
  );
}
