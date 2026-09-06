// Auth-blind historical ADD core for substance consumption (#2009).
// The public row contract is storage-agnostic; dispatch is decided only from the
// catalog substance. Alcohol rides food_daily_totals, nicotine/cannabis ride
// substance_daily_totals — and this file SPELLS NEITHER WRITE ITSELF (#4435). It used
// to, and the second spelling got four contracts wrong that every other food path
// holds: the backfill refused a day that already had drinks, a re-date left the tap's
// instant on the day the row had left, surplus taps were hard-deleted with no undo
// capture, and a per-tap row was born without provenance. Alcohol taps now move
// through the food ledger's own cores and the non-food counter through the shared
// day-counter ledger; what is left here is the catalog dispatch and the typed
// outcomes. The entry's NOTE rides its first tap (#5304): a note is an event's fact.
//
// #3279: `substance` is a SubstanceKey — curated OR a profile's own name — and this core
// normalizes it once, at its own boundary, through resolveSubstanceKey(). A custom
// substance needs nothing else here: dispatch already reads substanceDef().ledger rather
// than testing the key against the curated three, and every custom key is
// substance-log-ledgered by construction. That is why history correction (#2009) carries
// a custom substance "like the curated three" with no branch of its own.

import type { LoggedVia } from "./logged-via";
import { db, today, writeTx } from "./db";
import { SUBSTANCE_USE_WRITE, isPastWriteAccepted } from "./log-manifest";
import { captureDelete } from "./undo-delete-db";
import { logFoodServingCore, normalizedNote } from "./food-log-write";
import type { FoodPlacement } from "./food-log-write";
import { logSubstanceUnitCore } from "./substance-log-write";
import {
  ALCOHOL_FOOD_GROUP,
  MAX_SUBSTANCE_ENTRY_AMOUNT,
  resolveSubstanceKey,
  substanceDef,
  type SubstanceKey,
} from "./substance-use";

export type SubstanceHistoryMutationOutcome =
  | { kind: "added"; id: number }
  | { kind: "deleted"; undoId: number }
  | { kind: "not-found" }
  | { kind: "invalid-date" }
  | { kind: "invalid-amount" }
  | { kind: "unknown-substance" };

/**
 * What an ADD can answer: the shared union minus the arm only a delete mints. The two
 * cores share a vocabulary, not a range, and the difference is load-bearing at the form
 * — its refusal copy is keyed on this union (#5380), so an arm no writer can produce
 * would have to be given a sentence nobody could ever read.
 */
export type SubstanceHistoryAddOutcome = Exclude<
  SubstanceHistoryMutationOutcome,
  { kind: "deleted" }
>;

function validAmount(amount: number): boolean {
  return (
    Number.isInteger(amount) &&
    amount > 0 &&
    amount <= MAX_SUBSTANCE_ENTRY_AMOUNT
  );
}

// One tap per unit, through each ledger's own log core — so a use filed here is the
// same row the one-tap button writes: counter bumped, event appended, provenance
// stamped, and no use instant invented for a day nobody stated one for. The dispatch is
// the substance's ledger and nothing else; NEITHER arm spells a write of its own
// (#4435), which is what keeps the four contracts the second spelling used to get wrong
// out of this file for good.
//
// A STATED MINUTE RIDES ON EVERY UNIT OF THE ENTRY (#3295 phase 1, widened to every
// substance by #5026 phase 2). The form collects one time for one submission — "two
// cigarettes at nine" — so each tap the submission creates carries that same statement,
// as `occurred_at` with `time_source = 'stated'`. `statedAt` null is the third answer
// and the commonest: nobody said, and the row keeps a NULL instant rather than
// inheriting the tap stamp.
//
// THE NOTE RIDES THE FIRST TAP ONLY (#5304). One submission's note describes the
// sitting, not each cigarette in it, so copying it onto every event would make the
// record repeat one sentence N times — the migration's "once, never duplicated across
// the day's uses" clause, applied at the door that creates the uses.
function appendUnitTaps(
  profileId: number,
  substance: SubstanceKey,
  date: string,
  count: number,
  loggedVia: LoggedVia,
  statedAt: string | null,
  notes: string | null
): void {
  const onFoodLedger = substanceDef(substance).ledger === "food-log";
  const placement: FoodPlacement | undefined = statedAt
    ? { eatenAt: statedAt, source: "stated" }
    : undefined;
  for (let index = 0; index < count; index += 1) {
    const note = index === 0 ? notes : null;
    if (onFoodLedger)
      logFoodServingCore(
        profileId,
        ALCOHOL_FOOD_GROUP,
        date,
        loggedVia,
        undefined,
        placement,
        undefined,
        note
      );
    else
      logSubstanceUnitCore(
        profileId,
        substance,
        date,
        loggedVia,
        undefined,
        statedAt,
        note
      );
  }
}

export function addSubstanceDailyTotalCore(
  profileId: number,
  substanceInput: string,
  input: {
    date: string;
    amount: number;
    notes?: string | null;
    // THE STATED USE INSTANT (#3295 phase 1; every substance since #5026 phase 2),
    // already gated by the caller (an instant on `date`, not in the future —
    // `judgeStatedAt`). Both ledgers now have a column to hold one, so there is no
    // longer a substance whose stated minute has to be dropped at this boundary.
    statedAt?: string | null;
  },
  // Which surface filed this entry (#3087). Every substance's per-unit rows carry
  // provenance exactly as a serving tap does.
  loggedVia: LoggedVia
): SubstanceHistoryAddOutcome {
  const substance = resolveSubstanceKey(substanceInput);
  if (substance === null) return { kind: "unknown-substance" };
  if (!isPastWriteAccepted(today(profileId), input.date))
    return { kind: "invalid-date" };
  if (!validAmount(input.amount)) return { kind: "invalid-amount" };

  // ADDITIVE, like every other logged fact (#4435): this used to answer
  // `date-conflict` for a day that already held some, which made "I had a second one"
  // unrecordable through the door that exists to record it. `validAmount` keeps
  // `amount` at 1 or more, so the taps always leave one day row to read back.
  return writeTx(() => {
    appendUnitTaps(
      profileId,
      substance,
      input.date,
      input.amount,
      loggedVia,
      input.statedAt ?? null,
      normalizedNote(input.notes)
    );
    const day = (
      substanceDef(substance).ledger === "food-log"
        ? db
            .prepare(
              `SELECT id FROM food_daily_totals
                WHERE profile_id = ? AND date = ? AND group_key = ?`
            )
            .get(profileId, input.date, ALCOHOL_FOOD_GROUP)
        : db
            .prepare(
              `SELECT id FROM substance_daily_totals
                WHERE profile_id = ? AND date = ? AND substance = ?`
            )
            .get(profileId, input.date, substance)
    ) as { id: number };
    return { kind: "added" as const, id: day.id };
  });
}

// #4614: each core declares its own domain; `LOG_MANIFEST`'s cores column derives.
export const addSubstanceDailyTotalCoreDeclares = SUBSTANCE_USE_WRITE;

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
