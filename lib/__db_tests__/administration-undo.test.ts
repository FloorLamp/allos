// DB INTEGRATION TIER — the PRN administration delete/restore cores invert EVERY
// side effect (#851 item 11). A phantom "Log" tap decrements supply, advances the
// redose window, and counts toward the daily max; the window + count are DERIVED from
// the ledger rows, so deleting the row must auto-recompute them and re-credit supply,
// and restore must re-apply. This drives the lib cores directly against the migrated
// singleton (deleteAdministrationLog / restoreAdministrationLog), asserting the
// derived redose arming state, the over-max finding input, and supply all round-trip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ceilingWindowEndMinute } from "@/lib/prn-redose";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  logAdministration,
  deleteAdministrationLog,
  restoreAdministrationLog,
  getRedoseArmingState,
  getPrnOverMaxItems,
} from "@/lib/queries";
import { logUsualRoutineCore } from "@/lib/usual-routine-write";
import { pendingDayDoses } from "@/lib/queries/usual-routine";
import { getDayDoseLedger } from "@/lib/queries/day-ledger";
import { buildDayLedger, type LedgerStack } from "@/lib/day-ledger";

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
           (profile_id, name, active, kind, condition, obligation, min_interval_hours, max_daily_count, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', ?, ?, ?, 1)`
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
  logAdministration(
    profileId,
    itemId,
    "page",
    new Date(Date.now() - 30 * 60_000)
  );
  logAdministration(
    profileId,
    itemId,
    "page",
    new Date(Date.now() - 20 * 60_000)
  );
  logAdministration(
    profileId,
    itemId,
    "page",
    new Date(Date.now() - 10 * 60_000)
  );
}

describe("deleteAdministrationLog / restoreAdministrationLog — window + supply round-trip", () => {
  // Freeze the clock at a fixed mid-day so the fixture is deterministic regardless of
  // when CI runs. Since #4686 the ceiling counts the trailing 24 HOURS rather than a
  // profile-local day, so the midnight-straddle this comment used to describe can no
  // longer drop these rows out of the count at all — the freeze stays because the
  // delete/restore assertions still want one fixed instant.
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

    // Three administrations: count 3, supply 10 − 3 = 7, over the max of 2.
    logThree(profileId, itemId);
    expect(
      getRedoseArmingState(
        profileId,
        itemId,
        ceilingWindowEndMinute(new Date())
      ).countInWindow
    ).toBe(3);
    expect(onHand(itemId)).toBe(7);
    let over = getPrnOverMaxItems(
      profileId,
      ceilingWindowEndMinute(new Date())
    );
    expect(over.map((o) => o.id)).toContain(itemId);
    expect(over.find((o) => o.id === itemId)!.total).toBe(3);

    // Delete one administration → the derived window recomputes (count 2, no longer
    // over the max of 2) and supply is re-credited 7 → 8.
    const logId = adminIds(itemId)[1]; // the middle one
    const removed = deleteAdministrationLog(profileId, logId);
    expect(typeof removed?.undoId).toBe("number");
    const undoId = removed!.undoId;
    expect(
      getRedoseArmingState(
        profileId,
        itemId,
        ceilingWindowEndMinute(new Date())
      ).countInWindow
    ).toBe(2);
    expect(onHand(itemId)).toBe(8);
    expect(
      getPrnOverMaxItems(profileId, ceilingWindowEndMinute(new Date())).map(
        (o) => o.id
      )
    ).not.toContain(itemId);

    // Restore → count back to 3 (a NEW ledger row), over-max fires again, supply
    // re-decremented 8 → 7.
    expect(restoreAdministrationLog(profileId, undoId!)).toBe(true);
    expect(
      getRedoseArmingState(
        profileId,
        itemId,
        ceilingWindowEndMinute(new Date())
      ).countInWindow
    ).toBe(3);
    expect(onHand(itemId)).toBe(7);
    over = getPrnOverMaxItems(profileId, ceilingWindowEndMinute(new Date()));
    expect(over.find((o) => o.id === itemId)!.total).toBe(3);
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
      "page",
      new Date(Date.now() - 15 * 60_000)
    );
    const bLogId = adminIds(b.itemId)[0];

    // Profile A tries to delete profile B's administration — scoped out, null, no-op.
    expect(deleteAdministrationLog(a.profileId, bLogId)).toBeNull();
    expect(adminIds(b.itemId)).toContain(bLogId); // still there
    expect(onHand(b.itemId)).toBe(9); // B's supply untouched by the failed delete
  });
});

// ── THE UNDO CARRIES THE COMPOSED WRITE (#4328) ──────────────────────────────
//
// `restoreAdministrationLog` puts back the row that was deleted, which since #4328
// includes the bundle that row was born with — so a member undone out of a stack rejoins
// the stack rather than standing beside it as a lone dose with the same clock.
//
// THIS IS THE ONLY GUARD ON THAT ARGUMENT. Mutating the restore's `bundle_id` to `null`
// leaves the rest of this tier green, because every other assertion about an undo is
// about supply, the redose window and the daily count — none of them can see which row
// the ledger files the restored dose on. So the claim is asserted where a person would
// see it: through the ledger reader, on the stack row itself.
describe("restoreAdministrationLog returns a member to its stack row (#4328)", () => {
  // One composed tap, one minute: the clock is pinned so the three rows cannot straddle a
  // minute boundary and split the collapse on `hhmm` for a reason this test is not about.
  const NOW_ISO = "2026-06-15T08:12:00Z";
  let priorNow: string | undefined;
  beforeEach(() => {
    priorNow = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = NOW_ISO;
  });
  afterEach(() => {
    if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = priorNow;
  });

  // Three morning supplements of ONE routine, all born a month back so the day owes each.
  function seedStack(name: string): { profileId: number; doseIds: number[] } {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
    setTimezone(profileId, "UTC");
    const born = `${shiftDateStr(today(profileId), -30)} 09:00:00`;
    const doseIds = ["Alpha", "Beta", "Gamma"].map((member) => {
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items
               (profile_id, name, kind, active, obligation, condition, stack, created_at)
             VALUES (?, ?, 'supplement', 1, 'should', 'daily', 'Morning stack', ?)`
          )
          .run(profileId, `${name} ${member}`, born).lastInsertRowid
      );
      return Number(
        db
          .prepare(
            `INSERT INTO intake_item_doses
               (item_id, amount, time_of_day, food_timing, sort, created_at)
             VALUES (?, '1 cap', 'morning', 'any', 0, ?)`
          )
          .run(itemId, born).lastInsertRowid
      );
    });
    return { profileId, doseIds };
  }

  // The Morning stack row as the page builds it, or undefined when the day holds none.
  // Read through the SAME pair the ledger renders from (`getDayDoseLedger` +
  // `buildDayLedger`), never a hand-rolled query: a bundle is only ever a fact about
  // which row a dose lands on.
  function stackRow(profileId: number, date: string): LedgerStack | undefined {
    const groups = buildDayLedger({
      servings: [],
      doses: getDayDoseLedger(profileId, date),
      pending: pendingDayDoses(profileId, date),
    });
    const morning = groups.find((g) => g.bucket === "Morning");
    return morning?.rows.find((r): r is LedgerStack => r.kind === "stack");
  }

  it("a member deleted out of a composed write rejoins the same row when it is restored", () => {
    const { profileId, doseIds } = seedStack("Undo Stack");
    const date = today(profileId);

    // ONE tap of all three, through the real composed writer — the bundle is minted
    // there, so nothing in this test spells one.
    const wrote = logUsualRoutineCore(
      profileId,
      "Morning",
      date,
      [],
      doseIds,
      "page"
    );
    expect(wrote.kind).toBe("logged");
    const before = stackRow(profileId, date);
    expect(before?.written).toHaveLength(3);

    // Delete the middle member. Two remain on the row — still a composed write, now
    // stating two.
    const middle = (
      db
        .prepare(
          "SELECT id FROM intake_item_logs WHERE dose_id = ? AND date = ?"
        )
        .get(doseIds[1], date) as { id: number }
    ).id;
    const removed = deleteAdministrationLog(profileId, middle);
    expect(removed).not.toBeNull();
    expect(stackRow(profileId, date)?.written).toHaveLength(2);

    // Restore. THE CLAIM: three again, on ONE row — not two plus a lone dose beside it.
    expect(restoreAdministrationLog(profileId, removed!.undoId)).toBe(true);
    const after = stackRow(profileId, date);
    expect(after?.written).toHaveLength(3);
    // And it is the SAME row, keyed on the same composed action the tap recorded.
    expect(after?.id).toBe(before?.id);
  });
});
