// Auth-blind write cores for the menstrual-cycle log (issue #714). profileId-first, never
// imports lib/auth — the Server Action owns the gate + revalidation (#319). The one-tap
// "period started" / "period ended" transitions carry the interesting logic (dedup, the
// open-period guard, the end-after-start check) and answer from a typed outcome union, so
// a handler never unconditionally confirms; plain create/edit/delete ride the store CRUD.
//
// Each core is ONE writeTx (BEGIN IMMEDIATE, #468): the open-period read and the write
// commit together, so two quick taps can't mint a second open period. Nested store writeTx
// calls become SAVEPOINTs.

import { writeTx } from "./db";
import type { FlowLevel } from "./cycle";
import {
  createCycleRow,
  getOpenPeriod,
  getPeriodStartingOn,
  updateCycleRow,
} from "./cycle-store";

export type StartPeriodOutcome =
  | { kind: "started"; id: number }
  | { kind: "already-open"; id: number }
  | { kind: "duplicate"; id: number };

// One-tap "period started" on `date`. Idempotent-ish: if a period is already open, or one
// already starts on this day, it reports that instead of minting a duplicate.
export function startPeriodCore(
  profileId: number,
  date: string,
  flow: FlowLevel | null = null
): StartPeriodOutcome {
  return writeTx(() => {
    const open = getOpenPeriod(profileId);
    if (open) return { kind: "already-open", id: open.id };
    const sameDay = getPeriodStartingOn(profileId, date);
    if (sameDay) return { kind: "duplicate", id: sameDay.id };
    const id = createCycleRow(profileId, date, null, flow, null);
    return { kind: "started", id };
  });
}

export type EndPeriodOutcome =
  | { kind: "ended"; id: number }
  | { kind: "none-open" }
  | { kind: "invalid" };

// One-tap "period ended" as of `date` — closes the open period (inclusive last bleeding
// day). Refuses an end before the start, and reports when nothing is open.
export function endPeriodCore(
  profileId: number,
  date: string
): EndPeriodOutcome {
  return writeTx(() => {
    const open = getOpenPeriod(profileId);
    if (!open) return { kind: "none-open" };
    if (date < open.period_start) return { kind: "invalid" };
    updateCycleRow(profileId, open.id, open.period_start, date, open.flow, open.note);
    return { kind: "ended", id: open.id };
  });
}
