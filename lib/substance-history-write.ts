// Auth-blind historical correction core for substance consumption (#2009).
// The public row contract is storage-agnostic; dispatch is decided only from the
// catalog substance. Alcohol updates its existing food_log counter and reconciles
// the matching per-tap events, while nicotine/cannabis update substance_log.

import { instantNow } from "./clock";
import { db, today, writeTx } from "./db";
import { isRealIsoDate } from "./date";
import { captureDelete } from "./undo-delete-db";
import {
  ALCOHOL_FOOD_GROUP,
  MAX_SUBSTANCE_ENTRY_AMOUNT,
  isSubstance,
  substanceDef,
  type Substance,
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

function appendAlcoholEvents(
  profileId: number,
  date: string,
  amount: number
): void {
  const loggedAt = instantNow();
  const insert = db.prepare(
    `INSERT INTO food_log_events
       (profile_id, group_key, date, logged_at, meal_slot)
     VALUES (?, ?, ?, ?, NULL)`
  );
  for (let index = 0; index < amount; index += 1) {
    insert.run(profileId, ALCOHOL_FOOD_GROUP, date, loggedAt);
  }
}

function reconcileAlcoholEvents(
  profileId: number,
  fromDate: string,
  toDate: string,
  amount: number
): void {
  if (fromDate !== toDate) {
    db.prepare(
      `UPDATE food_log_events SET date = ?
       WHERE profile_id = ? AND group_key = ? AND date = ?`
    ).run(toDate, profileId, ALCOHOL_FOOD_GROUP, fromDate);
  }
  // Newest tap first. When a correction SHRINKS the day, the taps that survive are
  // the LATEST ones and the earliest are dropped (#2073): a per-tap row carries a
  // `logged_at`, so which rows survive decides what a "last drink at HH:MM" surface
  // reads. Keeping the head of this list keeps the most recent drink instant, which
  // is the datum such a surface is about; slicing the head off instead deleted
  // exactly that row and left the day's timing reading backwards.
  const ids = db
    .prepare(
      `SELECT id FROM food_log_events
       WHERE profile_id = ? AND group_key = ? AND date = ?
       ORDER BY logged_at DESC, id DESC`
    )
    .all(profileId, ALCOHOL_FOOD_GROUP, toDate) as { id: number }[];
  if (ids.length > amount) {
    const remove = db.prepare(
      `DELETE FROM food_log_events WHERE id = ? AND profile_id = ?`
    );
    for (const row of ids.slice(amount)) {
      remove.run(row.id, profileId);
    }
  } else if (ids.length < amount) {
    appendAlcoholEvents(profileId, toDate, amount - ids.length);
  }
}

export function addSubstanceHistoryEntryCore(
  profileId: number,
  substance: string,
  input: { date: string; amount: number; notes?: string | null }
): SubstanceHistoryMutationOutcome {
  if (!isSubstance(substance)) return { kind: "unknown-substance" };
  if (!isRealIsoDate(input.date) || input.date > today(profileId))
    return { kind: "invalid-date" };
  if (!validAmount(input.amount)) return { kind: "invalid-amount" };
  const notes = normalizedNotes(input.notes);

  return writeTx(() => {
    if (substanceDef(substance).ledger === "food-log") {
      const existing = db
        .prepare(
          `SELECT id FROM food_log
           WHERE profile_id = ? AND group_key = ? AND date = ?`
        )
        .get(profileId, ALCOHOL_FOOD_GROUP, input.date);
      if (existing) return { kind: "date-conflict" as const };
      const info = db
        .prepare(
          `INSERT INTO food_log
             (profile_id, date, group_key, servings, notes)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(profileId, input.date, ALCOHOL_FOOD_GROUP, input.amount, notes);
      appendAlcoholEvents(profileId, input.date, input.amount);
      return { kind: "added" as const, id: Number(info.lastInsertRowid) };
    }

    const existing = db
      .prepare(
        `SELECT id FROM substance_log
         WHERE profile_id = ? AND substance = ? AND date = ?`
      )
      .get(profileId, substance, input.date);
    if (existing) return { kind: "date-conflict" as const };
    const info = db
      .prepare(
        `INSERT INTO substance_log
           (profile_id, date, substance, units, logged_at, notes, edited)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run(profileId, input.date, substance, input.amount, instantNow(), notes);
    return { kind: "added" as const, id: Number(info.lastInsertRowid) };
  });
}

export function updateSubstanceHistoryEntryCore(
  profileId: number,
  substance: string,
  id: number,
  input: { date: string; amount: number; notes?: string | null }
): SubstanceHistoryMutationOutcome {
  if (!isSubstance(substance)) return { kind: "unknown-substance" };
  if (!isRealIsoDate(input.date) || input.date > today(profileId))
    return { kind: "invalid-date" };
  if (!validAmount(input.amount)) return { kind: "invalid-amount" };
  const notes = normalizedNotes(input.notes);

  return writeTx(() => {
    if (substanceDef(substance).ledger === "food-log") {
      const row = db
        .prepare(
          `SELECT date FROM food_log
           WHERE id = ? AND profile_id = ? AND group_key = ?`
        )
        .get(id, profileId, ALCOHOL_FOOD_GROUP) as { date: string } | undefined;
      if (!row) return { kind: "not-found" as const };
      const conflict = db
        .prepare(
          `SELECT 1 FROM food_log
           WHERE profile_id = ? AND group_key = ? AND date = ? AND id != ?`
        )
        .get(profileId, ALCOHOL_FOOD_GROUP, input.date, id);
      if (conflict) return { kind: "date-conflict" as const };
      db.prepare(
        `UPDATE food_log SET date = ?, servings = ?, notes = ?
         WHERE id = ? AND profile_id = ? AND group_key = ?`
      ).run(input.date, input.amount, notes, id, profileId, ALCOHOL_FOOD_GROUP);
      reconcileAlcoholEvents(profileId, row.date, input.date, input.amount);
      return { kind: "updated" as const, id };
    }

    const row = db
      .prepare(
        `SELECT 1 FROM substance_log
         WHERE id = ? AND profile_id = ? AND substance = ?`
      )
      .get(id, profileId, substance);
    if (!row) return { kind: "not-found" as const };
    const conflict = db
      .prepare(
        `SELECT 1 FROM substance_log
         WHERE profile_id = ? AND substance = ? AND date = ? AND id != ?`
      )
      .get(profileId, substance, input.date, id);
    if (conflict) return { kind: "date-conflict" as const };
    db.prepare(
      `UPDATE substance_log
       SET date = ?, units = ?, notes = ?, edited = 1
       WHERE id = ? AND profile_id = ? AND substance = ?`
    ).run(input.date, input.amount, notes, id, profileId, substance);
    return { kind: "updated" as const, id };
  });
}

export function deleteSubstanceHistoryEntryCore(
  profileId: number,
  substance: string,
  id: number
): SubstanceHistoryMutationOutcome {
  if (!isSubstance(substance)) return { kind: "unknown-substance" };
  const valid =
    substanceDef(substance).ledger === "food-log"
      ? db
          .prepare(
            `SELECT 1 FROM food_log
             WHERE id = ? AND profile_id = ? AND group_key = ?`
          )
          .get(id, profileId, ALCOHOL_FOOD_GROUP)
      : db
          .prepare(
            `SELECT 1 FROM substance_log
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
