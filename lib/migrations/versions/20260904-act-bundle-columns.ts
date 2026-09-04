import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5082 — ONE ACT ID, EVERY COMPOSED WRITE.
//
// `intake_item_logs.bundle_id` (#4328) recorded that one action wrote several dose
// rows, and stopped there — so the same tap that bundles six doses left three servings
// that only shared a minute. These three columns are the rest of the same fact:
// `food_log_events`, `practice_logs` and `body_metrics` carry the id their act minted,
// so a reader asks the composition question once, of every domain.
//
// SAME SHAPE AS 20260902-dose-write-bundle, deliberately: plain TEXT, nullable, no
// default, no CHECK, no index. The value is minted in TypeScript (`lib/bundle.ts`) and
// is opaque to SQL, and the readers that will want it read one profile-day of rows and
// group them in memory.
//
// AND NO BACKFILL, for the reason the dose column had none and one more. A historical
// row that WAS one act cannot be told apart from one that was not, so deriving a bundle
// from shared write minutes would manufacture exactly the inference `lib/day-ledger.ts`
// retired — as a stored value nobody could afterwards tell from a recorded one. NULL
// means "this row does not record having been written with others", which is honest for
// every row that exists today.
//
// `body_metrics` GETS THE COLUMN BEFORE IT HAS A WRITER, and that is the point. One
// submit of the measurements form lands ONE row today, so nothing composes and nothing
// mints; when #3428 splits the sitting into per-measure readings, "taken in one sitting"
// has somewhere to be recorded instead of being lost at the split. Same for
// `practice_logs`: no composed writer reaches it yet, and a single write never mints.
//
// Determinism: adds columns only. Reads nothing, writes no rows.
const TABLES = ["food_log_events", "practice_logs", "body_metrics"] as const;

export function up(db: Database.Database): void {
  // Replay-safe: the DB tier replays migrations over an at-rest database through the
  // non-version-gated migrate() wrapper, and SQLite has no ADD COLUMN IF NOT EXISTS.
  for (const table of TABLES) {
    const existing = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name)
    );
    if (existing.has("bundle_id")) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN bundle_id TEXT`);
  }
}

export const migration: Migration = {
  name: "20260904-act-bundle-columns",
  up,
};
