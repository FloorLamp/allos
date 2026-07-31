import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 126 (issue #1602): give intake scheduling a CALENDAR axis. Until now the
// whole scheduling vocabulary was `intake_item_doses` = amount + time_of_day (+ food
// timing) under an item-level `condition`, i.e. "these doses, every eligible day".
// There was no day-of-week, no every-N-days, and no date-varying amount, so a weekly
// methotrexate, an alternating-day warfarin, a prednisone taper and a 72h patch could
// not be scheduled honestly.
//
// The workaround was a SAFETY INVERSION: a weekly med either nagged daily or got
// demoted to the no-expectation obligation level (`may`, which absorbed the old
// `as_needed` in migration 124) — stripping reminders, missed-dose escalation and
// adherence tracking from exactly the narrow-therapeutic drugs that need them most.
// Methotrexate-taken-daily is a textbook harm scenario. These columns let the machinery
// say "NOT today" while the item stays `must`.
//
// WHY each column:
//
//   intake_items.cadence_kind — the item-level calendar rule, and the only one of these
//     columns that is NOT NULL. 'daily' is the DEFAULT and reproduces today's behaviour
//     byte-for-byte, so every existing row keeps its exact current dueness and no
//     backfill is needed. 'weekly' reads cadence_weekdays; 'interval' reads
//     cadence_interval_days + cadence_anchor_date. The CHECK is carried by the ADD
//     COLUMN itself (SQLite allows and enforces a CHECK on an added column, unlike a
//     UNIQUE/PRIMARY KEY), so no table rebuild is needed to constrain the enum.
//
//   intake_items.cadence_weekdays — CSV of weekday indices for 'weekly'. The indices are
//     the repo's existing 0=Sun … 6=Sat convention (lib/date.ts `weekdayOfDateStr`,
//     WEEKDAYS_SHORT, weekdayOrder, startOfWeekStr) rather than the ISO 1=Mon … 7=Sun
//     numbering the issue sketched: a second weekday numbering living beside the first
//     is a standing off-by-one bug, and the whole point of one canonical identity
//     function is that every reader agrees. "1" = Mondays; "1,4" = Mon+Thu.
//
//   intake_items.cadence_interval_days + cadence_anchor_date — 'interval': due when
//     daysBetween(anchor, date) is a non-negative multiple of the interval. The anchor
//     is a calendar date (YYYY-MM-DD), so the arithmetic is UTC-anchored and DST-immune
//     the same way every other stored-date comparison in this codebase is.
//
//   intake_item_doses.weekdays — NULL = due on every one of the item's on-days (today's
//     behaviour). Set = this dose ROW only lands on these weekdays. This is how
//     ALTERNATING AMOUNTS are expressed without a new table: warfarin is ONE item with
//     two dose rows ("5 mg · Mon/Wed/Fri", "2.5 mg · Tue/Thu/Sat/Sun"), each keeping its
//     own adherence history keyed on its own dose_id.
//
//   intake_item_doses.start_date / end_date — an inclusive validity window, NULL = open
//     at that end. This is how a TAPER is expressed: prednisone 40→30→20→10 is one item
//     with four windowed dose rows. A window EXPIRING is deliberately not a retire — the
//     row simply stops being due while its logs read untouched — which is what makes
//     "editing a dose never rewrites adherence history" hold BY CONSTRUCTION for a
//     mid-course taper change: you add/end window rows instead of editing amounts, and a
//     confirm still snapshots the amount onto the log.
//
// All six columns are nullable or defaulted, so existing rows are byte-identical after
// this migration and every pre-existing item reads as 'daily' — no data move, and the
// dueness of everything already scheduled is unchanged.
//
// House rules (CLAUDE.md): plain guarded ADD COLUMNs, so there is no table rebuild and
// therefore nothing to null beforehand. `intake_items` and `intake_item_doses` are
// already profile-owned (the doses scope through their parent item), already in the
// import/export footprint, and already in every cleanup list — a column ON those rows
// is not a new footprint table, so no registry changes. Every ADD COLUMN is guarded by
// a column-presence check so a non-version-gated replay is a pure no-op; production
// applies each exactly once behind the version gate. Determinism (spec): reads only the
// DB catalog and its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  const itemCols = columnNames(db, "intake_items");
  if (!itemCols.has("cadence_kind")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN cadence_kind TEXT NOT NULL DEFAULT 'daily'
         CHECK (cadence_kind IN ('daily','weekly','interval'))`
    );
  }
  if (!itemCols.has("cadence_weekdays")) {
    db.exec(`ALTER TABLE intake_items ADD COLUMN cadence_weekdays TEXT`);
  }
  if (!itemCols.has("cadence_interval_days")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN cadence_interval_days INTEGER`
    );
  }
  if (!itemCols.has("cadence_anchor_date")) {
    db.exec(`ALTER TABLE intake_items ADD COLUMN cadence_anchor_date TEXT`);
  }

  const doseCols = columnNames(db, "intake_item_doses");
  if (!doseCols.has("weekdays")) {
    db.exec(`ALTER TABLE intake_item_doses ADD COLUMN weekdays TEXT`);
  }
  if (!doseCols.has("start_date")) {
    db.exec(`ALTER TABLE intake_item_doses ADD COLUMN start_date TEXT`);
  }
  if (!doseCols.has("end_date")) {
    db.exec(`ALTER TABLE intake_item_doses ADD COLUMN end_date TEXT`);
  }
}

export const migration: Migration = {
  id: 126,
  name: "126-intake-cadence",
  up,
};
