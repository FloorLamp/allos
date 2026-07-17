// DB INTEGRATION TIER — the PRN administration delete/restore cores invert EVERY
// side effect (#851 item 11). A phantom "Log" tap decrements supply, advances the
// redose window, and counts toward the daily max; the window + count are DERIVED from
// the ledger rows, so deleting the row must auto-recompute them and re-credit supply,
// and restore must re-apply. This drives the lib cores directly against the migrated
// singleton (deleteAdministrationLog / restoreAdministrationLog), asserting the
// derived redose arming state, the over-max finding input, and supply all round-trip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  logAdministration,
  deleteAdministrationLog,
  restoreAdministrationLog,
  getRedoseArmingState,
  getPrnOverMaxItems,
} from "@/lib/queries";

// A PRN medication with a confirmed redose interval + daily max and tracked supply.
function seedPrnMed(opts: {
  maxDailyCount: number;
  minIntervalHours: number;
  quantityOnHand: number;
  name?: string;
}): { profileId: number; itemId: number } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Undo Fixture')").run()
      .lastInsertRowid
  );
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed,
            min_interval_hours, max_daily_count, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'daily', 'high', 1, ?, ?, ?, 1)`
      )
      .run(
        profileId,
        opts.name ?? "Ibuprofen",
        opts.minIntervalHours,
        opts.maxDailyCount,
        opts.quantityOnHand
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '200 mg', NULL, 'any', 0)`
  ).run(itemId);
  return { profileId, itemId };
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

function adminIds(itemId: number): number[] {
  return (
    db
      .prepare(
        "SELECT id FROM intake_item_logs WHERE item_id = ? AND status = 'taken' ORDER BY id"
      )
      .all(itemId) as { id: number }[]
  ).map((r) => r.id);
}

// Three administrations spaced well outside the double-tap dedup window, all in the
// recent past (so the #614 window guard accepts them and each is a distinct row).
function logThree(profileId: number, itemId: number) {
  logAdministration(profileId, itemId, new Date(Date.now() - 30 * 60_000));
  logAdministration(profileId, itemId, new Date(Date.now() - 20 * 60_000));
  logAdministration(profileId, itemId, new Date(Date.now() - 10 * 60_000));
}

describe("deleteAdministrationLog / restoreAdministrationLog — window + supply round-trip", () => {
  // Freeze the clock at a fixed mid-day. logThree logs administrations at now − 30/20/10
  // minutes; run in the 00:00–00:30 window those relative times straddle midnight and land
  // on YESTERDAY's profile-local date, while the assertions query today() — so countToday
  // reads 0 (a time-of-day flake, unrelated to supply accounting). Freezing now() and
  // today() to the same mid-day instant makes the fixture deterministic regardless of when
  // CI runs; the delete/restore round-trip assertions below are unchanged.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delete drops the derived count/over-max and re-credits supply; restore re-applies", () => {
    const { profileId, itemId } = seedPrnMed({
      maxDailyCount: 2,
      minIntervalHours: 6,
      quantityOnHand: 10,
    });
    const date = today(profileId);

    // Three administrations: count 3, supply 10 − 3 = 7, over the max of 2.
    logThree(profileId, itemId);
    expect(getRedoseArmingState(profileId, itemId, date).countToday).toBe(3);
    expect(onHand(itemId)).toBe(7);
    let over = getPrnOverMaxItems(profileId, date);
    expect(over.map((o) => o.id)).toContain(itemId);
    expect(over.find((o) => o.id === itemId)!.count).toBe(3);

    // Delete one administration → the derived window recomputes (count 2, no longer
    // over the max of 2) and supply is re-credited 7 → 8.
    const logId = adminIds(itemId)[1]; // the middle one
    const undoId = deleteAdministrationLog(profileId, logId);
    expect(typeof undoId).toBe("number");
    expect(getRedoseArmingState(profileId, itemId, date).countToday).toBe(2);
    expect(onHand(itemId)).toBe(8);
    expect(getPrnOverMaxItems(profileId, date).map((o) => o.id)).not.toContain(
      itemId
    );

    // Restore → count back to 3 (a NEW ledger row), over-max fires again, supply
    // re-decremented 8 → 7.
    expect(restoreAdministrationLog(profileId, undoId!)).toBe(true);
    expect(getRedoseArmingState(profileId, itemId, date).countToday).toBe(3);
    expect(onHand(itemId)).toBe(7);
    over = getPrnOverMaxItems(profileId, date);
    expect(over.find((o) => o.id === itemId)!.count).toBe(3);
    // The restored row is a fresh id (never resurrects the deleted primary key).
    expect(adminIds(itemId)).not.toContain(logId);
  });

  it("restoreAdministrationLog returns false for a bogus / already-consumed token", () => {
    const { profileId } = seedPrnMed({
      maxDailyCount: 2,
      minIntervalHours: 6,
      quantityOnHand: 10,
    });
    expect(restoreAdministrationLog(profileId, 987654)).toBe(false);
  });

  it("deleteAdministrationLog returns null for another profile's log (ownership scope)", () => {
    const a = seedPrnMed({
      maxDailyCount: 2,
      minIntervalHours: 6,
      quantityOnHand: 10,
      name: "Ibuprofen A",
    });
    const b = seedPrnMed({
      maxDailyCount: 2,
      minIntervalHours: 6,
      quantityOnHand: 10,
      name: "Ibuprofen B",
    });
    logAdministration(
      b.profileId,
      b.itemId,
      new Date(Date.now() - 15 * 60_000)
    );
    const bLogId = adminIds(b.itemId)[0];

    // Profile A tries to delete profile B's administration — scoped out, null, no-op.
    expect(deleteAdministrationLog(a.profileId, bLogId)).toBeNull();
    expect(adminIds(b.itemId)).toContain(bLogId); // still there
    expect(onHand(b.itemId)).toBe(9); // B's supply untouched by the failed delete
  });
});
