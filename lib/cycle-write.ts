// Auth-blind write cores for the menstrual-cycle log (issue #714). profileId-first, never
// imports lib/auth — the Server Action owns the gate + revalidation (#319). The one-tap
// "period started" / "period ended" / "still bleeding" transitions carry the interesting
// logic (dedup, the open-period guard, the plausible-gap guard, the end-after-start check,
// the reopen recency window) and answer from a typed outcome union, so a handler never
// unconditionally confirms; plain create/edit/delete ride the store CRUD.
//
// Every refusal is a REPORT, never a repair: a core that can't do the obvious thing says
// which thing it couldn't do and writes nothing (#1681). The offer conditions the Cycle
// surface renders from are the SAME pure predicates enforced here (lib/cycle-plausibility),
// so a stale page can't produce a write the surface would never have offered.
//
// Each core is ONE writeTx (BEGIN IMMEDIATE, #468): the history read and the write commit
// together, so two quick taps can't mint a second open period. Nested store writeTx calls
// become SAVEPOINTs.

import { writeTx } from "./db";
import type { FlowLevel } from "./cycle";
import {
  canReopenLastPeriodOn,
  canStartPeriodOn,
  lastEndedPeriodIn,
  openPeriodIn,
} from "./cycle-plausibility";
import {
  createCycleRow,
  getOpenPeriod,
  listCyclePeriods,
  updateCycleRow,
} from "./cycle-store";

export type StartPeriodOutcome =
  | { kind: "started"; id: number }
  | { kind: "already-open"; id: number }
  | { kind: "duplicate"; id: number }
  // The last period ended too recently for a new one to be plausible (#1681 bug 2):
  // writing it would mint a back-to-back period and corrupt the start-to-start cycle
  // lengths. The dated form records a genuine exception.
  | { kind: "too-soon"; lastEnd: string };

// One-tap "period started" on `date`. Reports instead of writing when a period is already
// open, when one already starts on this day, or when the last one ended too recently.
export function startPeriodCore(
  profileId: number,
  date: string,
  flow: FlowLevel | null = null
): StartPeriodOutcome {
  return writeTx(() => {
    const periods = listCyclePeriods(profileId);
    const open = openPeriodIn(periods);
    if (open) return { kind: "already-open", id: open.id };
    const sameDay = periods.find((p) => p.period_start === date);
    if (sameDay) return { kind: "duplicate", id: sameDay.id };
    if (!canStartPeriodOn(periods, date)) {
      const last = lastEndedPeriodIn(periods);
      return { kind: "too-soon", lastEnd: last?.period_end ?? date };
    }
    const id = createCycleRow(profileId, date, null, flow, null);
    return { kind: "started", id };
  });
}

export type EndPeriodOutcome =
  { kind: "ended"; id: number } | { kind: "none-open" } | { kind: "invalid" };

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
    updateCycleRow(
      profileId,
      open.id,
      open.period_start,
      date,
      open.flow,
      open.note
    );
    return { kind: "ended", id: open.id };
  });
}

export type ReopenPeriodOutcome =
  | { kind: "reopened"; id: number }
  | { kind: "not-found" }
  // Ended longer ago than REOPEN_PERIOD_MAX_AGE_DAYS — reopening it would silently merge
  // two cycles, so the dated form owns that edit.
  | { kind: "too-old"; lastEnd: string }
  // A period is already open, so there is nothing to reopen (a stale page can reach this).
  | { kind: "already-open"; id: number };

// One-tap "Still bleeding" (issue #1681 bug 3): clears `period_end` on the MOST RECENTLY
// ended period, undoing an early "Period ended" tap. This is the recovery path that makes
// removing the wrong "Period started today" CTA safe — it sits in the same slot.
//
// Deliberately narrow: it refuses when a period is already open, when nothing has ever
// been closed, and when the last end is older than the recency window, so it can never
// resurrect last month's period. It only ever clears the end date — flow, note, and the
// start day are the user's and are left exactly as recorded.
export function reopenPeriodCore(
  profileId: number,
  date: string
): ReopenPeriodOutcome {
  return writeTx(() => {
    const periods = listCyclePeriods(profileId);
    const open = openPeriodIn(periods);
    if (open) return { kind: "already-open", id: open.id };
    const last = lastEndedPeriodIn(periods);
    if (!last) return { kind: "not-found" };
    if (!canReopenLastPeriodOn(periods, date))
      return { kind: "too-old", lastEnd: last.period_end! };
    updateCycleRow(
      profileId,
      last.id,
      last.period_start,
      null,
      last.flow,
      last.note
    );
    return { kind: "reopened", id: last.id };
  });
}
