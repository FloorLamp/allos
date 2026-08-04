import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 150 (issue #1973): give a dose's SCHEDULE an effective-dated history, so a
// past day can be judged by the rule that was in force on it.
//
// ── THE CONTRADICTION THIS ENDS ──────────────────────────────────────────────
//
// The invariant is "editing a dose must not rewrite adherence history". Migration 021
// implemented it by CLAMPING: `doseAdherenceSince` took a dose's adherence lower bound
// from `updated_at`, so a re-time voided every day before the edit. The invariant was
// honoured by throwing the history away — the same mistake as retroactive re-judgment,
// pointed the other way. Both are a present edit deciding what was true in the past.
//
// Adherence is taken / due, and `due` is a JUDGMENT derived from the schedule. The only
// shape that neither rewrites nor erases is to record WHEN each schedule applied, and
// judge each day against the version in force on it. Once every day can be judged
// correctly, the edit clamp has nothing left to protect and is removed (lib/rule-findings
// now bounds the pattern window by EXISTENCE alone — doseWindowSince, #430/#1442 — which
// is a different question and keeps its own, better answer).
//
// ── WHY A CHILD TABLE, NOT effective_from/to COLUMNS ON A VERSIONED ROW ──────
//
// A dose ROW ID is a stable external identity. `intake_item_logs.dose_id` and
// `intake_administrations.dose_id` point at it, in-flight Telegram reminder keyboards
// carry it, and the adherence-pattern dedupe keys are built from it precisely because
// ids never recycle (AGENTS.md #203). Versioning the row itself — several rows per dose,
// one of them current — would mint a NEW id on every schedule edit: adherence logs would
// scatter across version rows, a frozen Telegram button would address a superseded row,
// and a dismissed finding would re-fire under a new key. A child history keeps ONE dose
// id forever and puts the versions beside it.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
//
// Only the DUENESS-RELEVANT fields are versioned — `time_of_day` (the slot), `weekdays`,
// `start_date`, `end_date`. Amount, food timing and sort are deliberately absent: they
// cannot make a day due or not due, so a typo fix in an amount has nothing to version and
// cannot move an adherence boundary. The amount a person actually took is already
// snapshotted onto the LOG at confirm time, which is where that history belongs.
//
// Versions are HALF-OPEN: `effective_from` only, closed by the next version. A schedule
// change is therefore a single append (never a two-row update), and "no gaps, no
// overlaps" is structural instead of an invariant two rows must keep agreeing about.
// UNIQUE (dose_id, effective_from) collapses several edits on one calendar day to that
// day's final state, which is the right grain because dueness is evaluated per DAY.
//
// ── BEHAVIOUR PRESERVATION ───────────────────────────────────────────────────
//
// One version per existing dose, holding the row's CURRENT schedule, effective from the
// dose's own `created_at` (migration 021 backfilled that from the parent item, and the
// COALESCE falls back to the item and then to the epoch, so the column being NULL cannot
// drop a dose out of the seed). For an un-edited dose that reproduces today's answer
// exactly: one version covering the whole window means every day resolves to the current
// row, which is what every reader already used. And the resolver's "a day before the
// first version reads the EARLIEST version" fallback means even days before `created_at`
// — days the existence bound already handles — are judged identically to today.
//
// A dose with NO version rows (a later importer/fixture insert) reads as "this row,
// always", the same pre-#1973 behaviour, so nothing outside this migration has to be
// backfilled for correctness. The edit path lazily records a dose's pre-edit schedule
// before appending a new version, so a dose of any origin gets an honest history the
// first time its schedule actually changes.
//
// ── HOUSE RULES (CLAUDE.md) ──────────────────────────────────────────────────
//
// One new table, no rebuild, so there is nothing to null beforehand. It carries no
// `profile_id` and cannot: it is a CHILD of intake_item_doses (itself a child of
// intake_items), scoped and deleted through its parent's profile_id by join, exactly like
// intake_item_logs — so it stays out of lib/owned-tables.ts, and its reads name profile_id
// through that join. The FK is ON DELETE CASCADE, so the import-footprint FK scan reaches
// it transitively and a dose delete takes its history with it; deleteProfile clears it
// explicitly (that sweep runs with foreign_keys OFF) and undo-delete captures it as a
// child entity so a restored item keeps its schedule history.
//
// CREATE TABLE/INDEX IF NOT EXISTS plus a NOT EXISTS-guarded seed make a replay a pure
// no-op, so the non-version-gated migrate() test wrapper can run it twice; production
// applies it once behind the user_version gate. Self-contained — imports nothing from
// lib/ — so a replay is decided purely by the DB catalog. Determinism (spec): reads only
// the DB and this file's own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intake_dose_schedule_versions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      dose_id        INTEGER NOT NULL
                     REFERENCES intake_item_doses(id) ON DELETE CASCADE,
      -- Profile-LOCAL calendar day (YYYY-MM-DD) this schedule took effect, inclusive.
      -- Local, not UTC, because it is compared against the profile-local dates window
      -- every adherence surface is built from; a UTC day would be off by one for every
      -- profile whose offset crosses midnight.
      effective_from TEXT NOT NULL,
      -- The dueness-relevant schedule as of that day. All nullable, exactly as on the
      -- dose row: NULL means "no opinion", not "unset".
      time_of_day    TEXT,
      weekdays       TEXT,
      start_date     TEXT,
      end_date       TEXT,
      -- When the version row was WRITTEN (the sqlNow clock seam, #1534), which is not
      -- the same thing as when the schedule took effect — a backfilled version records
      -- a past effective_from.
      created_at     TEXT
    );
  `);
  // The only access pattern: every version of one dose, oldest first. UNIQUE so a second
  // edit on the same calendar day UPSERTs that day's version rather than appending an
  // ambiguous duplicate.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dose_schedule_versions_dose_day
      ON intake_dose_schedule_versions(dose_id, effective_from);
  `);
  // Seed one version per existing dose: the row's current schedule, effective from the
  // dose's birth. Guarded by NOT EXISTS so a replay adds nothing.
  db.exec(`
    INSERT INTO intake_dose_schedule_versions
      (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
    SELECT d.id,
           substr(COALESCE(d.created_at, i.created_at, '1970-01-01'), 1, 10),
           d.time_of_day, d.weekdays, d.start_date, d.end_date,
           COALESCE(d.created_at, i.created_at, '1970-01-01 00:00:00')
      FROM intake_item_doses d
      JOIN intake_items i ON i.id = d.item_id
     WHERE NOT EXISTS (
       SELECT 1 FROM intake_dose_schedule_versions v WHERE v.dose_id = d.id
     );
  `);
}

export const migration: Migration = {
  id: 150,
  name: "150-dose-schedule-versions",
  up,
};
