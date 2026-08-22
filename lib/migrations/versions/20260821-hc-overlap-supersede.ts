import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { utcInstant } from "../../date";
import {
  UNSTAMPED_ERA_AT_KEY,
  UNSTAMPED_ERA_MAX_ID_KEY,
} from "../../metric-window-overlap";

// Issue #3424 — the two columns the Health Connect overlap-supersede needs.
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
// TWO ADD COLUMNs AND NOTHING ELSE. Both are metadata-only in SQLite, so this holds the
// write lock for microseconds and a boot pays no scan.
//
//  1. `integration_sync_events.superseded` — a nullable count, exactly parallel to
//     `suppressed` (migration 023) and `edited` (033), so a push that DELETED stored
//     rows says so in Data → Review instead of the deletion being invisible.
//
//  2. `metric_samples.pushed_at` — the instant the EXPORTER stamped on the push that
//     wrote the row (`payload.timestamp`). The supersede reads it to answer "is the
//     incoming row newer than the one it would delete?" from what the PAYLOAD states
//     rather than from arrival order. Without it the rule is defeated by an ordinary
//     exporter retry: a byte-identical replay of a pre-switch push deleted the row that
//     had superseded it and re-inserted the stale one. NULL on every row written before
//     this migration and on every non-Health-Connect row.
//
// AND TWO `settings` VALUES, WHICH ARE WHY THAT NULL IS SAFE. An earlier cut of this
// comment said the rule reads a NULL stamp as "no stamp, may be superseded once — those
// are exactly the already-corrupted rows". THAT WAS FALSE, and it was the last defect in
// this lane: NULL is every row written before this migration, the CORRECT ones included,
// and it stays NULL for any day the exporter's rolling window no longer reaches until
// #3439 runs. Read as "old", a byte-identical replay of a pre-switch push deleted the
// correct re-anchored row — the day went from reading 23330 (wrong, visible, repairable)
// to 11609 (wrong, invisible, and past #3439's reach because the right row was gone).
//
// NULL means UNKNOWN. So this migration writes down the two facts that make a subset of
// those NULLs checkable, and the rule will delete no others:
//
//  3. `hc_overlap_unstamped_era_at` — the instant `pushed_at` began being written, on
//     THIS SERVER'S clock. A push stamped after it SAYS it happened after every row
//     already in the table; it is compared against a PHONE's stamp, so that half is a
//     cross-clock comparison rather than an exact one, and it fails toward keeping rows
//     (a phone running behind collapses none of its own pre-era NULLs until real time
//     passes the offset). lib/metric-window-overlap.ts spells this out.
//  4. `hc_overlap_unstamped_era_max_id` — `MAX(metric_samples.id)` at that instant. This
//     half IS exact: `id` is INTEGER PRIMARY KEY AUTOINCREMENT (migration 083), so it is
//     monotonic and never reused, and `id <= that` cannot become true for a row written
//     later.
//
// Written FIRST-WRITE-WINS, never moved. A re-run — a restore, a half-applied database,
// a second boot — happens later than the moment the column landed, and moving the marker
// forward would re-classify every row written in between as pre-existing, which is the
// confusion the marker exists to end.
//
// THERE IS NO REPAIR REPLAY HERE, deliberately, and its absence is the change this
// migration went through. The first cut also replayed the supersede rule over stored
// history at boot. Three things sent it back:
//
//   * COST. The replay planner was O(group²) with no window: 5k rows in one group took
//     1.8 s, 50k took 30 s, 100k took 595 s. A year of `1m` steps for one origin is
//     525,600 rows in ONE group. End to end, a database with 30,000 one-minute buckets
//     spent 2m24s at boot to decide there was nothing to do.
//   * BLAST RADIUS. Holding the write lock that long kills every concurrent boot:
//     a second process 5 s behind died with SQLITE_BUSY after 122 s, and lib/db.ts
//     names three steady-state writers.
//   * VISIBILITY. It deleted rows and wrote no `integration_sync_events` row at all, so
//     the "a person can see in Review that a delete happened" argument covered ingest
//     only — while the migration was where the bulk of the deleting happened.
//
// The historical repair is tracked as its own change (#3439) and needs a planner that
// is not quadratic, a bounded lock, and a Review-visible record of what it removed.
// Ingest converges an affected span on the next push either way; what #3439 buys is
// the days the rolling window no longer reaches.

// NOT SPELLED `{ table, column }`, deliberately. lib/__db_tests__/migration-link-scan.ts
// reads every `{ table: "…", column: "…" }` literal in a migration source as a CHILD_LINKS
// declaration, and #2677's census then demands a fixture exercising the pair. This list
// declares no child links — it names two columns to add — so it uses different keys
// rather than widening a guard to accommodate a false positive.
const ADDITIONS: { onTable: string; addColumn: string; type: string }[] = [
  {
    onTable: "integration_sync_events",
    addColumn: "superseded",
    type: "INTEGER",
  },
  { onTable: "metric_samples", addColumn: "pushed_at", type: "TEXT" },
];

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((r) => r.name === column);
}

export function up(db: Database.Database): void {
  // Guarded on PRAGMA table_info so a fresh database, a half-applied one and an already
  // converged one all end identical, and a re-run is a strict no-op.
  db.transaction(() => {
    for (const { onTable, addColumn, type } of ADDITIONS) {
      if (hasColumn(db, onTable, addColumn)) continue;
      db.exec(`ALTER TABLE ${onTable} ADD COLUMN ${addColumn} ${type};`);
    }
    // The era markers. `MAX(id)` on an INTEGER PRIMARY KEY is an index lookup, not a
    // scan, so this stays the "touches no row" migration it was: on the 30,000-row
    // database the first pass measured, it is two `settings` inserts and one seek.
    //
    // DO NOTHING, not DO UPDATE: first write wins, for the reason in the header. Written
    // here rather than through lib/settings because a migration takes its handle as an
    // argument and must not reach back into `@/lib/db`, which is what runs it.
    const maxId =
      (
        db.prepare("SELECT MAX(id) AS maxId FROM metric_samples").get() as {
          maxId: number | null;
        }
      ).maxId ?? 0;
    const put = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
    );
    put.run(UNSTAMPED_ERA_AT_KEY, utcInstant());
    put.run(UNSTAMPED_ERA_MAX_ID_KEY, String(maxId));
  }).immediate();
}

export const migration: Migration = {
  name: "20260821-hc-overlap-supersede",
  up,
};
