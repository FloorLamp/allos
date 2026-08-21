import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { createLogger } from "../../log";
import {
  overlapGroupKey,
  planOverlapSupersede,
  type MetricWindow,
} from "../../metric-window-overlap";

// Issue #3424 — repair the Health Connect day-buckets that double count across a
// timezone change, and give the sync ledger a column to report a supersede in.
//
// WHAT WENT WRONG. The exporter's `daily` setting sends one interval record per
// DEVICE-LOCAL day. `upsertMetricSamples` is idempotent on
// (profile, metric, source, origin, started_at) — #1101's key, chosen so a moving END
// overwrites itself. A timezone change moves the START: Health Connect re-anchors
// "today" to the new zone's midnight, the re-anchored record arrives under a key that
// has never existed, the old row is never superseded, and `getMetricDailyTotals` SUMs
// both into one profile-local day. Measured on prod profile 1 after a one-tap
// New York → Los Angeles switch: 23330 steps on a day with 11721, and the same shape
// on distance_km, total_kcal and active_kcal.
//
// TWO PARTS, both additive-or-repairing, nothing rebuilt:
//
//  1. `integration_sync_events.superseded` — a nullable count column, exactly parallel
//     to `suppressed` (migration 023) and `edited` (migration 033), so a push that
//     DELETED stored rows says so in Data → Review instead of the deletion being
//     invisible. Guarded on PRAGMA table_info, so a fresh database and an already
//     converged one end identical.
//
//  2. THE REPLAY. Ingest now supersedes at write time, which fixes the future and
//     nothing already stored — the corrupted rows persist and keep feeding daily
//     totals, trends and trailing averages. So this replays the SAME rule over stored
//     history: within (profile, metric, source = health-connect, origin), walking
//     ascending `id` (ingest order), a later row deletes the earlier rows its
//     [started_at, ended_at) window overlaps. The rule itself is
//     lib/metric-window-overlap.ts — imported, not re-implemented, because two
//     encodings of a delete rule is how they come to disagree.
//
// SCOPED TO source = 'health-connect'. It is the one source whose day-buckets
// re-anchor under the app's feet; Withings, Oura, Strava, the Fitbit takeout and
// manual rows attribute on their own clock and are not touched by the SELECT below.
//
// WHAT IT CANNOT DELETE. Edit-locked rows (#133) — the lock outranks the repair, the
// same way it outranks the #608 sweep. Point readings (`started_at == ended_at`: HRV,
// skin temperature, lean mass, bone mass, BMR, height) — a window with no duration
// overlaps nothing. Rows in DISJOINT buckets — a fine-grained exporter setting emits
// non-overlapping windows and there is no overlap to act on, so a profile that never
// changed zone loses nothing at all.
//
// NO CHILD_LINKS REGISTRY, and that is a derived fact rather than an omission
// (#2444/#2677/#2680). `metric_samples` is a LEAF: nothing in the migrated schema
// declares a foreign key referencing it, so there is neither a non-cascading parent
// whose reference must block a delete nor a cascading child to clear by hand.
// `integration_sync_rows.target_id` names a row id in prose only — no FK — and a
// provenance row whose target is gone is the same shape a user delete already leaves.
//
// NO TOMBSTONES. These deletes are sync-internal, like the #608 sweep's: the source is
// expected to keep sending the span under its current anchoring, and a re-import
// tombstone would block that. A tombstone the USER wrote is untouched and still holds.
//
// IDEMPOTENT. A second run replays over the survivors and finds nothing: the first
// pass left every group pairwise disjoint apart from edit-locked rows, which neither
// pass may delete. A profile with no overlaps is a strict no-op — no DELETE is issued
// at all.
//
// AND IT SAYS WHAT IT DID. This removes health rows at boot, once, with no undo. The
// one run that matters is the one that actually deleted something, so every run logs,
// including the empty one — "this ran and found nothing" is the other half of the
// trail (the 20260813-cascade-orphan-sweep precedent).

const log = createLogger("migrate");

const HEALTH_CONNECT_SOURCE = "health-connect";

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

interface StoredRow extends MetricWindow {
  profile_id: number;
  metric: string;
  origin: string | null;
}

/** Every Health Connect sample row, grouped the way the supersede rule is scoped. */
function groupHealthConnectRows(
  db: Database.Database
): Map<string, StoredRow[]> {
  const rows = db
    .prepare(
      `SELECT id, profile_id, metric, origin, date, started_at, ended_at, edited
         FROM metric_samples
        WHERE source = ?
        ORDER BY id`
    )
    .all(HEALTH_CONNECT_SOURCE) as StoredRow[];
  const groups = new Map<string, StoredRow[]>();
  for (const row of rows) {
    const key = overlapGroupKey(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

export function up(db: Database.Database): void {
  let removed = 0;
  let groups = 0;
  const run = db.transaction(() => {
    if (!columnNames(db, "integration_sync_events").has("superseded")) {
      db.exec(
        `ALTER TABLE integration_sync_events ADD COLUMN superseded INTEGER;`
      );
    }
    // A database that predates metric_samples' instant columns cannot be replayed
    // against, and there is nothing to repair on one — the bug needs an origin-keyed
    // natural key (migration 083) and the renamed instant columns
    // (20260815-metric-sample-instants), both of which run before this.
    const columns = columnNames(db, "metric_samples");
    if (!columns.has("started_at") || !columns.has("ended_at")) return;

    const drop = db.prepare("DELETE FROM metric_samples WHERE id = ?");
    for (const rows of groupHealthConnectRows(db).values()) {
      const doomed = planOverlapSupersede(rows);
      if (doomed.length === 0) continue;
      groups++;
      for (const id of doomed) {
        drop.run(id);
        removed++;
      }
    }
  });
  run.immediate();

  if (removed === 0) {
    log.info(
      "20260821-hc-overlap-supersede: no overlapping Health Connect windows found, nothing removed"
    );
    return;
  }
  // WARN, not info: rows were deleted from a health database and the operator has no
  // other record of it.
  log.warn(
    `20260821-hc-overlap-supersede: removed ${removed} Health Connect sample row(s) ` +
      `whose window a later-ingested row already covered (#3424)`,
    { removed, groups }
  );
}

export const migration: Migration = {
  name: "20260821-hc-overlap-supersede",
  up,
};
