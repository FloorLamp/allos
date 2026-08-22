import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3087 — every user-write ledger in the first tranche gains `logged_via`, the
// durable record of WHICH SURFACE a person logged from.
//
// WHY THIS SHAPE, column by column's worth of reasoning:
//
//   • A PLAIN TEXT COLUMN, NOT A LINK. The thing that already looked like
//     provenance is `notify_message_id` (#2264), which is a correction pointer:
//     `REFERENCES notify_messages(id) ON DELETE SET NULL` against a table pruned on
//     a 3-day retention. It is designed to evaporate, so it cannot answer a question
//     about last month. This column takes no foreign key into anything with a
//     retention or reconcile lifecycle — that is the defect the issue exists to
//     correct, and adding an FK here would reproduce it exactly.
//
//   • NO `CHECK` CONSTRAINT, deliberately. The vocabulary is closed in TypeScript
//     (lib/logged-via.ts) and checked at the untyped boundaries; a SQLite CHECK
//     would put the same closed set in a place that can only be GROWN by a table
//     rebuild (lib/migrations/AGENTS.md), which is a large price for a second copy
//     of a list the type system already owns. The static guard in
//     lib/__tests__/logged-via-census.test.ts covers the one gap a type cannot: a
//     hand-written INSERT that forgets the column entirely.
//
//   • NULLABLE, NO DEFAULT, NO BACKFILL. Every existing row reads NULL, which means
//     "unknown", honestly. The tempting inference — read a surface off the surviving
//     `notify_message_id` links — would seed a relevance model with the handful of
//     rows younger than the 3-day prune, i.e. with pure survivorship bias. Provenance
//     starts now.
//
//   • CREATION, NOT MUTATION. Nothing here rewrites the column later; an edit leaves
//     it alone. `practice_logs.edited` already carries the separate "this was touched
//     later" fact.
//
//   • ORTHOGONAL TO `source`. Both columns stay and neither is migrated onto the
//     other. `source` says which importer or integration produced a row;
//     `logged_via` says which surface a person used.
//
// Determinism: adds columns only. Reads nothing, writes no rows.

// The first tranche named by #3087: the three ledgers that already carry the
// correction pointer, plus the activity / body-metric / symptom / temperature
// ledgers. Temperature lives in `medical_records` (lib/temperature-log.ts writes the
// canonical °F row there so manual and synced readings form ONE series), so that is
// the temperature ledger's table.
//
// Kept as a literal list rather than derived, because a migration must describe the
// schema IT shipped: a later tranche is a later migration, and this one's meaning
// must not change when the census registry grows.
const TRANCHE = [
  "intake_item_logs",
  "food_log_events",
  "practice_logs",
  "activities",
  "body_metrics",
  "symptom_logs",
  "medical_records",
] as const;

export function up(db: Database.Database): void {
  for (const table of TRANCHE) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN logged_via TEXT`);
  }
}

export const migration: Migration = {
  name: "20260822-logged-via-provenance",
  up,
};
