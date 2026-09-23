// Write cores for the menstrual-cycle log (issue #714). profileId-first, and the id must be
// the one a write gate returned: the parameter is lib/auth's WriteAuthorizedProfileId, which
// only the gates mint, so an action that never gated has no value to pass (#5348). The
// import is type-only — erased at build, so the core still runs auth-blind and the Server
// Action still owns the gate + revalidation (#319), and a branded number is still a number,
// so the reads take one unchanged.
//
// What the brand buys is stated narrowly on purpose. `tsc` refuses a plain number at a call
// site — the ordinary accident — and eslint.config.mjs's WRITE_BRAND_CAST refuses production
// code the `as WriteAuthorizedProfileId` forge, across every production module (#5852,
// #5864); a test tier is deliberately left free to cast, the same allowance RPE_BRAND_CAST
// makes. Those are the accidents it catches; it does not make the brand unforgeable, and the
// residual is not a list anyone has closed (#5892, #5914). So "calls a branded core" is
// EVIDENCE of a gate, not PROOF of one — lib/__tests__/actions-write-access.test.ts's
// step-aside rests on that reading.
//
// The one-tap "period started" / "period ended" / "still bleeding" transitions carry the
// interesting logic (dedup, the open-period guard, the plausible-gap guard, the
// end-after-start check, the reopen recency window) and answer from a typed outcome union,
// so a handler never unconditionally confirms; plain create/edit/delete ride the store CRUD.
//
// Every refusal is a REPORT, never a repair: a core that can't do the obvious thing says
// which thing it couldn't do and writes nothing (#1681). The offer conditions the Cycle
// surface renders from are the SAME pure predicates enforced here (lib/cycle-plausibility),
// so a stale page can't produce a write the surface would never have offered.
//
// Each core is ONE writeTx (BEGIN IMMEDIATE, #468): the history read and the write commit
// together, so two quick taps can't mint a second open period. Nested store writeTx calls
// become SAVEPOINTs.

import type { WriteAuthorizedProfileId } from "./auth";
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
  profileId: WriteAuthorizedProfileId,
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
  profileId: WriteAuthorizedProfileId,
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

export type UndoEndPeriodOutcome =
  | { kind: "reopened" }
  | { kind: "changed" }
  // Past the reopen window: the same rule as "Still bleeding", so a replayed Undo
  // cannot reopen a period days later.
  | { kind: "expired" };

// The Undo on the "Period ended" toast (#5663 ruling 1). An end writes only
// `period_end` on the open row, so clearing it is the complete inverse, but only while
// the world is as that tap left it: the row is still this profile's last end, on the
// same day, and nothing has opened since. Anything else is `changed`, and nothing is
// written (lib/undo-offer.ts: an inverse re-derives, it never trusts the client). And
// only within the reopen window `reopenPeriodCore` keeps, as of `date`.
export function undoEndPeriodCore(
  profileId: WriteAuthorizedProfileId,
  id: number,
  end: string,
  date: string
): UndoEndPeriodOutcome {
  return writeTx(() => {
    const periods = listCyclePeriods(profileId);
    const last = lastEndedPeriodIn(periods);
    if (openPeriodIn(periods) || last?.id !== id || last.period_end !== end)
      return { kind: "changed" };
    if (!canReopenLastPeriodOn(periods, date)) return { kind: "expired" };
    updateCycleRow(
      profileId,
      last.id,
      last.period_start,
      null,
      last.flow,
      last.note
    );
    return { kind: "reopened" };
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
  profileId: WriteAuthorizedProfileId,
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
