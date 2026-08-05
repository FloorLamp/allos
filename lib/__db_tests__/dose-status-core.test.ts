// DB INTEGRATION TIER — the ONE intake_item_logs resolution core (issue #2039).
//
// Until #2039 two independent write cores resolved a dose against `intake_item_logs`:
// `markDoseTaken`/`markDoseSkipped` in lib/queries/intake/adherence.ts (insert-only,
// typed, the #232 contract) and a tri-state twin (`applyDoseStatus`) living inside
// app/(app)/nutrition/supplement-actions.ts with its own DELETE/INSERT/UPDATE and its
// own supply crossings. This file pins the unification:
//
//   1. THE ROWS AND OUTCOMES BOTH FORMER PATHS PRODUCED, produced by the one core:
//      the tri-state's taken→skipped→clear→taken walk with its supply deltas, and the
//      one-way resolvers' insert-only, never-overwrite, report-the-actual-status
//      behaviour — asserted side by side against the same seeded dose.
//   2. THE DIVERGENCE IS GONE: the twin never checked the parent item's `active` flag,
//      so a PAUSED item — which markDoseTaken has always refused — was silently
//      writable (and its supply burnable) through the web tri-state. Both intents now
//      answer "inactive" and write nothing.
//   3. THE SUPPLY COUPLING reads the ledger row's own `supply_adjusted`, so clearing a
//      deliberately unadjusted historical row (#1933) cannot hand back units it never
//      took — the payoff of one core owning both the ledger and its counter crossing.
//
// The db singleton is redirected at a per-file temp DB by setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  markDoseTaken,
  markDoseSkipped,
  setDoseStatusCore,
} from "@/lib/queries";

let seq = 0;

function seedProfileRow(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`Tri P${++seq}`)
      .lastInsertRowid
  );
}

function seedItem(
  profileId: number,
  opts: { active?: number; quantityOnHand?: number | null } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, ?, 'supplement', 'daily', 'should', ?, 1)`
      )
      .run(
        profileId,
        `Item ${++seq}`,
        opts.active ?? 1,
        opts.quantityOnHand ?? null
      ).lastInsertRowid
  );
}

function seedDose(itemId: number, amount: string, retired = 0): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, retired)
         VALUES (?, ?, 'morning', 'any', 0, ?)`
      )
      .run(itemId, amount, retired).lastInsertRowid
  );
}

function logRows(doseId: number, date: string) {
  return db
    .prepare(
      `SELECT amount, status, given_at, supply_adjusted
         FROM intake_item_logs WHERE dose_id = ? AND date = ? ORDER BY id`
    )
    .all(doseId, date) as {
    amount: string | null;
    status: string;
    given_at: string | null;
    supply_adjusted: number;
  }[];
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

// Seed one tracked daily supplement with one dose, on the app's real today: the core
// bounds the date to a small window around today (#614), so a fixed calendar literal
// would drift out of that window as wall-clock time moves.
function seedTracked(opts: { active?: number; qty?: number | null } = {}) {
  const profileId = seedProfileRow();
  const itemId = seedItem(profileId, {
    active: opts.active ?? 1,
    quantityOnHand: opts.qty === undefined ? 10 : opts.qty,
  });
  const doseId = seedDose(itemId, "2 caps");
  return { profileId, itemId, doseId, date: today(profileId) };
}

describe("the tri-state walks through the lib core (#2039)", () => {
  it("clear→taken→skipped→clear→taken produces one row and the same supply deltas", () => {
    const { profileId, itemId, doseId, date } = seedTracked();

    // clear → taken: one row, the amount snapshotted, supply consumed once.
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe("logged");
    expect(logRows(doseId, date)).toEqual([
      {
        amount: "2 caps",
        status: "taken",
        given_at: expect.any(String),
        supply_adjusted: 1,
      },
    ]);
    expect(onHand(itemId)).toBe(9);

    // taken → skipped: the SAME row flips, the amount is dropped (nothing was
    // consumed) and the decrement is given back.
    expect(setDoseStatusCore(profileId, doseId, date, "skipped")).toBe(
      "skipped"
    );
    const skipped = logRows(doseId, date);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].status).toBe("skipped");
    expect(skipped[0].amount).toBeNull();
    expect(onHand(itemId)).toBe(10);

    // skipped → clear: the row goes, supply is untouched (a skip never moved it).
    expect(setDoseStatusCore(profileId, doseId, date, "clear")).toBe("cleared");
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);

    // clear → taken again: consumed once more, never double-counted.
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe("logged");
    expect(onHand(itemId)).toBe(9);

    // taken → clear: the log is removed and the decrement returned.
    expect(setDoseStatusCore(profileId, doseId, date, "clear")).toBe("cleared");
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);
  });

  it("answers 'unchanged' for a target the dose already stands at, writing nothing", () => {
    const { profileId, itemId, doseId, date } = seedTracked();
    expect(setDoseStatusCore(profileId, doseId, date, "clear")).toBe(
      "unchanged"
    );
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe("logged");
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe(
      "unchanged"
    );
    // One row, one decrement — an idempotent repeat must not re-consume supply.
    expect(logRows(doseId, date)).toHaveLength(1);
    expect(onHand(itemId)).toBe(9);
  });

  it("refuses a retired dose and another profile's dose", () => {
    const { profileId, doseId, date, itemId } = seedTracked();
    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      doseId
    );
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe(
      "stale-dose"
    );
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);

    const other = seedTracked();
    expect(
      setDoseStatusCore(profileId, other.doseId, other.date, "taken")
    ).toBe("stale-dose");
    expect(logRows(other.doseId, other.date)).toEqual([]);
  });
});

describe("the paused-item divergence is gone (#2039)", () => {
  it("the tri-state now refuses a paused item, exactly as markDoseTaken always has", () => {
    const { profileId, itemId, doseId, date } = seedTracked({ active: 0 });

    // The twin in the Server Action module never read `active`, so this wrote a taken
    // row and burned a unit of supply for an item the user had deliberately paused.
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe(
      "inactive"
    );
    expect(setDoseStatusCore(profileId, doseId, date, "skipped")).toBe(
      "inactive"
    );
    expect(setDoseStatusCore(profileId, doseId, date, "clear")).toBe(
      "inactive"
    );
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);

    // The one-way resolvers answer identically — one core, one refusal.
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("inactive");
    expect(markDoseSkipped(profileId, doseId, null, date)).toBe("inactive");
    expect(logRows(doseId, date)).toEqual([]);
  });
});

describe("the one-way resolvers keep the #232/#280 contract through the core", () => {
  it("markDoseTaken inserts once, snapshots the amount and reports already-taken after", () => {
    const { profileId, itemId, doseId, date } = seedTracked();
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("logged");
    expect(markDoseTaken(profileId, doseId, null, date)).toBe("already-taken");
    const rows = logRows(doseId, date);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("2 caps");
    // The repeat tap consumed nothing.
    expect(onHand(itemId)).toBe(9);
  });

  it("a one-way tap NEVER overwrites the other action's log, and never moves supply", () => {
    const { profileId, itemId, doseId, date } = seedTracked();
    expect(markDoseSkipped(profileId, doseId, null, date)).toBe("skipped");
    // ✅ on a dose meanwhile marked skipped: the skip stands and is reported.
    expect(markDoseTaken(profileId, doseId, null, date)).toBe(
      "already-skipped"
    );
    expect(logRows(doseId, date)[0].status).toBe("skipped");
    expect(onHand(itemId)).toBe(10);

    // The explicit web set is the ONLY path that may flip it — that is the whole
    // difference between the two intents over the one core.
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe("logged");
    expect(logRows(doseId, date)[0].status).toBe("taken");
    expect(onHand(itemId)).toBe(9);
  });

  it("refuses a callback token whose item id contradicts the dose's own", () => {
    const { profileId, doseId, date, itemId } = seedTracked();
    expect(markDoseTaken(profileId, doseId, itemId + 999, date)).toBe(
      "stale-dose"
    );
    expect(logRows(doseId, date)).toEqual([]);
    // The dose's OWN item id is accepted.
    expect(markDoseTaken(profileId, doseId, itemId, date)).toBe("logged");
  });
});

describe("supply crossings read the ledger row's own supply_adjusted (#2039)", () => {
  it("clearing a deliberately unadjusted row gives back nothing", () => {
    const { profileId, itemId, doseId, date } = seedTracked();
    // A historical backfill (#1933) may record a dose WITHOUT moving supply — the
    // units were taken from a bottle nobody was counting. Clearing it must not invent
    // units the ledger never removed.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, supply_adjusted)
       VALUES (?,?,?,?, 'taken', 0)`
    ).run(doseId, itemId, date, "2 caps");

    expect(setDoseStatusCore(profileId, doseId, date, "clear")).toBe("cleared");
    expect(logRows(doseId, date)).toEqual([]);
    expect(onHand(itemId)).toBe(10);
  });

  it("flipping an unadjusted taken row to skipped gives back nothing either", () => {
    const { profileId, itemId, doseId, date } = seedTracked();
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, supply_adjusted)
       VALUES (?,?,?,?, 'taken', 0)`
    ).run(doseId, itemId, date, "2 caps");

    expect(setDoseStatusCore(profileId, doseId, date, "skipped")).toBe(
      "skipped"
    );
    expect(onHand(itemId)).toBe(10);
    // …and flipping it back to taken consumes once and records that it did, so the
    // NEXT clear is symmetric again.
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe("logged");
    expect(onHand(itemId)).toBe(9);
    expect(logRows(doseId, date)[0].supply_adjusted).toBe(1);
    expect(setDoseStatusCore(profileId, doseId, date, "clear")).toBe("cleared");
    expect(onHand(itemId)).toBe(10);
  });

  it("an untracked item (no on-hand count) resolves normally and stays untracked", () => {
    const { profileId, itemId, doseId, date } = seedTracked({ qty: null });
    expect(setDoseStatusCore(profileId, doseId, date, "taken")).toBe("logged");
    expect(onHand(itemId)).toBeNull();
    expect(setDoseStatusCore(profileId, doseId, date, "clear")).toBe("cleared");
    expect(onHand(itemId)).toBeNull();
  });
});
