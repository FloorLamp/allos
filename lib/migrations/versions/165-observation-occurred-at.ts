import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 165 (issue #2237 — #2205 phase 2, wave 1): `occurred_at TEXT` NULL on
// `medical_records`, `body_metrics` and `intake_item_logs`.
//
// THREE TABLES, ONE MIGRATION, BECAUSE IT IS ONE CONCEPT. Split across three slots
// there would be a window where `occurred_at` means something on one observation store
// and does not exist on the next — which is the drift phase 2 exists to end. It is also
// the cheaper shape: three plain ADD COLUMNs, no rebuild, no key touched, nothing to
// null beforehand, and `assertContiguousIds` would otherwise serialize three agents
// behind each other for one ALTER TABLE apiece.
//
// WHAT THE COLUMN MEANS, identically in all three places: the instant the reading or
// intake ACTUALLY HAPPENED, as the user or the source stated it, serialized in
// lib/date.ts's canonical `utcInstant` shape (`YYYY-MM-DDTHH:MM:SSZ`).
//
// NULL MEANS "DAY-GRAIN READING" — absence, not empty apparatus. Every existing row
// gets NULL and stays exactly as honest as it was: nobody stated a time, so the app
// does not have one. `eventInstant()` answers `not-recorded` for those rows, which is a
// different and more informative fact than the `not-declared` it answers today.
//
// NULL, NOT A `${date}T00:00:00` MIDNIGHT ANCHOR — and the asymmetry with
// `metric_samples` is deliberate (#2235 decision 2). `metric_samples.start_time` is
// part of its natural key, so an untimed reading MUST file at day-midnight for a
// re-entry to be a correction rather than a duplicate. All three tables here carry a
// real `date` column and key on it, so they can afford honest absence. After this
// lands, two of the three observation stores spell "not stated" as NULL and one spells
// it as midnight; naming that is worth more than hiding it behind a uniform-looking
// anchor that would quietly change what a row's key means.
//
// WHAT THIS DELIBERATELY IS NOT:
//   • NOT the `given_at` → `recorded_at` rename. That is a rebuild plus a dozen
//     COALESCE readers — the part that can actually fail — and bundling it here would
//     roll back three trivially-safe columns with it. Its own later slot.
//   • NOT #2154's temperature notes-hack data move. Parsing `HH:MM` out of free-text
//     `notes` is a lossy parse needing its own row accounting. A data move belongs in a
//     migration, just not this one.
//   • NOT a write path. Nothing populates `occurred_at` yet, by design: the column and
//     its declaration are one reviewable thing, and manual capture, importer writes and
//     the reading-model mapping follow it in #2154 / #2235.
//
// `date` SEMANTICS ARE UNTOUCHED (#2205 constraint 4). The row's day attribution stays
// its `date` column; an instant is a different question and this column answers only
// that one. Nothing branches on `occurred_at` in this change.
//
// DECLARED, NOT JUST ADDED. All three columns are registered in lib/time-columns.ts
// (semantic `event`, grain `instant`, convention `canonical`) in this same change, and
// in `CANONICAL_INSTANT_COLUMNS` in lib/__tests__/instant-writer-scan.test.ts — so the
// FIRST writer that lands is already forced to bind `utcInstant()`/`instantNow()`
// rather than SQL's own bare-shaped clock. The column is born on the convention rather
// than converted onto it, which is why it joins that registry now and not later.
//
// NO DEFAULT, deliberately: a clock DEFAULT would stamp every insert with the moment
// the row was written, which is the RECORD instant wearing the event column's name —
// exactly the substitution #2205 exists to close.
const TABLES = ["medical_records", "body_metrics", "intake_item_logs"] as const;

export function up(db: Database.Database): void {
  for (const table of TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    // Replay-safe: the DB test tier replays migrations over an at-rest database
    // through the non-version-gated migrate() wrapper, and SQLite has no
    // `ADD COLUMN IF NOT EXISTS`.
    if (cols.some((c) => c.name === "occurred_at")) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN occurred_at TEXT`);
  }
}

export const migration: Migration = {
  id: 165,
  name: "165-observation-occurred-at",
  up,
};
