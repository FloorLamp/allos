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
import { captureDelete } from "./undo-delete-db";
import { forecastNextPeriod } from "./cycle";
import type {
  CycleForecast,
  CyclePeriod,
  FlowLevel,
  ForecastSuspension,
} from "./cycle";
import {
  getRiskAttributes,
  getProfileReproductiveStatus,
} from "./settings/profile-attrs";

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
export function getCycleRow(profileId: number, id: number): CyclePeriod | null {
  return (
    (db
      .prepare(`SELECT ${COLS} FROM cycles WHERE id = ? AND profile_id = ?`)
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
// "period ended" one-tap target. The pure equivalent over an already-read history is
// openPeriodIn (lib/cycle-plausibility), which the multi-check cores use so one read
// answers every guard.
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

// Delete a period row. Nothing FKs into cycles, so the capture is the single scoped
// row — but the row feeds cycle-length history, regularity, and the forecast, so the
// delete is UNDOABLE (#2127): captureDelete snapshots the row into the undo holding
// table and deletes it in ONE transaction (its own writeTx), returning the undo token
// the surface's toast offers. This stays the registered stateful-write core for
// `cycles`; the DELETE now runs through the generic capture machinery's
// `DELETE FROM ${root.table}`, which the write scan documents as out of its sight.
export function deleteCycleRow(
  profileId: number,
  id: number
): { kind: "deleted"; undoId: number } | { kind: "not-found" } {
  const undoId = captureDelete("cycle", profileId, id);
  return undoId == null ? { kind: "not-found" } : { kind: "deleted", undoId };
}

// ---- The forecast gather (issue #1679) --------------------------------------

// Whether this profile's forecast is SUSPENDED, and why. Gathered here so every surface
// asks the question once (#221) and none of them re-reads the attributes.
//
// Pregnancy reads the shipped `risk_pregnant` profile attribute — the app's current
// representation of an ongoing pregnancy. #1402 replaces that flag with a
// `pregnancy_episodes` row and makes the gate "has an ongoing episode"; because the
// suspension is resolved HERE and handed to the pure forecast as data, that swap is a
// one-line change in this function and touches nothing else.
export function getForecastSuspension(
  profileId: number
): ForecastSuspension | null {
  if (getRiskAttributes(profileId).pregnant) return "pregnancy";
  if (getProfileReproductiveStatus(profileId) === "postmenopausal")
    return "postmenopausal";
  return null;
}

// THE next-period forecast for a profile: the profile-scoped period history plus the
// resolved suspension, handed to the ONE pure projection. Every consumer (the Cycle
// surface, the dashboard tile) calls this and formats the result.
export function getCycleForecast(
  profileId: number,
  todayStr: string
): CycleForecast {
  return forecastNextPeriod(
    listCyclePeriods(profileId),
    todayStr,
    getForecastSuspension(profileId)
  );
}
