import type Database from "better-sqlite3";

// Shared re-seeder for the #1081 N-way merge specs (Review cluster card + Training Log
// multi-select merge). Both surfaces CONSUME their rows (a merge deletes rows +, on
// Review, writes durable decisions), so the spec re-seeds in beforeEach to stay
// repeat-safe (#868). Synthetic data only.
//
// Three independent same-day groups on the fixture profile, keyed so a reset scopes
// to exactly these titles:
//   - REVIEW: three CROSS-SOURCE overlapping rows (manual + Strava + Health Connect)
//     → detection clusters them into ONE 3-member card. Values agree, so its merge
//     is one click (no conflict picker).
//   - CONFLICT: three CROSS-SOURCE overlapping rows whose DISTANCES materially
//     disagree (5 / 8 / 12 km) → one cluster card whose merge opens the per-field
//     picker (#1431). Durations agree, so distance is the only surfaced conflict;
//     only the Strava row carries an avg_hr, making it the deterministic default
//     keeper (sourced + richest).
//   - TRAINING LOG: three same-day MANUAL rows (values within tolerance, so no conflict
//     dialogs) → three cards, each offering the other two as merge siblings for the
//     multi-select keeper-radio flow.

export const NW_REVIEW_TITLES = [
  "NW review manual",
  "NW review strava",
  "NW review hc",
];
export const NW_CONFLICT_TITLES = [
  "NW conf manual",
  "NW conf strava",
  "NW conf hc",
];
export const NW_TRAINING_LOG_TITLES = ["NW card", "NW sib A", "NW sib B"];

// Reset the fixture groups on `profileId` to their UNMERGED state at the given dates
// (the spec passes dates recent relative to the frozen clock so the Training Log cards land
// on page 1). Idempotent — deletes are scoped to this fixture's titles.
export function seedNwayMergeFixture(
  db: Database.Database,
  profileId: number,
  reviewDate: string,
  trainingLogDate: string,
  conflictDate: string
): void {
  const allTitles = [
    ...NW_REVIEW_TITLES,
    ...NW_CONFLICT_TITLES,
    ...NW_TRAINING_LOG_TITLES,
  ];
  const placeholders = allTitles.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND title IN (${placeholders})`
  ).run(profileId, ...allTitles);
  db.prepare(`DELETE FROM import_pair_decisions WHERE profile_id = ?`).run(
    profileId
  );

  const ins = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km,
        start_time, end_time, avg_hr, source, external_id, edited)
     VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  );

  // REVIEW cluster: three overlapping cross-source rows, same distance/duration.
  ins.run(
    profileId,
    reviewDate,
    "NW review manual",
    30,
    5,
    "08:00",
    "08:30",
    null,
    null,
    null
  );
  ins.run(
    profileId,
    reviewDate,
    "NW review strava",
    30,
    5,
    "08:01",
    "08:31",
    150,
    "strava",
    "strava:nw-1"
  );
  ins.run(
    profileId,
    reviewDate,
    "NW review hc",
    30,
    5,
    "08:02",
    "08:32",
    148,
    "health-connect",
    "hc:nw-1"
  );

  // CONFLICT cluster (#1431): three overlapping cross-source rows that materially
  // disagree on distance (5 / 8 / 12 km) while agreeing on duration. Only Strava
  // carries an avg_hr → the deterministic default keeper.
  ins.run(
    profileId,
    conflictDate,
    "NW conf manual",
    30,
    5,
    "07:00",
    "07:30",
    null,
    null,
    null
  );
  ins.run(
    profileId,
    conflictDate,
    "NW conf strava",
    30,
    8,
    "07:01",
    "07:31",
    152,
    "strava",
    "strava:nwc-1"
  );
  ins.run(
    profileId,
    conflictDate,
    "NW conf hc",
    30,
    12,
    "07:02",
    "07:32",
    null,
    "health-connect",
    "hc:nwc-1"
  );

  // TRAINING LOG group: three same-day manual rows (values within tolerance, so no
  // conflict dialogs).
  ins.run(
    profileId,
    trainingLogDate,
    "NW card",
    40,
    6,
    "17:00",
    "17:40",
    null,
    null,
    null
  );
  ins.run(
    profileId,
    trainingLogDate,
    "NW sib A",
    41,
    6,
    "17:01",
    "17:41",
    null,
    null,
    null
  );
  ins.run(
    profileId,
    trainingLogDate,
    "NW sib B",
    42,
    6,
    "17:02",
    "17:42",
    null,
    null,
    null
  );
}
