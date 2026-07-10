// DB INTEGRATION TIER — dose-edit lifecycle vs adherence history.
//
// Exercises the invariants that keep a supplement/medication EDIT from
// corrupting its adherence history and lets stale Telegram taps be answered
// honestly:
//
//   • markDoseTaken returns a DoseTakenOutcome (logged / already-logged /
//     stale-dose / inactive) instead of silently no-oping, refuses retired
//     doses and paused items, and snapshots the dose amount onto the log.
//   • getSupplementDoses (the "current schedule" read every page/reminder
//     consumer goes through) excludes retired doses.
//   • The amount snapshot keeps history stable across a later dosage edit.
//   • The offline confirm (confirmDoseTaken) mirrors the same rules.
//
// The db singleton is redirected at a per-file temp DB by setup.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  markDoseTaken,
  markDoseSkipped,
} from "@/lib/queries";
import { confirmDoseTaken, skipDose } from "@/lib/offline/writes";

let seq = 0;

function seedProfileRow(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`Dose P${++seq}`)
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
           (profile_id, name, active, kind, condition, priority, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, ?, 'supplement', 'daily', 'high', ?, 1)`
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

function logRow(doseId: number, date: string) {
  return db
    .prepare(
      "SELECT amount, status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
    )
    .get(doseId, date) as { amount: string | null; status: string } | undefined;
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

const DATE = "2026-07-09";

describe("markDoseTaken outcomes", () => {
  it("logs with an amount snapshot, decrements supply, and dedups the repeat", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("logged");
    expect(logRow(doseId, DATE)?.amount).toBe("500 mg");
    expect(onHand(itemId)).toBe(9);

    // Idempotent repeat: reported as already-logged, supply untouched.
    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe(
      "already-logged"
    );
    expect(onHand(itemId)).toBe(9);
  });

  it("refuses a retired dose as stale (nothing logged, no supply burn)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg", 1);

    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("stale-dose");
    expect(logRow(doseId, DATE)).toBeUndefined();
    expect(onHand(itemId)).toBe(10);
  });

  it("refuses a deleted / cross-profile dose as stale", () => {
    const profileId = seedProfileRow();
    expect(markDoseTaken(profileId, 999_999, null, DATE)).toBe("stale-dose");

    // Another profile's dose id is indistinguishable from a deleted one.
    const other = seedProfileRow();
    const foreignDose = seedDose(seedItem(other), "5 mg");
    expect(markDoseTaken(profileId, foreignDose, null, DATE)).toBe(
      "stale-dose"
    );
    expect(logRow(foreignDose, DATE)).toBeUndefined();
  });

  it("refuses a paused item's dose as inactive", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { active: 0, quantityOnHand: 5 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("inactive");
    expect(logRow(doseId, DATE)).toBeUndefined();
    expect(onHand(itemId)).toBe(5);
  });

  it("keeps the logged amount frozen across a later dosage edit", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "500 mg");
    markDoseTaken(profileId, doseId, itemId, DATE);

    // Brand switch: the dose row's amount changes after the confirmation.
    db.prepare(
      "UPDATE intake_item_doses SET amount = '1000 mg' WHERE id = ?"
    ).run(doseId);

    expect(logRow(doseId, DATE)?.amount).toBe("500 mg");
  });
});

describe("retired doses and the current-schedule read", () => {
  it("getSupplementDoses excludes retired doses but keeps live ones", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const live = seedDose(itemId, "1000 mg");
    seedDose(itemId, "500 mg", 1);

    const ids = getSupplementDoses(profileId).map((d) => d.id);
    expect(ids).toEqual([live]);
  });

  it("a retired dose's history rows survive (no cascade)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "500 mg");
    markDoseTaken(profileId, doseId, itemId, DATE);

    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      doseId
    );
    expect(logRow(doseId, DATE)?.amount).toBe("500 mg");
  });
});

describe("markDoseSkipped outcomes (#232)", () => {
  it("writes a skipped log with NULL amount and leaves supply untouched", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseSkipped(profileId, doseId, itemId, DATE)).toBe("skipped");
    const row = logRow(doseId, DATE);
    expect(row?.status).toBe("skipped");
    expect(row?.amount).toBeNull();
    // A skip consumes nothing — on-hand supply stays at 10.
    expect(onHand(itemId)).toBe(10);
    // A skipped dose is not "taken" but IS "skipped" for the resolved views.
    expect(getTakenDoseIds(profileId, DATE).has(doseId)).toBe(false);
    expect(getSkippedDoseIds(profileId, DATE).has(doseId)).toBe(true);
  });

  it("is idempotent and never overwrites an already-resolved dose", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    // First skip logs; a repeat is already-logged.
    expect(markDoseSkipped(profileId, doseId, itemId, DATE)).toBe("skipped");
    expect(markDoseSkipped(profileId, doseId, itemId, DATE)).toBe(
      "already-logged"
    );

    // A stale ⏭ tap must NOT flip an already-TAKEN dose to skipped: taken first…
    const doseB = seedDose(itemId, "250 mg");
    expect(markDoseTaken(profileId, doseB, itemId, DATE)).toBe("logged");
    expect(onHand(itemId)).toBe(9);
    // …then a skip tap is refused as already-logged; the taken row and the supply
    // decrement both stand.
    expect(markDoseSkipped(profileId, doseB, itemId, DATE)).toBe(
      "already-logged"
    );
    expect(logRow(doseB, DATE)?.status).toBe("taken");
    expect(onHand(itemId)).toBe(9);
  });

  it("refuses a retired dose (stale) and a paused item (inactive)", () => {
    const profileId = seedProfileRow();
    const retiredItem = seedItem(profileId, { quantityOnHand: 5 });
    const retired = seedDose(retiredItem, "500 mg", 1);
    expect(markDoseSkipped(profileId, retired, retiredItem, DATE)).toBe(
      "stale-dose"
    );

    const pausedItem = seedItem(profileId, { active: 0, quantityOnHand: 5 });
    const pausedDose = seedDose(pausedItem, "500 mg");
    expect(markDoseSkipped(profileId, pausedDose, pausedItem, DATE)).toBe(
      "inactive"
    );
    expect(logRow(pausedDose, DATE)).toBeUndefined();
  });
});

describe("offline confirmDoseTaken parity", () => {
  it("snapshots the amount and permanently rejects a retired dose", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "2 caps");

    expect(confirmDoseTaken(profileId, doseId, DATE)).toEqual({
      ok: true,
      inserted: true,
    });
    expect(logRow(doseId, DATE)?.amount).toBe("2 caps");

    const retiredDose = seedDose(itemId, "1 cap", 1);
    expect(confirmDoseTaken(profileId, retiredDose, DATE)).toEqual({
      ok: false,
      inserted: false,
    });
    expect(logRow(retiredDose, DATE)).toBeUndefined();
  });
});

describe("offline skipDose parity (#232)", () => {
  it("writes a skipped log, leaves supply untouched, and is idempotent", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 8 });
    const doseId = seedDose(itemId, "500 mg");

    expect(skipDose(profileId, doseId, DATE)).toEqual({
      ok: true,
      inserted: true,
    });
    expect(logRow(doseId, DATE)?.status).toBe("skipped");
    expect(logRow(doseId, DATE)?.amount).toBeNull();
    expect(onHand(itemId)).toBe(8); // no decrement

    // Replaying the same skip is a no-op (inserted:false) — the natural-key guard.
    expect(skipDose(profileId, doseId, DATE)).toEqual({
      ok: true,
      inserted: false,
    });
  });

  it("never overwrites an already-taken dose and rejects a retired dose", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 8 });
    const doseId = seedDose(itemId, "500 mg");

    // Taken first: a replayed skip must leave it taken (inserted:false, no supply
    // change beyond the original decrement).
    confirmDoseTaken(profileId, doseId, DATE);
    expect(onHand(itemId)).toBe(7);
    expect(skipDose(profileId, doseId, DATE)).toEqual({
      ok: true,
      inserted: false,
    });
    expect(logRow(doseId, DATE)?.status).toBe("taken");
    expect(onHand(itemId)).toBe(7);

    // A retired dose is a permanent rejection like a deleted one.
    const retired = seedDose(itemId, "1 cap", 1);
    expect(skipDose(profileId, retired, DATE)).toEqual({
      ok: false,
      inserted: false,
    });
  });
});
