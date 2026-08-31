// SELECTION EDIT OVER THE DAY LEDGER (#4118).
//
// The ledger states a day as one list of food servings and supplement doses. When a day
// was reconstructed late — the reported case: 65 of 325 food events in 60 days logged on
// a later day than they happened — the repair is the same repair for every row on it, and
// making it one row at a time through the ⋯ menu is the cost the owner reported.
//
// SO THIS IS A BATCH, NOT A NEW WRITE PATH. Every row still moves through the correction
// core its own domain already owns — `updateFoodLogEventCore` for a serving,
// `updateHistoricalDose` for a taken dose, and the two deletes — so the course rules, the
// scheduled-uniqueness rule, the PRN proximity dedup, the day-counter arithmetic, the
// supply re-credit, the escalation suppression and the undo capture are all exactly what
// a single-row correction gets. There is no bulk UPDATE here and there is deliberately no
// second set of rules: a batch that could write something a single correction could not
// would be a hole wearing a convenience's clothes.
//
// AND THE NAMED IDS ARE AN UPPER BOUND, never an instruction. `resolveDayDoses`' contract
// (#3936), applied to corrections: the caller names rows it saw, this module re-derives
// what the day ACTUALLY holds for that profile, and only the intersection is written. A
// row deleted in another tab, a row that was never on this day, and a forged id belonging
// to another profile are all the same answer — absent from the day's set, so nothing is
// written for it and it is named in `refused`.
//
// WHAT IS NOT SELECTABLE, and why it is not a drop:
//   • SKIPPED doses. Both cores that could act on one scope themselves to `status =
//     'taken'` (`updateHistoricalDose`'s SELECT, `deleteAdministrationLog`'s), because a
//     skip is resolved by re-answering it, not by amending an administration that never
//     happened. Today's skip is cleared on its own row by the tri-state control.
//   • The reserved `__protein__` ranking event, which the food cores already refuse:
//     its truth is the grams total, not a serving.
//   • Still-DUE doses, which have no row to correct yet.

import { db, today } from "./db";
import { now as clockNow } from "./clock";
import { daysBetweenDateStr, isRealIsoDate } from "./date";
import { getTimezone } from "./settings";
import { reanchorStatedAt, statedInstantOnDate } from "./stated-time";
import { isProteinNudgeKey } from "./protein-nudge";
import {
  deleteFoodLogEventCore,
  updateFoodLogEventCore,
} from "./food-log-write";
import {
  deleteAdministrationLog,
  updateHistoricalDose,
} from "./queries/intake/adherence";
import { historicalDoseErrorMessage } from "./historical-dose-error";
import { LEDGER_DAY_SPAN } from "./day-ledger";

/** What a batch does to every row in it. One verb, one batch. */
export type LedgerSelectionEdit =
  /** Stamp one profile-local wall time on every selected row, on the day it sits on. */
  | { kind: "set-time"; hhmm: string }
  /** Re-date every selected row onto `date`, keeping each row's own wall clock. */
  | { kind: "move-day"; date: string }
  /** Remove every selected row through its domain's undoable delete. */
  | { kind: "delete" };

/** The rows a caller named, by the identity each ledger row already renders. */
export interface LedgerSelection {
  /** `food_log_events.id` — a `serving` row. */
  servings: readonly number[];
  /** `intake_item_logs.id` — a taken `dose` row, including one inside a stack. */
  doses: readonly number[];
}

/** One row that did not move, with the reason its own core gave. */
export interface LedgerSelectionRefusal {
  /** `serving:<id>` / `dose:<id>` — the ledger row id, so a surface can point at it. */
  row: string;
  reason: string;
}

export type LedgerSelectionOutcome =
  | {
      kind: "applied";
      /** Rows the correction cores actually wrote. */
      applied: number;
      refused: LedgerSelectionRefusal[];
      /**
       * `intake_items.id` for every dose row amended or removed — what the action
       * boundary writes its audit rows against (#1933: retroactively rewriting what the
       * record says was given is audited, however many rows at a time).
       */
      auditedItemIds: number[];
    }
  /** The batch's own input is unusable: nothing was read and nothing was written. */
  | { kind: "invalid-edit" }
  /** Not one named row is on this day for this profile. */
  | { kind: "nothing-selected" };

const ROW_GONE = "No longer on this day.";
const TIME_UNAVAILABLE = "That time does not exist on this day.";

// The day a selected row may be moved TO, checked here rather than at the surface. The
// ledger's own day picker offers today plus the previous six days (LEDGER_DAY_SPAN) and
// that markup was the only bound: a hand-built POST could re-date a serving into the next
// century, where it would sit in every rollup for ever. The deep doors keep reaching
// further back — `/history`'s food door and `logHistoricalDose` are the honest path for a
// year-old row — so this bounds the LEDGER's batch, not the record.
function movableTo(profileId: number, date: string): boolean {
  if (!isRealIsoDate(date)) return false;
  const back = daysBetweenDateStr(today(profileId), date);
  return back != null && back <= 0 && back > -LEDGER_DAY_SPAN;
}

interface SelectableServing {
  id: number;
  date: string;
  occurredAt: string | null;
}
interface SelectableDose {
  id: number;
  itemId: number;
  date: string;
  occurredAt: string | null;
}

/**
 * What `date` actually holds for `profileId`, restricted to the rows a batch may act on.
 *
 * This is the re-derivation the batch is bounded by. Ownership is asserted here AND
 * again inside every core it calls (their statements are all id + profile_id scoped), so
 * a foreign id is refused twice over — but the DAY is asserted only here, and that half
 * is load-bearing on its own: without it a named id from another day would be re-timed or
 * re-dated by a batch whose whole premise is "these rows are the ones I am looking at".
 * `intake_item_logs` carries ownership through its parent item, which is why the dose
 * half joins.
 */
function selectableOn(
  profileId: number,
  date: string
): { servings: SelectableServing[]; doses: SelectableDose[] } {
  const servings = (
    db
      .prepare(
        `SELECT id, date, group_key AS groupKey, occurred_at AS occurredAt
           FROM food_log_events
          WHERE profile_id = ? AND date = ?`
      )
      .all(profileId, date) as (SelectableServing & { groupKey: string })[]
  ).filter((row) => !isProteinNudgeKey(row.groupKey));
  const doses = db
    .prepare(
      `SELECT l.id AS id, l.item_id AS itemId, l.date AS date,
              l.occurred_at AS occurredAt
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.date = ? AND l.status = 'taken'
          AND s.kind != 'medication'`
    )
    .all(profileId, date) as SelectableDose[];
  return { servings, doses };
}

/**
 * Apply one edit to every named row of `date` that this profile actually owns.
 *
 * Auth-blind and profileId-first, like every other write core here: the action boundary
 * owns the gate, this owns the rules. NOT one transaction — each row goes through its own
 * core, which runs its own IMMEDIATE transaction, exactly as `resolveDayDoses` resolves
 * each dose in its own. A batch of corrections is a batch of corrections, not an atomic
 * one: a refusal on the third row must not undo the two that were legitimately repaired,
 * and the outcome names every row that did not move so the surface can say which.
 */
export function editDayLedgerSelectionCore(
  profileId: number,
  date: string,
  selection: LedgerSelection,
  edit: LedgerSelectionEdit
): LedgerSelectionOutcome {
  if (!isRealIsoDate(date) || date > today(profileId))
    return { kind: "invalid-edit" };
  const tz = getTimezone(profileId);

  // Every bound the batch itself owns, settled BEFORE a row is read — an edit that
  // cannot be expressed must write nothing at all, not the prefix of a batch.
  let stamped: Date | null = null;
  if (edit.kind === "set-time") {
    // Built FROM the day, so the pair rule (`judgeStatedAt`) holds by construction and a
    // DST-nonexistent wall time is refused rather than silently settled onto another
    // clock reading. Whether it is in the FUTURE is still each core's question, asked
    // against the server clock — a batch may not skip a gate a single row passes.
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(edit.hhmm))
      return { kind: "invalid-edit" };
    stamped = statedInstantOnDate(date, edit.hhmm, tz);
    if (!stamped) return { kind: "invalid-edit" };
  }
  if (edit.kind === "move-day" && !movableTo(profileId, edit.date))
    return { kind: "invalid-edit" };

  const day = selectableOn(profileId, date);
  const servings = day.servings.filter((row) =>
    selection.servings.includes(row.id)
  );
  const doses = day.doses.filter((row) => selection.doses.includes(row.id));
  if (servings.length === 0 && doses.length === 0)
    return { kind: "nothing-selected" };

  const refused: LedgerSelectionRefusal[] = [];
  const auditedItemIds: number[] = [];
  let applied = 0;
  const now = clockNow();

  // A NAMED ID THAT IS NOT ON THE DAY IS REPORTED, not dropped. The intersection above is
  // the write check, and it answers the same way to a row deleted in another tab, a
  // skipped dose, a `__protein__` event and a forged id belonging to another profile —
  // so the batch has to SAY that some of what was asked for went nowhere. A silent
  // narrowing would let "12 selected" answer "updated 9" with nothing to explain the
  // three, which is the shape a cross-profile forgery would hide behind.
  for (const id of selection.servings)
    if (!servings.some((row) => row.id === id))
      refused.push({ row: `serving:${id}`, reason: ROW_GONE });
  for (const id of selection.doses)
    if (!doses.some((row) => row.id === id))
      refused.push({ row: `dose:${id}`, reason: ROW_GONE });

  for (const row of servings) {
    const outcome = editServing(profileId, row, edit, stamped, tz, now);
    if (outcome === null) applied += 1;
    else refused.push({ row: `serving:${row.id}`, reason: outcome });
  }
  for (const row of doses) {
    const outcome = editDose(profileId, row, edit, stamped, tz, now);
    if (outcome === null) {
      applied += 1;
      if (!auditedItemIds.includes(row.itemId)) auditedItemIds.push(row.itemId);
    } else refused.push({ row: `dose:${row.id}`, reason: outcome });
  }
  return { kind: "applied", applied, refused, auditedItemIds };
}

/** Null when the row moved; otherwise the reason it did not. */
function editServing(
  profileId: number,
  row: SelectableServing,
  edit: LedgerSelectionEdit,
  stamped: Date | null,
  tz: string,
  now: Date
): string | null {
  if (edit.kind === "delete") {
    const outcome = deleteFoodLogEventCore(profileId, row.id);
    return outcome.kind === "deleted" ? null : ROW_GONE;
  }
  const patch: { date?: string; eatenAt?: Date | null } = {};
  if (edit.kind === "set-time") patch.eatenAt = stamped;
  else {
    patch.date = edit.date;
    // A MOVE CARRIES THE ROW'S OWN CLOCK WITH IT, and it has to: the core validates a
    // stated instant against the FINAL date, so leaving yesterday's 08:12 on a row moved
    // to today is exactly the self-contradicting pair `judgeEatenAt` exists to refuse.
    // Re-anchored to the same wall time on the target day; a row nobody timed stays
    // untimed (an omitted patch field is not a change, and a move never invents a
    // minute). When the wall time cannot exist there — a DST gap, or an afternoon
    // statement moved onto a morning today — the answer is null and this row is REFUSED
    // rather than silently stripped of the minute somebody stated.
    if (row.occurredAt !== null) {
      const moved = reanchorStatedAt(row.occurredAt, edit.date, tz, now);
      if (moved === null) return TIME_UNAVAILABLE;
      patch.eatenAt = new Date(moved);
    }
  }
  const outcome = updateFoodLogEventCore(profileId, row.id, patch);
  switch (outcome.kind) {
    case "updated":
      return null;
    case "invalid-eaten-at":
      return outcome.reason === "future"
        ? "That time has not happened yet."
        : TIME_UNAVAILABLE;
    case "invalid-date":
      return "Not a real date.";
    default:
      return ROW_GONE;
  }
}

/** Null when the row moved; otherwise the reason it did not. */
function editDose(
  profileId: number,
  row: SelectableDose,
  edit: LedgerSelectionEdit,
  stamped: Date | null,
  tz: string,
  now: Date
): string | null {
  if (edit.kind === "delete") {
    return deleteAdministrationLog(profileId, row.id) ? null : ROW_GONE;
  }
  // `updateHistoricalDose` is THE amend core (#2228 decision 6) and takes the pair
  // explicitly: the day the row files under and the instant it states. Set-time keeps the
  // row's own day; move-day re-anchors the instant onto the target day for the same
  // reason the serving does, and a dose nobody timed amends by date alone — which the
  // core still validates (`isHistoricalDoseDateAccepted`) rather than skipping.
  let target = row.date;
  let occurredAt: Date | null = null;
  if (edit.kind === "set-time") {
    occurredAt = stamped;
  } else {
    target = edit.date;
    if (row.occurredAt !== null) {
      const moved = reanchorStatedAt(row.occurredAt, edit.date, tz, now);
      if (moved === null) return TIME_UNAVAILABLE;
      occurredAt = new Date(moved);
    }
  }
  const outcome = updateHistoricalDose(
    profileId,
    row.itemId,
    row.id,
    target,
    occurredAt,
    null
  );
  return outcome.kind === "logged" ? null : historicalDoseErrorMessage(outcome);
}
