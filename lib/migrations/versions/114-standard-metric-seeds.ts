import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 114 (issue #1487, data half): the standard Overview metric tiles become
// DEFAULT-SAVED rows.
//
// #1456 built `saved_items` with two kinds and two meanings. For `biomarker` a save
// is MEMBERSHIP (saved = it earns a chart tile, a Results status-card tile, a line in
// the passport summary). For `trend-metric` it was only PROMOTION: the four standard
// tiles — weight, body fat, resting heart rate, training volume — rendered
// unconditionally, and a save merely ordered one first. That hardcoded sampler is
// what made Trends Overview duplicate the domain tabs, so #1487 makes Overview show
// exactly what you saved and what changed, and the standard tiles graduate to
// membership: real saved rows, unstarrable like anything else.
//
// This migration is the DATA half of that change and is deliberately invisible: it
// seeds the rows for every profile that already exists, so that when the rendering
// flips to membership-driven the day-one tile set and order are the ones the profile
// already sees. New profiles are seeded at creation instead (bootstrapAuth and
// createProfile, via lib/standard-metric-seeds.ts) — this runs once, for the
// installed base.
//
// IT TOUCHES NO EXISTING ROW. The seeds are inserted UNPOSITIONED, carrying a
// sentinel `created_at` at the epoch, stamped descending so tile order survives.
// The saved order is "positioned rows first, then unpositioned newest-first", so an
// epoch-stamped unpositioned row sorts behind every real save — the ones already
// there and the ones the user makes later. Positioning the seeds instead would jump
// them ahead of every plain ★ save; stamping them with a current `created_at` would
// make them the newest saves and do the same. Full reasoning: the header of
// lib/standard-metric-seeds.ts. A metric the profile had ALREADY saved is deduped by
// the store's UNIQUE(profile_id, kind, key) and keeps its own row untouched.
//
// AGE GATES ARE NOT CONSULTED HERE. The seed set is identical for every profile;
// buildMetricSeries drops training volume for an age-restricted profile (and body fat
// below the growth-metrics age) when it builds the tiles, and a saved ref with no
// tile is skipped. Freezing the gate's answer into the seed would strand a profile
// that later ages out of it — and with the picker offering biomarkers only, there
// would be no gesture left to get the tile back.
//
// Self-contained (manifest freeze — never imports lib/): the metric id list and the
// sentinel stamps are inlined rather than imported from lib/standard-metric-seeds.ts,
// so a later refactor of that module can't change what this shipped migration does.
// lib/__db_tests__/standard-metric-seeds.test.ts pins the frozen copy against the
// live module so the two can't drift silently.
//
// Replay-safe (the non-version-gated migrate() wrapper the DB test tier replays):
// INSERT OR IGNORE only, so a second run over an at-rest database changes nothing.

// FROZEN COPY of STANDARD_TREND_METRIC_IDS — the standard Overview metric tiles in
// TILE ORDER (the order METRIC_DEFS builds them, which is the order they render),
// each with its epoch sentinel stamp. Descending seconds, so "newest seed first"
// reproduces tile order.
const STANDARD_METRIC_SEEDS: [key: string, createdAt: string][] = [
  ["weight", "1970-01-01 00:00:04"],
  ["bodyfat", "1970-01-01 00:00:03"],
  ["resting_hr", "1970-01-01 00:00:02"],
  ["volume", "1970-01-01 00:00:01"],
];

export function up(db: Database.Database): void {
  const profiles = db.prepare(`SELECT id FROM profiles`).all() as {
    id: number;
  }[];

  const insertSeed = db.prepare(
    `INSERT OR IGNORE INTO saved_items (profile_id, kind, key, position, created_at)
       VALUES (?, 'trend-metric', ?, NULL, ?)`
  );

  const seed = db.transaction(() => {
    for (const profile of profiles) {
      for (const [key, createdAt] of STANDARD_METRIC_SEEDS) {
        insertSeed.run(profile.id, key, createdAt);
      }
    }
  });
  seed();
}

export const migration: Migration = {
  id: 114,
  name: "114-standard-metric-seeds",
  up,
};
