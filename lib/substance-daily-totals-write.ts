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
import { logFoodServingCore } from "./food-log-write";
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
  | { kind: "unknown-substance" }
  // A CONSUMABLE IS AN EVENT (owner ruling, 2026-09-04), so a substance whose units
  // ARE events is corrected on the event and never on the day that rolls them up.
  | { kind: "corrected-per-event" };

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

// THE DAY-COUNT CORRECTION, AND IT IS FOR DAY COUNTS ONLY (#5026 item 1).
//
// A CONSUMABLE IS AN EVENT (owner ruling, 2026-09-04): a drink, like a serving and
// like a dose, is a thing that happened at an instant, and the day total is a ROLLUP
// rather than the editable thing. Alcohol's units already ARE events —
// `food_log_events` rows carrying `occurred_at` and `time_source` — so this core
// REFUSES it, and the drink is corrected on its own record row through the food
// serving's own form (#5025 phase 1). Nicotine, cannabis and every custom key still
// ride `substance_daily_totals`, which is UNIQUE per (profile, date, substance) and
// structurally timeless: for them the day count IS the stored fact and this is its
// correction. Phase 2's event ledger moves them to the same door.
//
// WHAT THE REFUSAL BUYS, MEASURED on this core before it was removed: two drinks
// stated at 21:00 and 23:00, corrected to the next day through this form, came out of
// it with `occurred_at` and `time_source` NULL on BOTH — one day-count correction
// silently levelled two clocks that a person had typed, and with them both ticks on
// the day chart. Shrinking the same day from 2 to 1 deleted the 21:00 drink and kept
// the 23:00 one, because the reconcile drops the earliest-filed taps: which drink
// died was decided by filing order rather than by the person. Both are the flattening
// the ruling names, and neither can happen through a form that corrects one event.
export function updateSubstanceDailyTotalCore(
  profileId: number,
  substanceInput: string,
  id: number,
  input: { date: string; amount: number; notes?: string | null }
): SubstanceHistoryMutationOutcome {
  const substance = resolveSubstanceKey(substanceInput);
  if (substance === null) return { kind: "unknown-substance" };
  if (substanceDef(substance).ledger === "food-log")
    return { kind: "corrected-per-event" };
  if (!isRealIsoDate(input.date) || input.date > today(profileId))
    return { kind: "invalid-date" };
  if (!validAmount(input.amount)) return { kind: "invalid-amount" };
  const notes = normalizedNotes(input.notes);

  return writeTx(() => {
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
