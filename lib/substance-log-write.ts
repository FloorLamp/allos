// Auth-blind write core for the non-food substance ledger (issue #1078) — the
// food-log-write pattern re-instantiated for `substance_daily_totals` (nicotine/cannabis;
// alcohol stays on food_daily_totals). Takes profileId first and never imports lib/auth
// (#319): the Server Actions in app/(app)/medical/substance-use/actions.ts are the
// only callers today, and any future surface (a Telegram button, a widget) reuses
// this same computation. The auth gate stays entirely in the action.
//
// A USE IS AN EVENT (#5026 phase 2, the owner's 2026-09-04 ruling). Every write here
// now moves TWO things in one transaction, exactly as a food serving does: the day
// counter, and one `substance_log_events` row per use carrying `occurred_at` +
// `time_source`. The counter is still the cap's substrate and the card's count; the
// event is the thing that happened, and the record reads the events.
//
// `substance` is validated against the substance catalog (only 'substance-log'-ledger
// substances land here) so a forged/stale key writes nothing and is answered honestly
// by the caller.
//
// The counter arithmetic itself — additive upsert, guarded clamped decrement,
// drop-at-zero, authoritative re-select — is the shared day-counter ledger since #2037
// (lib/day-counter-ledger.ts). This file no longer re-instantiates it; it owns the
// catalog validation, the typed outcomes, the event ledger the counter rides with, and
// the #468 transaction the ledger runs in.
// NEVER GAMIFIED (#998/#1078 law): these writes never touch `activities`, so the
// milestone/streak machinery stays structurally blind to the domain.

import { db, today, writeTx } from "./db";
import { SUBSTANCE_USE_WRITE, isPastWriteAccepted } from "./log-manifest";
import { instantNow, now as clockNow } from "./clock";
import { isRealIsoDate, utcInstant } from "./date";
import { getTimezone } from "./settings";
import { judgeStatedAt, type StatedTimeRefusal } from "./stated-time";
import type { LoggedVia } from "./logged-via";
import { substanceDayCounter } from "./day-counter-ledger-db";
import { captureDelete } from "./undo-delete-db";
import { isSubstanceLogged, type SubstanceKey } from "./substance-use";

// The typed result of a unit write (the markDoseTaken contract, #232): the caller
// answers from what ACTUALLY happened, never unconditionally confirms.
//   logged            — a use was recorded; `units` is the substance's new daily total.
//   unknown-substance — not a substance_daily_totals-ledger substance, or a key that is
//                       not in canonical stored form; nothing written. The caller
//                       normalizes at the request boundary (resolveSubstanceKey).
export type SubstanceLogOutcome =
  | {
      kind: "logged";
      units: number;
      substance: SubstanceKey;
      // Exact identity of the event row this use appended, so a caller that has to
      // name the use it just created addresses the event rather than the day it
      // landed on.
      eventId: number;
    }
  | { kind: "unknown-substance" }
  // A day that is not a real past day (#4425) — the shared invariant's refusal,
  // spelled the way the history core next door spells it.
  | { kind: "invalid-date" };

// The typed result of an undo: a use was removed and `units` is the REMAINING
// daily total (0 once the row is dropped). Undo is idempotent — undoing a day
// with nothing logged is a no-op that reports 0.
export type SubstanceUndoOutcome =
  | { kind: "undone"; units: number; substance: SubstanceKey }
  | { kind: "unknown-substance" };

// Correcting ONE recorded use (#5026 phase 2) — the `updateFoodLogEventCore` outcome
// set, minus the arms this ledger has no shape for (no group to be unknown, no protein
// nudge key to refuse). `invalid-stated-at` carries the gate's own REASON so the
// surface can name which rule fired rather than saying a bare no (#2296).
export type SubstanceEventEditOutcome =
  | { kind: "updated"; eventId: number; date: string }
  | { kind: "not-found" }
  | { kind: "invalid-date" }
  | { kind: "invalid-stated-at"; reason: StatedTimeRefusal }
  // THE MOVE WOULD EMPTY A DAY WHOSE ROW CARRIES A NOTE, so it is refused and nothing
  // is written. The day counter is dropped at zero and the note lives only on it, so
  // moving a noted day's LAST use would delete a sentence somebody typed, through a
  // door that captures no undo and says nothing about notes. Refusing is `main`'s own
  // posture (its day form answers `date-conflict` and both notes survive); it stops
  // being reachable when #5304 moves the note onto the use.
  | { kind: "day-note-stranded" };

// Log one use of a substance on a day. Upserts the day's row, incrementing its
// units, appends the event, and returns the resulting daily total. Single IMMEDIATE
// transaction (#468) so the upsert + the event insert + the count read see one
// consistent state under a concurrent tap. `loggedAt` records the tap instant
// (injectable for tests; production always passes the default) and is a CANONICAL
// stored instant (#2205) — the shape its history sibling already writes into the same
// column.
export function logSubstanceUnitCore(
  profileId: number,
  substance: string,
  date: string,
  // WHICH SURFACE THIS USE WAS LOGGED FROM (#4435), on the #3087 convention the food
  // core next door already follows: required, no default, and before the optional
  // tail so a new call site cannot inherit a bucket by omission. The day row keeps
  // the LAST tap's surface beside that tap's `recorded_at`.
  loggedVia: LoggedVia,
  loggedAt: string = instantNow(),
  // WHEN THE PERSON SAYS THE USE HAPPENED, or null for the commonest answer: nobody
  // said. Already gated by the caller (`judgeStatedAt`). A tap NEVER fills this in —
  // the web button carries no "I'm using it now" contract any more than the food bar's
  // "+" does (#2019/#2053), so an unstated use keeps a NULL instant and draws no chart
  // tick. That is why the parameter is `string | null` rather than an instant/source
  // pair: the only value this ledger can be handed is a STATED one, and the type says
  // so, which is what keeps `time_source = 'tap'` unreachable from the app while the
  // column keeps the same closed vocabulary as `food_log_events.time_source`.
  statedAt: string | null = null
): SubstanceLogOutcome {
  if (!isSubstanceLogged(substance)) return { kind: "unknown-substance" };
  // THE SHARED DATE INVARIANT (#4425). This core re-checked NOTHING about its day: it
  // took whatever its action resolved, which is `today(profileId)` on the one-tap path
  // and would have been anything at all on a future dated one. Its history sibling
  // `addSubstanceDailyTotalCore` has always carried the rule.
  if (!isPastWriteAccepted(today(profileId), date))
    return { kind: "invalid-date" };
  return writeTx(() => {
    const units = substanceDayCounter.bump(profileId, date, [substance], 1, [
      loggedAt,
    ]);
    // Append the per-use event in the SAME transaction (#950's food rule, applied
    // here): the counter and its ledger see one consistent state, so a reader can
    // never observe a bumped count with no matching event or the reverse.
    const inserted = db
      .prepare(
        `INSERT INTO substance_log_events
           (profile_id, substance, date, recorded_at, occurred_at, time_source,
            logged_via)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        substance,
        date,
        loggedAt,
        statedAt,
        statedAt === null ? null : "stated",
        loggedVia
      );
    // CREATION, NOT MUTATION (#3087, #4435). A day total is upserted, so this is the
    // `symptom_logs` case: `recorded_at` moves to the LATEST tap because the day's
    // last use is a fact about the day, while provenance names the surface that
    // OPENED the row and is never rewritten. COALESCE is the whole rule. The EVENT
    // above carries this tap's own surface, which is where per-use provenance lives
    // now; the day row keeps naming the surface that opened it.
    db.prepare(
      `UPDATE substance_daily_totals SET logged_via = COALESCE(logged_via, ?)
       WHERE profile_id = ? AND date = ? AND substance = ?`
    ).run(loggedVia, profileId, date, substance);
    return {
      kind: "logged",
      units,
      substance,
      eventId: Number(inserted.lastInsertRowid),
    };
  });
}
// #4614: each core declares its own domain; `LOG_MANIFEST`'s cores column derives.
export const logSubstanceUnitCoreDeclares = SUBSTANCE_USE_WRITE;

// Undo one use of a substance on a day: decrement the day's row and drop it when it
// would hit zero, so a fully-undone day leaves no stray row (the undoFoodServingCore
// shape), and retire the EVENT that use appended. Single IMMEDIATE transaction (#468).
//
// THE NEWEST EVENT IS THE ONE THAT GOES, which is the plain minus control's own
// contract on the food side: undo is the inverse of the tap that just happened, so it
// removes the use that tap created rather than asking which. A use somebody wants to
// pick out is deleted on its own record row.
export function undoSubstanceUnitCore(
  profileId: number,
  substance: string,
  date: string
): SubstanceUndoOutcome {
  if (!isSubstanceLogged(substance)) return { kind: "unknown-substance" };
  return writeTx(() => {
    const units = substanceDayCounter.unbump(profileId, date, [substance], 1);
    db.prepare(
      `DELETE FROM substance_log_events
        WHERE profile_id = ? AND id = (
          SELECT id FROM substance_log_events
           WHERE profile_id = ? AND date = ? AND substance = ?
           ORDER BY recorded_at DESC, id DESC LIMIT 1
        )`
    ).run(profileId, profileId, date, substance);
    return { kind: "undone", units, substance };
  });
}
export const undoSubstanceUnitCoreDeclares = SUBSTANCE_USE_WRITE;

// CORRECT ONE RECORDED USE (#5026 phase 2) — re-time it, re-file it onto another day,
// or both. `updateFoodLogEventCore` re-instantiated for this ledger, deliberately down
// to the same three-state patch convention, because "correct one consumable event" is
// one question and the drink already answers it this way:
//
//   • an ABSENT field leaves the row's value alone;
//   • `statedAt: null` clears the instant back to "nobody said";
//   • a Date states it, and lands as `occurred_at` + `time_source = 'stated'`.
//
// The stated instant is judged against the FINAL date, so a correction that moves the
// day and names an hour is checked against the day the row will actually sit on. A
// refusal writes NOTHING and carries its reason: this is the correction posture, where
// the statement IS the submission, and not the log path's "keep the row, drop the
// minute".
export function correctSubstanceEventCore(
  profileId: number,
  eventId: number,
  patch: { date?: string; statedAt?: Date | null }
): SubstanceEventEditOutcome {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT substance, date, recorded_at, occurred_at, time_source
           FROM substance_log_events
          WHERE id = ? AND profile_id = ?`
      )
      .get(eventId, profileId) as
      | {
          substance: string;
          date: string;
          recorded_at: string;
          occurred_at: string | null;
          time_source: string | null;
        }
      | undefined;
    if (!row) return { kind: "not-found" as const };

    const nextDate = patch.date ?? row.date;
    // THE REQUESTED DAY IS BOUNDED, NOT THE FINAL ONE (#4463's rule, in the food core's
    // own words): `nextDate` falls back to the stored date, so bounding that would make
    // a row already dated ahead — a restored capture, a legacy import — uncorrectable
    // in every direction including back into range.
    if (
      !isRealIsoDate(nextDate) ||
      (patch.date !== undefined && patch.date > today(profileId))
    )
      return { kind: "invalid-date" as const };

    if (patch.statedAt != null) {
      const verdict = judgeStatedAt(
        patch.statedAt,
        getTimezone(profileId),
        nextDate,
        clockNow()
      );
      if (verdict.kind !== "accepted")
        return { kind: "invalid-stated-at" as const, reason: verdict.reason };
    }
    const nextStatedAt =
      patch.statedAt === undefined
        ? row.occurred_at
        : patch.statedAt === null
          ? null
          : utcInstant(patch.statedAt);
    const nextTimeSource =
      patch.statedAt === undefined
        ? row.time_source
        : patch.statedAt === null
          ? null
          : "stated";

    if (nextDate !== row.date) {
      // The move is one unbump plus one bump on the shared ledger, so the drop-at-zero
      // on the vacated day and the create-on-first on the arriving one are the same two
      // rules every other use obeys. A time-only correction moves neither coordinate
      // and therefore performs neither. The bump carries the event's OWN tap instant as
      // the arriving day's `recorded_at` touch: that column is the day's last-tap stamp
      // and this use is the tap that just arrived there.
      //
      // A MOVE THAT WOULD STRAND THE DAY'S NOTE IS REFUSED (review of #5290, round 2).
      // One read, before anything is written: the vacated day's own row. If this use is
      // its last (`units <= 1`) and it carries a note, the `unbump` below would drop the
      // row and take the note with it. An earlier round tried to CARRY the note to the
      // arriving day; that destroyed it whenever the arriving day already had one, and
      // patching the carry a second time is what this refusal replaces. `main` refuses
      // the same move for the same reason, so this is not a capability lost here.
      const vacated = db
        .prepare(
          `SELECT units, notes FROM substance_daily_totals
            WHERE profile_id = ? AND date = ? AND substance = ?`
        )
        .get(profileId, row.date, row.substance) as
        { units: number; notes: string | null } | undefined;
      if (vacated != null && vacated.notes != null && vacated.units <= 1)
        return { kind: "day-note-stranded" as const };
      substanceDayCounter.unbump(profileId, row.date, [row.substance], 1);
      substanceDayCounter.bump(profileId, nextDate, [row.substance], 1, [
        row.recorded_at,
      ]);
    }
    db.prepare(
      `UPDATE substance_log_events
          SET date = ?, occurred_at = ?, time_source = ?
        WHERE id = ? AND profile_id = ?`
    ).run(nextDate, nextStatedAt, nextTimeSource, eventId, profileId);
    return { kind: "updated" as const, eventId, date: nextDate };
  });
}

// DELETE ONE RECORDED USE (#5026 phase 2) — the `food-serving` delete's shape on this
// ledger. Rooted on the EVENT, so removing one cigarette of three leaves the other two
// standing and gives the day counter its tick back; `captureDelete` owns both halves
// through the `substance-use` kind's CounterSpec, which is what makes the Undo restore
// the row AND the count. The day-level delete next door (`deleteSubstanceDailyTotalCore`)
// is the other operation and removes them all — two subjects, two doors (#5026 item 1's
// ruling 2).
//
// ONE AUTHORITY, AND NO PRE-READ (review of #5290). This carried an existence
// `SELECT 1 … WHERE id = ? AND profile_id = ?` outside any transaction, which made it
// the only core in this file not wrapped in `writeTx`. The fix is not to wrap it: the
// read did no work `captureDelete` does not already do, since that function opens its
// own `writeTx` and its FIRST statement is the identical `WHERE id = ? AND profile_id =
// ?`, answering null for a row that is absent OR another profile's — which is the
// `not-found` returned below. So the profile boundary and the existence check are one
// statement in one transaction now, rather than two that hid each other.
//
// THAT IS WHY IT DIVERGES FROM `deleteFoodLogEventCore`, which keeps its pre-read and
// its `writeTx`: that read is load-bearing. It takes five columns the capture then
// destroys, drives a second refusal (`isProteinNudgeKey`) and derives the `vacated`
// placement its outcome carries. This ledger has no group to refuse and no window to
// vacate, so the same shape here would be ceremony around a duplicate predicate.
export function deleteSubstanceEventCore(
  profileId: number,
  eventId: number
): { kind: "deleted"; undoId: number } | { kind: "not-found" } {
  const undoId = captureDelete("substance-use", profileId, eventId);
  return undoId == null ? { kind: "not-found" } : { kind: "deleted", undoId };
}
