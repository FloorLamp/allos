// The stored menstrual-cycle log (issue #714). One `cycles` row per recorded period —
// identity + annotations, mirroring illness_episodes (#856): the row carries ONLY the
// period's own data (start/inclusive end of bleeding, flow, note); the cycle PHASE and
// length/variability trends stay DERIVED (lib/cycle.ts) and per-day cycle symptoms live
// in symptom_logs (a vocabulary extension), so nothing FKs to a cycle and a boundary
// edit is automatically correct.
//
// Auth-blind (profileId-first, never imports lib/auth — #319): the Server Action owns the
// gate + revalidation. Every statement is profile-scoped (the scoping rule). Row writes go
// through writeTx (BEGIN IMMEDIATE, #468).

import { db, writeTx } from "./db";
import type { CyclePeriod, FlowLevel } from "./cycle";

export interface CycleRow extends CyclePeriod {
  profile_id: number;
}

const COLS = "id, period_start, period_end, flow, note";

// Map a stored row to the pure derivation shape (lib/cycle.ts). Identity here since the
// selected columns already match CyclePeriod; kept explicit so a future column can't leak
// into the pure layer.
export function rowToPeriod(row: CycleRow): CyclePeriod {
  return {
    id: row.id,
    period_start: row.period_start,
    period_end: row.period_end,
    flow: row.flow,
    note: row.note,
  };
}

// One cycle row by id, scoped to the profile.
export function getCycleRow(
  profileId: number,
  id: number
): CyclePeriod | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM cycles WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as CyclePeriod | undefined) ?? null
  );
}

// All of a profile's recorded periods, most-recent first. The Cycle surface list + the
// pure derivations (phase/trend) read this.
export function listCyclePeriods(profileId: number): CyclePeriod[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM cycles
        WHERE profile_id = ?
        ORDER BY period_start DESC, id DESC`
    )
    .all(profileId) as CyclePeriod[];
}

// The current OPEN period (period_end IS NULL), most-recently started, or null — the
// "period ended" one-tap target and the "already logging a period" guard.
export function getOpenPeriod(profileId: number): CyclePeriod | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM cycles
          WHERE profile_id = ? AND period_end IS NULL
          ORDER BY period_start DESC, id DESC
          LIMIT 1`
      )
      .get(profileId) as CyclePeriod | undefined) ?? null
  );
}

// The period whose recorded start EQUALS `date`, or null — dedup guard so tapping
// "period started" twice on one day doesn't mint two rows.
export function getPeriodStartingOn(
  profileId: number,
  date: string
): CyclePeriod | null {
  return (
    (db
      .prepare(
        `SELECT ${COLS} FROM cycles
          WHERE profile_id = ? AND period_start = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(profileId, date) as CyclePeriod | undefined) ?? null
  );
}

// Insert a period row. Opens its own writeTx. Returns the new id.
export function createCycleRow(
  profileId: number,
  periodStart: string,
  periodEnd: string | null,
  flow: FlowLevel | null,
  note: string | null
): number {
  return writeTx(() =>
    Number(
      db
        .prepare(
          `INSERT INTO cycles (profile_id, period_start, period_end, flow, note)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(profileId, periodStart, periodEnd, flow, note?.trim() || null)
        .lastInsertRowid
    )
  );
}

// Update a period row in place. Opens its own writeTx. Returns true when a row changed.
export function updateCycleRow(
  profileId: number,
  id: number,
  periodStart: string,
  periodEnd: string | null,
  flow: FlowLevel | null,
  note: string | null
): boolean {
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE cycles
              SET period_start = ?, period_end = ?, flow = ?, note = ?
            WHERE id = ? AND profile_id = ?`
        )
        .run(periodStart, periodEnd, flow, note?.trim() || null, id, profileId)
        .changes > 0
  );
}

// Delete a period row. Nothing FKs into cycles, so this is a plain scoped delete. Opens
// its own writeTx. Returns true when a row was removed.
export function deleteCycleRow(profileId: number, id: number): boolean {
  return writeTx(
    () =>
      db
        .prepare(`DELETE FROM cycles WHERE id = ? AND profile_id = ?`)
        .run(id, profileId).changes > 0
  );
}
