import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3950 (owner ruling, 2026-08-29): `weight_at`, `body_fat_at` and
// `resting_hr_at` — TEXT NULL — on `body_metrics`.
//
// THREE COLUMNS BECAUSE THERE ARE THREE READINGS. Health Connect delivers weight,
// body fat and resting heart rate with their OWN instants: a 07:00 fasted weigh-in
// and a 22:00 resting-HR average are different measurements that happen to share a
// day row. #3551 parses all three and carries them in memory only, because one
// shared column cannot hold three — stamping `occurred_at` with the day's latest
// instant would report that weigh-in as 22:00.
//
// `occurred_at` IS NOT REPLACED AND NOT A FOURTH SPELLING OF THESE. It is the time
// the PERSON stated for their own sitting (migration 165 / #2235, written by the
// measurements form). These three are what the SOURCE said about each measure. A
// manual row states one time for the sitting and has no per-measure instants; an
// imported row has per-measure instants and no stated sitting. Both are honest, and
// neither can answer the other's question.
//
// THE #608 TWO-DEVICE DEDUP IS UNTOUCHED, as the ruling requires. The natural key
// stays (profile_id, date, source) — day grain — so nothing about which rows are
// candidates, which collapse, or which win changes here. These columns are
// DESCRIPTIVE: they say when a stored measure was taken, and enable no second row.
//
// NULL MEANS "THE SOURCE STATED NO INSTANT", which is the honest answer for every
// existing row, for manual entry, and for document extraction. Readers keep reading
// `date`; a reader that wants the finer answer asks for it and tolerates its absence.
//
// NO DEFAULT: a clock default would stamp the moment the ROW was written, which is
// the record instant wearing the event column's name (#2205).
//
// DECLARED, NOT JUST ADDED: all three are registered in lib/time-columns.ts and in
// CANONICAL_INSTANT_COLUMNS (lib/__tests__/instant-writer-scan.test.ts) in this same
// change, so the writer is bound to lib/date.ts's canonical shape from the start.
const COLUMNS = ["weight_at", "body_fat_at", "resting_hr_at"] as const;

export function up(db: Database.Database): void {
  // Replay-safe: the DB tier replays migrations over an at-rest database through the
  // non-version-gated migrate() wrapper, and SQLite has no ADD COLUMN IF NOT EXISTS.
  const existing = new Set(
    (
      db.prepare("PRAGMA table_info(body_metrics)").all() as { name: string }[]
    ).map((c) => c.name)
  );
  for (const column of COLUMNS) {
    if (existing.has(column)) continue;
    db.exec(`ALTER TABLE body_metrics ADD COLUMN ${column} TEXT`);
  }
}

export const migration: Migration = {
  name: "20260902-body-metric-measure-instants",
  up,
};
