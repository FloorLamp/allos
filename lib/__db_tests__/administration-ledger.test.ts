// DB INTEGRATION TIER — the per-administration ledger (issue #797, migration 041).
//
// Two concerns:
//
//   1. MIGRATION BIT-IDENTITY (the acceptance GATE): existing SCHEDULED adherence
//      history must read identically after the rebuild. We build the real pre-041
//      schema by running migrations 001–040 on a fresh handle, seed a realistic
//      14-day scheduled history (taken / skipped / missed across two doses), capture
//      the adherence strip + the (dose,date,status) triples the strip/streak/
//      escalation reads consume, then run migration 041 and assert byte-identical
//      output — plus that given_at backfilled from taken_at and the UNIQUE(dose_id,
//      date) constraint is gone (a second same-day row now inserts).
//
//   2. WRITE-CORE SEMANTICS on the migrated schema (via the redirected singleton):
//      markDoseTaken keeps one-taken-row-per-(dose,date) for a scheduled dose;
//      logAdministration allows PRN multiples, decrements supply per administration,
//      dedups a double-tap, and refuses a forged/far-off given_at (#614).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { db, today } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { lastNDates } from "@/lib/date";
import {
  indexTakenByDose,
  supplementAdherenceStrip,
} from "@/lib/supplement-adherence";
import {
  markDoseTaken,
  logAdministration,
  getAdministrationsForItemOnDate,
  getAdministrationsForItemsOnDate,
  getPrnMedicationsForQuickLog,
} from "@/lib/queries";
import type { Supplement } from "@/lib/types";

// A minimal daily supplement for the pure strip computation (isDueOn reads only
// condition / situation / as_needed).
const DAILY_SUPP = {
  condition: "daily",
  situation: null,
  as_needed: 0,
} as unknown as Supplement;

const ANCHOR = "2026-07-15"; // arbitrary strip anchor; the strip is pure over dates

// Apply migrations 001..maxId to a fresh in-memory handle, foreign_keys off (the way
// the runner / migrate() apply them), building the schema at that version exactly.
function schemaAt(maxId: number): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  for (const m of MIGRATIONS) {
    if (m.id <= maxId) m.up(mem);
  }
  return mem;
}

// Seed one profile + a daily supplement with two doses, and a realistic 14-day
// scheduled history: doseA taken most days (two deliberate skips, two misses),
// doseB taken on fewer days. Uses the pre-041 log INSERT shape (dose_id,item_id,
// date,taken_at,status) — one row per (dose,date), which the UNIQUE allowed.
function seedScheduledHistory(mem: Database.Database): {
  itemId: number;
  doseIds: number[];
} {
  const itemId = Number(
    mem
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
         VALUES (1, 'Vitamin D', 1, 'supplement', 'daily', 'high')`
      )
      .run().lastInsertRowid
  );
  // profiles row so any FK/JOIN is satisfiable; profile_id is 1 above.
  mem.prepare("INSERT INTO profiles (id, name) VALUES (1, 'Fixture')").run();
  const mkDose = (sort: number) =>
    Number(
      mem
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 cap', 'morning', 'any', ?)`
        )
        .run(itemId, sort).lastInsertRowid
    );
  const doseA = mkDose(0);
  const doseB = mkDose(1);
  const dates = lastNDates(ANCHOR, 14);
  const ins = mem.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, taken_at, status)
     VALUES (?, ?, ?, ?, ?)`
  );
  dates.forEach((d, i) => {
    // doseA: skip on days 3 & 9, miss on days 6 & 12, taken otherwise.
    if (i !== 6 && i !== 12) {
      ins.run(
        doseA,
        itemId,
        d,
        `${d} 08:00:00`,
        i === 3 || i === 9 ? "skipped" : "taken"
      );
    }
    // doseB: taken only on even indices (a sparser second dose).
    if (i % 2 === 0) ins.run(doseB, itemId, d, `${d} 20:00:00`, "taken");
  });
  return { itemId, doseIds: [doseA, doseB] };
}

function logTriples(
  mem: Database.Database
): { dose_id: number; date: string; status: string }[] {
  return mem
    .prepare(
      "SELECT dose_id, date, status FROM intake_item_logs ORDER BY dose_id, date"
    )
    .all() as { dose_id: number; date: string; status: string }[];
}

function stripOf(
  rows: { dose_id: number; date: string; status: "taken" | "skipped" }[],
  doseIds: number[]
) {
  return supplementAdherenceStrip(
    DAILY_SUPP,
    doseIds,
    lastNDates(ANCHOR, 14),
    new Set(),
    () => new Set(),
    indexTakenByDose(rows)
  );
}

describe("migration 041 — administration ledger: scheduled adherence is bit-identical", () => {
  it("migrated data yields the same strip / (dose,date,status) triples, backfills given_at, drops UNIQUE", () => {
    const mem = schemaAt(40); // pre-041 schema
    const { doseIds } = seedScheduledHistory(mem);

    const before = logTriples(mem);
    const stripBefore = stripOf(before as never, doseIds);
    const countBefore = before.length;

    // Apply migration 041.
    const m041 = MIGRATIONS.find((m) => m.id === 41)!;
    m041.up(mem);

    // Row count preserved 1:1.
    const countAfter = (
      mem.prepare("SELECT COUNT(*) AS c FROM intake_item_logs").get() as {
        c: number;
      }
    ).c;
    expect(countAfter).toBe(countBefore);

    // given_at backfilled from taken_at for every row.
    const mismatches = (
      mem
        .prepare(
          "SELECT COUNT(*) AS c FROM intake_item_logs WHERE given_at IS NOT taken_at"
        )
        .get() as { c: number }
    ).c;
    expect(mismatches).toBe(0);

    // (dose,date,status) triples — the input to getTakenDoseIds / getSkippedDoseIds /
    // getSupplementLogsInRange (the strip/streak/escalation reads) — are unchanged.
    const after = logTriples(mem);
    expect(after).toEqual(before);

    // The adherence strip is byte-identical.
    expect(stripOf(after as never, doseIds)).toEqual(stripBefore);

    // The UNIQUE(dose_id, date) constraint is gone: a second row for one (dose,date)
    // now inserts (the PRN-multiples capability), where pre-041 it threw.
    const someDose = doseIds[0];
    const someDate = lastNDates(ANCHOR, 14)[0];
    expect(() =>
      mem
        .prepare(
          `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at)
           VALUES (?, (SELECT item_id FROM intake_item_doses WHERE id = ?), ?, '2026-07-02 09:00:00')`
        )
        .run(someDose, someDose, someDate)
    ).not.toThrow();
  });
});

// ---- Write-core semantics on the live (migrated) singleton ----

function seedPrnMed(quantityOnHand: number | null = 10): {
  profileId: number;
  itemId: number;
} {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('PRN Fixture')").run()
      .lastInsertRowid
  );
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed, quantity_on_hand, qty_per_dose)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'high', 1, ?, 1)`
      )
      .run(profileId, quantityOnHand).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', 'any', 'any', 0)`
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

// Total taken administration rows for an item (date-agnostic — an offset near the
// UTC midnight boundary can land two intakes on different calendar days).
function adminRows(itemId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ? AND status = 'taken'"
      )
      .get(itemId) as { c: number }
  ).c;
}

describe("markDoseTaken — one-per-day preserved without the UNIQUE constraint (#797)", () => {
  it("a second same-day tap of one scheduled dose is 'already-taken', not a second row", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Sched')").run()
        .lastInsertRowid
    );
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, quantity_on_hand, qty_per_dose)
           VALUES (?, 'Lisinopril', 1, 'medication', 'daily', 'high', 30, 1)`
        )
        .run(profileId).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '10 mg', 'morning', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    const date = today(profileId);
    expect(markDoseTaken(profileId, doseId, itemId, date)).toBe("logged");
    expect(markDoseTaken(profileId, doseId, itemId, date)).toBe(
      "already-taken"
    );
    const rows = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM intake_item_logs WHERE dose_id = ? AND date = ?"
        )
        .get(doseId, date) as { c: number }
    ).c;
    expect(rows).toBe(1);
    // Supply decremented exactly once (not twice).
    expect(onHand(itemId)).toBe(29);
  });
});

describe("logAdministration — PRN multiples, per-dose supply, dedup, window guard (#797)", () => {
  it("allows multiple administrations a day, decrementing supply each time", () => {
    const { profileId, itemId } = seedPrnMed(10);
    // Three genuinely-different intake times, each >dedup-window apart and in the
    // recent past (so the #614 window guard accepts them).
    const r1 = logAdministration(
      profileId,
      itemId,
      new Date(Date.now() - 12 * 60_000)
    );
    const r2 = logAdministration(
      profileId,
      itemId,
      new Date(Date.now() - 6 * 60_000)
    );
    const r3 = logAdministration(profileId, itemId); // now
    expect(r1.kind).toBe("logged");
    expect(r2.kind).toBe("logged");
    expect(r3.kind).toBe("logged");
    expect(adminRows(itemId)).toBe(3);
    expect(onHand(itemId)).toBe(7); // 10 − 3
  });

  it("collapses a double-tap (same given time within the window) to one row", () => {
    const { profileId, itemId } = seedPrnMed(10);
    const at = new Date(Date.now() - 30 * 60 * 1000);
    const first = logAdministration(profileId, itemId, at);
    const second = logAdministration(profileId, itemId, at); // immediate re-tap
    expect(first.kind).toBe("logged");
    expect(second.kind).toBe("duplicate");
    expect(adminRows(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(9); // decremented once
  });

  it("accepts a same-day retro time but refuses a far-future / far-past one (#614)", () => {
    const { profileId, itemId } = seedPrnMed(10);
    // Retro: two hours ago → logged.
    expect(
      logAdministration(profileId, itemId, new Date(Date.now() - 2 * 3600_000))
        .kind
    ).toBe("logged");
    // Far future (tomorrow) → invalid-time, nothing written.
    expect(
      logAdministration(profileId, itemId, new Date(Date.now() + 26 * 3600_000))
        .kind
    ).toBe("invalid-time");
    // Far past (10 days ago, outside the window) → invalid-time.
    expect(
      logAdministration(
        profileId,
        itemId,
        new Date(Date.now() - 10 * 24 * 3600_000)
      ).kind
    ).toBe("invalid-time");
  });

  it("refuses a paused item and a non-existent item", () => {
    const { profileId, itemId } = seedPrnMed(10);
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(itemId);
    expect(logAdministration(profileId, itemId).kind).toBe("inactive");
    expect(logAdministration(profileId, 999999).kind).toBe("stale-item");
  });

  it("surfaces the PRN med in the quick-log read and day list with today's count", () => {
    const { profileId, itemId } = seedPrnMed(10);
    const date = today(profileId);
    logAdministration(profileId, itemId); // now → always today's date
    const meds = getPrnMedicationsForQuickLog(profileId);
    const mine = meds.find((m) => m.id === itemId);
    expect(mine).toBeTruthy();
    expect(mine!.amount).toBe("400 mg");
    expect(mine!.count).toBe(1);
    expect(mine!.lastGivenAt).toBeTruthy();
    const admins = getAdministrationsForItemOnDate(profileId, itemId, date);
    expect(admins).toHaveLength(1);
    expect(admins[0].given_at).toBeTruthy();
  });
});

describe("getAdministrationsForItemsOnDate — batched, same output as per-item (#885)", () => {
  // Freeze the clock at a fixed mid-day (#990). The fixtures log administrations at
  // now − 30/12/6 minutes; run in the 00:00–00:30 window those relative times straddle
  // local midnight and land on YESTERDAY's profile-local date while the assertions
  // query today() — so itemA reads 1 admin instead of 2 (a time-of-day flake). Freezing
  // now() and today() to the same mid-day instant makes it deterministic regardless of
  // when CI runs; the batched-parity assertions below are unchanged.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns each item's day administrations identical to the per-item query", () => {
    // Two PRN meds under one profile, each with several administrations today.
    const { profileId, itemId: itemA } = seedPrnMed(10);
    const itemB = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, as_needed, quantity_on_hand, qty_per_dose)
           VALUES (?, 'Acetaminophen', 1, 'medication', 'daily', 'high', 1, 10, 1)`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '500 mg', 'any', 'any', 0)`
    ).run(itemB);
    // A third PRN med with NO administrations today (must be absent from the map).
    const itemC = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, as_needed, quantity_on_hand, qty_per_dose)
           VALUES (?, 'Loratadine', 1, 'medication', 'daily', 'high', 1, 10, 1)`
        )
        .run(profileId).lastInsertRowid
    );

    logAdministration(profileId, itemA, new Date(Date.now() - 30 * 60_000));
    logAdministration(profileId, itemA, new Date(Date.now() - 6 * 60_000));
    logAdministration(profileId, itemB, new Date(Date.now() - 12 * 60_000));

    const date = today(profileId);
    const batch = getAdministrationsForItemsOnDate(
      profileId,
      [itemA, itemB, itemC],
      date
    );
    // Byte-identical to the pre-#885 per-item query for every item.
    for (const id of [itemA, itemB, itemC]) {
      expect(batch.get(id) ?? []).toEqual(
        getAdministrationsForItemOnDate(profileId, id, date)
      );
    }
    expect(batch.get(itemA)).toHaveLength(2);
    expect(batch.get(itemB)).toHaveLength(1);
    expect(batch.has(itemC)).toBe(false); // no admins today → absent

    // Empty id set → empty map (no query).
    expect(getAdministrationsForItemsOnDate(profileId, [], date).size).toBe(0);
  });

  it("scopes to the acting profile — another profile's item never appears", () => {
    const { profileId: pA, itemId: itemA } = seedPrnMed(10);
    const { profileId: pB, itemId: itemB } = seedPrnMed(10);
    logAdministration(pA, itemA);
    logAdministration(pB, itemB);
    const date = today(pA);
    // Ask profile A for BOTH ids: only its own item resolves (JOIN filters by profile).
    const batch = getAdministrationsForItemsOnDate(pA, [itemA, itemB], date);
    expect(batch.get(itemA)).toHaveLength(1);
    expect(batch.has(itemB)).toBe(false);
  });
});
