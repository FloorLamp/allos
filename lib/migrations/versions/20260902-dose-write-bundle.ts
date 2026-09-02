import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #4328 — ONE COMPOSED WRITE, RECORDED RATHER THAN INFERRED.
//
// The Day ledger folded doses written by one composed tap into a single row by
// GUESSING which rows shared a tap: same routine, same bucket, same write minute. Two
// independent single taps landing in one minute therefore rendered as one composed
// row. `bundle_id` is the fact the guess stood in for — one value stamped on every row
// a single composed action writes (the usual's dose half, a stack one-tap, a Take-all),
// so the reader keys on what happened instead of on when it was filed.
//
// SAME SHAPE AS THE #3087 PROVENANCE TRANCHE: plain TEXT, nullable, no default, no
// CHECK, no index — the ledger reads one profile-day of rows and groups them in memory,
// so there is nothing to index for. The value is minted in TypeScript
// (`lib/dose-bundle.ts`) and is opaque to SQL.
//
// AND NO BACKFILL, DELIBERATELY. Every pre-existing row reads NULL, which means "this
// row does not record having been written with others" — honestly. Deriving a bundle
// from shared write minutes at backfill time would re-mint the very inference this
// column retires, in a place that then looks authoritative: a stored value nobody can
// tell from a recorded one. So old composed writes stop rendering as composed rows,
// which is the cost of not writing down a guess.
//
// Determinism: adds a column only. Reads nothing, writes no rows.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(intake_item_logs)").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  if (columns.has("bundle_id")) return;
  db.exec(`ALTER TABLE intake_item_logs ADD COLUMN bundle_id TEXT`);
}

export const migration: Migration = {
  name: "20260902-dose-write-bundle",
  up,
};
