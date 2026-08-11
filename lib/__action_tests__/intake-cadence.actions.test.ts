// SERVER-ACTION TIER — the intake cadence write boundary (#1602), driven through the
// real Server Actions against the throwaway in-memory DB.
//
// What this pins that the pure tier cannot: the FORM ROUND-TRIP. A cadence the user
// enters has to survive parse → store → re-read unchanged, the branch fields have to be
// cleared when the kind changes (so a stale weekday list can never re-narrow a schedule
// later), garbage has to be rejected at the boundary rather than stored, and — the
// invariant that matters most — narrowing an existing dose to certain days must NOT
// disturb its adherence history or its dose id.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addIntakeItem,
  updateIntakeItem,
} from "@/app/(app)/nutrition/intake-actions";
import { seedActor, fd } from "./harness";

vi.mocked(revalidatePath);
beforeEach(() => seedActor());

function lastItemId(): number {
  return Number(
    (
      db.prepare("SELECT MAX(id) AS id FROM intake_items").get() as {
        id: number;
      }
    ).id
  );
}

interface StoredCadence {
  cadence_kind: string;
  cadence_weekdays: string | null;
  cadence_interval_days: number | null;
  cadence_anchor_date: string | null;
}

function cadenceOf(itemId: number): StoredCadence {
  return db
    .prepare(
      `SELECT cadence_kind, cadence_weekdays, cadence_interval_days, cadence_anchor_date
         FROM intake_items WHERE id = ?`
    )
    .get(itemId) as StoredCadence;
}

function dosesOf(itemId: number) {
  return db
    .prepare(
      `SELECT id, amount, weekdays, start_date, end_date, retired, updated_at
         FROM intake_item_doses WHERE item_id = ? ORDER BY sort, id`
    )
    .all(itemId) as {
    id: number;
    amount: string | null;
    weekdays: string | null;
    start_date: string | null;
    end_date: string | null;
    retired: number;
    updated_at: string | null;
  }[];
}

const dose = (extra: Record<string, unknown> = {}) => ({
  amount: "1 tab",
  time_of_day: "Morning",
  food_timing: "any",
  weekdays: [],
  start_date: "",
  end_date: "",
  ...extra,
});

describe("#1602 — the item cadence round-trips through the form", () => {
  it("stores a weekly cadence and reads it back canonically", async () => {
    await addIntakeItem(
      fd({
        name: "Methotrexate",
        kind: "medication",
        cadence_kind: "weekly",
        // Submitted out of order and with a duplicate: normalization is the write
        // boundary's job, so an equivalent re-submission stores identically and a
        // no-op edit never looks like a change.
        cadence_weekdays: "4,1,1",
        doses: JSON.stringify([dose()]),
      })
    );
    expect(cadenceOf(lastItemId())).toMatchObject({
      cadence_kind: "weekly",
      cadence_weekdays: "1,4",
      cadence_interval_days: null,
      cadence_anchor_date: null,
    });
  });

  it("stores an interval cadence with its anchor", async () => {
    await addIntakeItem(
      fd({
        name: "Patch",
        kind: "medication",
        cadence_kind: "interval",
        cadence_interval_days: "3",
        cadence_anchor_date: "2026-03-01",
        doses: JSON.stringify([dose()]),
      })
    );
    expect(cadenceOf(lastItemId())).toMatchObject({
      cadence_kind: "interval",
      cadence_interval_days: 3,
      cadence_anchor_date: "2026-03-01",
      cadence_weekdays: null,
    });
  });

  it("defaults to daily when the form says nothing (every existing surface is unchanged)", async () => {
    await addIntakeItem(
      fd({ name: "Vitamin D", doses: JSON.stringify([dose()]) })
    );
    expect(cadenceOf(lastItemId())).toMatchObject({
      cadence_kind: "daily",
      cadence_weekdays: null,
      cadence_interval_days: null,
      cadence_anchor_date: null,
    });
  });

  it("rejects garbage at the boundary instead of storing it", async () => {
    await addIntakeItem(
      fd({
        name: "Nonsense",
        cadence_kind: "fortnightly", // not a member of the enum
        cadence_weekdays: "9,-1,banana",
        cadence_interval_days: "-4",
        cadence_anchor_date: "not-a-date",
        doses: JSON.stringify([dose()]),
      })
    );
    // Falls back to daily with every branch field null — the row is never left holding
    // a value that looks like a rule but constrains nothing.
    expect(cadenceOf(lastItemId())).toMatchObject({
      cadence_kind: "daily",
      cadence_weekdays: null,
      cadence_interval_days: null,
      cadence_anchor_date: null,
    });
  });

  it("clears the other branch's fields when the kind changes", async () => {
    await addIntakeItem(
      fd({
        name: "Switcher",
        cadence_kind: "weekly",
        cadence_weekdays: "1",
        doses: JSON.stringify([dose()]),
      })
    );
    const id = lastItemId();
    expect(cadenceOf(id).cadence_weekdays).toBe("1");

    // Switch to interval: the stale weekday list must not survive, or it would
    // silently re-narrow the schedule if the kind were ever switched back.
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Switcher",
        cadence_kind: "interval",
        cadence_interval_days: "2",
        cadence_anchor_date: "2026-03-01",
        cadence_weekdays: "1",
        doses: JSON.stringify([dose()]),
      })
    );
    expect(cadenceOf(id)).toMatchObject({
      cadence_kind: "interval",
      cadence_weekdays: null,
      cadence_interval_days: 2,
    });

    // …and back to daily clears everything.
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Switcher",
        cadence_kind: "daily",
        cadence_interval_days: "2",
        doses: JSON.stringify([dose()]),
      })
    );
    expect(cadenceOf(id)).toMatchObject({
      cadence_kind: "daily",
      cadence_weekdays: null,
      cadence_interval_days: null,
      cadence_anchor_date: null,
    });
  });
});

describe("#1602 — per-dose weekdays and windows round-trip", () => {
  it("stores an alternating pair as two rows of one item", async () => {
    await addIntakeItem(
      fd({
        name: "Warfarin",
        kind: "medication",
        doses: JSON.stringify([
          dose({ amount: "5 mg", weekdays: [1, 3, 5] }),
          dose({ amount: "2.5 mg", weekdays: [0, 2, 4, 6] }),
        ]),
      })
    );
    const rows = dosesOf(lastItemId());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount: "5 mg", weekdays: "1,3,5" });
    expect(rows[1]).toMatchObject({ amount: "2.5 mg", weekdays: "0,2,4,6" });
  });

  it("stores a taper as windowed rows and drops an unparseable date", async () => {
    await addIntakeItem(
      fd({
        name: "Prednisone",
        kind: "medication",
        doses: JSON.stringify([
          dose({
            amount: "40 mg",
            start_date: "2026-03-01",
            end_date: "2026-03-07",
          }),
          dose({ amount: "30 mg", start_date: "2026-03-08", end_date: "junk" }),
        ]),
      })
    );
    const rows = dosesOf(lastItemId());
    expect(rows[0]).toMatchObject({
      start_date: "2026-03-01",
      end_date: "2026-03-07",
    });
    expect(rows[1]).toMatchObject({ start_date: "2026-03-08", end_date: null });
  });

  // THE invariant. A schedule edit must never rewrite what already happened.
  it("narrowing an existing dose to certain days keeps its id and its adherence history", async () => {
    await addIntakeItem(
      fd({ name: "Ibandronate", doses: JSON.stringify([dose()]) })
    );
    const id = lastItemId();
    const before = dosesOf(id)[0];

    // Two historical logs against that dose row.
    for (const date of ["2026-02-02", "2026-02-09"]) {
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, status, amount)
         VALUES (?, ?, ?, 'taken', '1 tab')`
      ).run(before.id, id, date);
    }

    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Ibandronate",
        cadence_kind: "weekly",
        cadence_weekdays: "1",
        doses: JSON.stringify([
          { id: before.id, ...dose({ weekdays: [1], end_date: "2026-06-30" }) },
        ]),
      })
    );

    const after = dosesOf(id);
    expect(after).toHaveLength(1);
    // Same ROW — updated in place, so in-flight reminder buttons and every log's
    // dose_id stay valid.
    expect(after[0].id).toBe(before.id);
    expect(after[0]).toMatchObject({ weekdays: "1", end_date: "2026-06-30" });
    expect(after[0].retired).toBe(0);

    // History untouched, and both logs still point at the same row.
    const logs = db
      .prepare(
        `SELECT date, amount FROM intake_item_logs WHERE dose_id = ? ORDER BY date`
      )
      .all(before.id) as { date: string; amount: string }[];
    expect(logs).toEqual([
      { date: "2026-02-02", amount: "1 tab" },
      { date: "2026-02-09", amount: "1 tab" },
    ]);

    // The calendar change deliberately does NOT bump updated_at: a re-time restarts the
    // adherence-pattern window, but changing WHICH DAYS a dose lands on is not a new
    // slot, and resetting the window would erase the history the change is judged by.
    expect(after[0].updated_at).toBe(before.updated_at);
  });

  it("ending a dose's window is not a retire — the row stays live", async () => {
    await addIntakeItem(
      fd({ name: "Taper Row", doses: JSON.stringify([dose()]) })
    );
    const id = lastItemId();
    const rowId = dosesOf(id)[0].id;
    await updateIntakeItem(
      fd({
        id: String(id),
        name: "Taper Row",
        doses: JSON.stringify([
          { id: rowId, ...dose({ end_date: "2026-01-31" }) },
        ]),
      })
    );
    const after = dosesOf(id);
    expect(after).toHaveLength(1);
    expect(after[0].retired).toBe(0);
    expect(after[0].end_date).toBe("2026-01-31");
  });
});
