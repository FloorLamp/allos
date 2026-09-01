// Auth-blind historical correction core for substance consumption (#2009).
// The public row contract is storage-agnostic; dispatch is decided only from the
// catalog substance. Alcohol updates its existing food_daily_totals counter and reconciles
// the matching per-tap events, while nicotine/cannabis update substance_daily_totals.
//
// IT DOES NOT SPELL EITHER WRITE ITSELF (#4435). It used to, and the second spelling
// got four contracts wrong that every other food path holds: the backfill REFUSED a
// day that already had drinks, a re-date left the tap's instant on the day the row
// had left, surplus taps were hard-deleted with no undo capture, and a per-tap row
// was born without provenance. So every alcohol tap now moves through the food
// ledger's own cores — logFoodServingCore inserts and bumps, deleteFoodLogEventCore
// captures and unbumps, updateFoodLogEventCore re-dates and moves the counter with
// it — and the non-food counter moves through the shared day-counter ledger. What is
// left here is what only this domain knows: the catalog dispatch, the day's NOTE, and
// the typed outcomes.
//
// #3279: `substance` is a SubstanceKey — curated OR a profile's own name — and this core
// normalizes it once, at its own boundary, through resolveSubstanceKey(). A custom
// substance needs nothing else here: dispatch already reads substanceDef().ledger rather
// than testing the key against the curated three, and every custom key is
// substance-log-ledgered by construction. That is why history correction (#2009) carries
// a custom substance "like the curated three" with no branch of its own.

import { instantNow } from "./clock";
import type { LoggedVia } from "./logged-via";
import { db, today, writeTx } from "./db";
import { SUBSTANCE_USE_WRITE, isPastWriteAccepted } from "./log-manifest";
import { isRealIsoDate } from "./date";
import { captureDelete } from "./undo-delete-db";
import { substanceDayCounter } from "./day-counter-ledger-db";
import {
  deleteFoodLogEventCore,
  logFoodServingCore,
  updateFoodLogEventCore,
} from "./food-log-write";
import {
  ALCOHOL_FOOD_GROUP,
  MAX_SUBSTANCE_ENTRY_AMOUNT,
  resolveSubstanceKey,
  substanceDef,
} from "./substance-use";

export type SubstanceHistoryMutationOutcome =
  | { kind: "added"; id: number }
  | { kind: "updated"; id: number }
  | { kind: "deleted"; undoId: number }
  | { kind: "not-found" }
  | { kind: "date-conflict" }
  | { kind: "invalid-date" }
  | { kind: "invalid-amount" }
  | { kind: "unknown-substance" };

function validAmount(amount: number): boolean {
  return (
    Number.isInteger(amount) &&
    amount > 0 &&
    amount <= MAX_SUBSTANCE_ENTRY_AMOUNT
  );
}

function normalizedNotes(notes: string | null | undefined): string | null {
  return notes?.trim() || null;
}

// The day's alcohol taps, NEWEST FIRST. When a correction SHRINKS the day the taps
// that survive are the LATEST ones and the earliest are dropped (#2073): a per-tap
// row carries a `recorded_at`, so which rows survive decides what a "last drink at
// HH:MM" surface reads. Keeping the head of this list keeps the most recent drink
// instant, which is the datum such a surface is about.
function alcoholTapIds(profileId: number, date: string): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM food_log_events
       WHERE profile_id = ? AND group_key = ? AND date = ?
       ORDER BY recorded_at DESC, id DESC`
      )
      .all(profileId, ALCOHOL_FOOD_GROUP, date) as { id: number }[]
  ).map((row) => row.id);
}

export function addSubstanceDailyTotalCore(
  profileId: number,
  substanceInput: string,
  input: { date: string; amount: number; notes?: string | null },
  // Which surface filed this entry (#3087). Alcohol rides `food_log_events`, so its
  // per-unit rows carry provenance exactly as a serving tap does.
  loggedVia: LoggedVia
): SubstanceHistoryMutationOutcome {
  const substance = resolveSubstanceKey(substanceInput);
  if (substance === null) return { kind: "unknown-substance" };
  if (!isPastWriteAccepted(today(profileId), input.date))
    return { kind: "invalid-date" };
  if (!validAmount(input.amount)) return { kind: "invalid-amount" };
  const notes = normalizedNotes(input.notes);

  // ADDITIVE, like every other logged fact (#4435). This used to answer
  // `date-conflict` whenever the day already held some, which made "I had a second
  // one" unrecordable through the door that exists to record it — while the one-tap
  // beside it composed happily. `validAmount` keeps `amount` at 1 or more, so each
  // branch below leaves exactly one day row for the caller to name.
  return writeTx(() => {
    if (substanceDef(substance).ledger === "food-log") {
      for (let index = 0; index < input.amount; index += 1)
        logFoodServingCore(
          profileId,
          ALCOHOL_FOOD_GROUP,
          input.date,
          loggedVia
        );
      return {
        kind: "added" as const,
        id: alcoholDayRow(profileId, input.date, notes),
      };
    }

    substanceDayCounter.bump(profileId, input.date, [substance], input.amount, [
      instantNow(),
    ]);
    // A note ARRIVES WITH the entry rather than replacing the day's: an add says
    // something about the units it brought, and the correction door below is where a
    // day's note is restated or cleared. `logged_via` follows the same COALESCE for a
    // different reason — provenance names the surface that OPENED the row (#3087).
    const day = db
      .prepare(
        `UPDATE substance_daily_totals
           SET notes = COALESCE(?, notes), edited = 1,
               logged_via = COALESCE(logged_via, ?)
         WHERE profile_id = ? AND date = ? AND substance = ?
         RETURNING id`
      )
      .get(notes, loggedVia, profileId, input.date, substance) as {
      id: number;
    };
    return { kind: "added" as const, id: day.id };
  });
}

// The alcohol day row after a write, with the day's note folded in. The bumps above
// always leave it, so this reads a row that exists rather than probing for one.
function alcoholDayRow(
  profileId: number,
  date: string,
  notes: string | null
): number {
  return (
    db
      .prepare(
        `UPDATE food_daily_totals SET notes = COALESCE(?, notes)
         WHERE profile_id = ? AND date = ? AND group_key = ?
         RETURNING id`
      )
      .get(notes, profileId, date, ALCOHOL_FOOD_GROUP) as { id: number }
  ).id;
}
// #4614: each core declares its own domain; `LOG_MANIFEST`'s cores column derives.
export const addSubstanceDailyTotalCoreDeclares = SUBSTANCE_USE_WRITE;

export function updateSubstanceDailyTotalCore(
  profileId: number,
  substanceInput: string,
  id: number,
  input: { date: string; amount: number; notes?: string | null },
  // A correction that GROWS the day appends per-unit `food_log_events` rows that did
  // not exist before, and a row created here is created here — so the surface making
  // the correction is required, and stamps only the rows it actually creates. The rows
  // that survive the reconcile keep the provenance they were born with.
  loggedVia: LoggedVia
): SubstanceHistoryMutationOutcome {
  const substance = resolveSubstanceKey(substanceInput);
  if (substance === null) return { kind: "unknown-substance" };
  if (!isRealIsoDate(input.date) || input.date > today(profileId))
    return { kind: "invalid-date" };
  if (!validAmount(input.amount)) return { kind: "invalid-amount" };
  const notes = normalizedNotes(input.notes);

  return writeTx(() => {
    if (substanceDef(substance).ledger === "food-log") {
      const row = db
        .prepare(
          `SELECT date FROM food_daily_totals
           WHERE id = ? AND profile_id = ? AND group_key = ?`
        )
        .get(id, profileId, ALCOHOL_FOOD_GROUP) as { date: string } | undefined;
      if (!row) return { kind: "not-found" as const };
      const conflict = db
        .prepare(
          `SELECT 1 FROM food_daily_totals
           WHERE profile_id = ? AND group_key = ? AND date = ? AND id != ?`
        )
        .get(profileId, ALCOHOL_FOOD_GROUP, input.date, id);
      if (conflict) return { kind: "date-conflict" as const };
      const taps = alcoholTapIds(profileId, row.date);
      // THE DAY ROW MOVES WHOLE — it is the entry's identity and carries the note —
      // but its COUNT is re-based on the taps, because every reconcile below is a
      // shared-ledger write that moves the counter itself. A same-day correction
      // starts from the taps it already has; a day that MOVES starts from zero,
      // because each surviving tap re-bumps the counter as it is re-dated. A
      // pre-ledger row holding ticks no tap ever backed is repaired by the same line:
      // the correction states what the day held, and the taps are what it held.
      db.prepare(
        `UPDATE food_daily_totals SET date = ?, servings = ?, notes = ?
         WHERE id = ? AND profile_id = ? AND group_key = ?`
      ).run(
        input.date,
        row.date === input.date ? taps.length : 0,
        notes,
        id,
        profileId,
        ALCOHOL_FOOD_GROUP
      );
      // Surplus taps leave through the row-delete core, so shrinking a day is
      // UNDOABLE (#2642). Hard-deleting them made this the app's one unrecoverable
      // food removal, and a mis-typed amount took the evening with it.
      for (const tapId of taps.slice(input.amount))
        deleteFoodLogEventCore(profileId, tapId);
      if (row.date !== input.date) {
        // A re-date moves the tap's DAY, so an `occurred_at` from the old day would
        // be exactly the cross-day pair `judgeEatenAt` refuses to write anywhere
        // else. Nobody restated an hour for the new day, so the honest value is
        // none: the instant and its source are cleared WITH the move rather than
        // left pointing at a day the row is no longer on.
        for (const tapId of taps.slice(0, input.amount))
          updateFoodLogEventCore(profileId, tapId, {
            date: input.date,
            eatenAt: null,
          });
      }
      // A correction that GROWS the day appends through the log core, so a row
      // created here carries the provenance a one-tap drink carries.
      for (let index = taps.length; index < input.amount; index += 1)
        logFoodServingCore(
          profileId,
          ALCOHOL_FOOD_GROUP,
          input.date,
          loggedVia
        );
      return { kind: "updated" as const, id };
    }

    const row = db
      .prepare(
        `SELECT 1 FROM substance_daily_totals
         WHERE id = ? AND profile_id = ? AND substance = ?`
      )
      .get(id, profileId, substance);
    if (!row) return { kind: "not-found" as const };
    const conflict = db
      .prepare(
        `SELECT 1 FROM substance_daily_totals
         WHERE profile_id = ? AND substance = ? AND date = ? AND id != ?`
      )
      .get(profileId, substance, input.date, id);
    if (conflict) return { kind: "date-conflict" as const };
    db.prepare(
      `UPDATE substance_daily_totals
       SET date = ?, units = ?, notes = ?, edited = 1
       WHERE id = ? AND profile_id = ? AND substance = ?`
    ).run(input.date, input.amount, notes, id, profileId, substance);
    return { kind: "updated" as const, id };
  });
}

export function deleteSubstanceDailyTotalCore(
  profileId: number,
  substanceInput: string,
  id: number
): SubstanceHistoryMutationOutcome {
  const substance = resolveSubstanceKey(substanceInput);
  if (substance === null) return { kind: "unknown-substance" };
  const valid =
    substanceDef(substance).ledger === "food-log"
      ? db
          .prepare(
            `SELECT 1 FROM food_daily_totals
             WHERE id = ? AND profile_id = ? AND group_key = ?`
          )
          .get(id, profileId, ALCOHOL_FOOD_GROUP)
      : db
          .prepare(
            `SELECT 1 FROM substance_daily_totals
             WHERE id = ? AND profile_id = ? AND substance = ?`
          )
          .get(id, profileId, substance);
  if (!valid) return { kind: "not-found" };
  const undoId = captureDelete(
    substanceDef(substance).ledger === "food-log"
      ? "substance-alcohol-history"
      : "substance-history",
    profileId,
    id
  );
  return undoId == null ? { kind: "not-found" } : { kind: "deleted", undoId };
}
