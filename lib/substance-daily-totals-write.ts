// Auth-blind historical correction core for substance consumption (#2009).
// The public row contract is storage-agnostic; dispatch is decided only from the
// catalog substance. Alcohol rides food_daily_totals, nicotine/cannabis ride
// substance_daily_totals — and this file SPELLS NEITHER WRITE ITSELF (#4435). It used
// to, and the second spelling got four contracts wrong that every other food path
// holds: the backfill refused a day that already had drinks, a re-date left the tap's
// instant on the day the row had left, surplus taps were hard-deleted with no undo
// capture, and a per-tap row was born without provenance. Alcohol taps now move
// through the food ledger's own cores and the non-food counter through the shared
// day-counter ledger; what is left here is the catalog dispatch, the day's NOTE and
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
import type { FoodPlacement } from "./food-log-write";
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

// The day's alcohol taps, NEWEST FIRST. A correction that SHRINKS the day keeps the
// head of this list and drops the tail (#2073): each tap carries its own
// `recorded_at`, so which rows survive is what a "last drink at HH:MM" surface reads.
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

// One tap per unit, through the food ledger's own log core — so a drink filed here is
// the same row a drink tapped on the bar is: counter bumped, event appended,
// provenance stamped, and no eating instant invented for a day nobody stated one for.
//
// A STATED MINUTE RIDES ON EVERY UNIT OF THE ENTRY (#3295 phase 1). The form collects
// one time for one submission — "two drinks at nine" — so each tap the submission
// creates carries that same statement, as `occurred_at` with `time_source = 'stated'`.
// `statedAt` null is the third answer and the commonest: nobody said, and the placement
// is omitted so the row keeps a NULL instant rather than inheriting the tap stamp.
function appendAlcoholTaps(
  profileId: number,
  date: string,
  count: number,
  loggedVia: LoggedVia,
  statedAt: string | null = null
): void {
  const placement: FoodPlacement | undefined = statedAt
    ? { eatenAt: statedAt, source: "stated" }
    : undefined;
  for (let index = 0; index < count; index += 1)
    logFoodServingCore(
      profileId,
      ALCOHOL_FOOD_GROUP,
      date,
      loggedVia,
      undefined,
      placement
    );
}

export function addSubstanceDailyTotalCore(
  profileId: number,
  substanceInput: string,
  input: {
    date: string;
    amount: number;
    notes?: string | null;
    // THE STATED DRINKING INSTANT (#3295 phase 1), already gated by the caller (an
    // instant on `date`, not in the future — `judgeStatedAt`). Read by the food-log
    // arm only, because it is the only substance ledger with a column to hold one:
    // `substance_daily_totals` is UNIQUE per (profile, date, substance) and has no
    // instant to state, so the surface offers no time there and nothing is dropped.
    statedAt?: string | null;
  },
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

  // ADDITIVE, like every other logged fact (#4435): this used to answer
  // `date-conflict` for a day that already held some, which made "I had a second one"
  // unrecordable through the door that exists to record it. `validAmount` keeps
  // `amount` at 1 or more, so each branch leaves one day row to read back. A note
  // ARRIVES WITH the entry rather than replacing the day's — the correction door below
  // is where a day's note is restated or cleared.
  return writeTx(() => {
    if (substanceDef(substance).ledger === "food-log") {
      appendAlcoholTaps(
        profileId,
        input.date,
        input.amount,
        loggedVia,
        input.statedAt ?? null
      );
      const day = db
        .prepare(
          `UPDATE food_daily_totals SET notes = COALESCE(?, notes)
           WHERE profile_id = ? AND date = ? AND group_key = ?
           RETURNING id`
        )
        .get(notes, profileId, input.date, ALCOHOL_FOOD_GROUP) as {
        id: number;
      };
      return { kind: "added" as const, id: day.id };
    }

    substanceDayCounter.bump(profileId, input.date, [substance], input.amount, [
      instantNow(),
    ]);
    // `logged_via` takes the same COALESCE for its own reason: provenance names the
    // surface that OPENED the row and is never rewritten (#3087).
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
      // starts from the taps it still has; one that MOVES starts from zero, because
      // each surviving tap re-bumps the counter as it is re-dated. A pre-ledger row
      // holding ticks no tap ever backed is repaired by the same line.
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
      // Surplus taps leave through the row-delete core, so shrinking a day is UNDOABLE
      // (#2642). Hard-deleting them made this the app's one unrecoverable food removal.
      for (const tapId of taps.slice(input.amount))
        deleteFoodLogEventCore(profileId, tapId);
      if (row.date !== input.date) {
        // A re-date moves the tap's DAY, so an `occurred_at` from the old day is
        // exactly the cross-day pair `judgeEatenAt` refuses to write anywhere else.
        // Nobody restated an hour for the new day, so the honest value is none: the
        // instant is cleared WITH the move rather than left on the day the row left.
        for (const tapId of taps.slice(0, input.amount))
          updateFoodLogEventCore(profileId, tapId, {
            date: input.date,
            eatenAt: null,
          });
      }
      appendAlcoholTaps(
        profileId,
        input.date,
        input.amount - taps.length,
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
