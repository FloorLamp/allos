// DB INTEGRATION TIER (#448) — the day-counter ledger (issue #2037) against the real
// tables it was extracted from.
//
// The three cores (food servings, substance units, protein grams) had each hand-written
// the same four-step discipline, and the risk of that was never a wrong number in one
// place — it was five copies drifting. So these tests exercise the LEDGER directly,
// including the sequences the copies were most likely to get wrong: an unbump past zero,
// an unbump of a coordinate that was never logged, an over-large unbump against a
// CHECK-constrained column, and interleavings that must never leave a zero row behind.

import { describe, it, expect } from "vitest";
import { db, writeTx } from "@/lib/db";
import { DAY_COUNTERS } from "@/lib/day-counter-ledger";
import {
  foodDayCounter,
  proteinDayCounter,
  substanceDayCounter,
} from "@/lib/day-counter-ledger-db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function rowCount(table: string, profileId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_id = ?`)
      .get(profileId) as { n: number }
  ).n;
}

const DATE = "2026-03-04";

describe("day-counter ledger: bump (#2037)", () => {
  it("creates the coordinate's row and reports the authoritative total", () => {
    const p = newProfile("ledger bump");
    const total = writeTx(() =>
      foodDayCounter.bump(p, DATE, ["vegetables"], 1)
    );
    expect(total).toBe(1);
    expect(rowCount("food_log", p)).toBe(1);
  });

  it("ADDS on conflict instead of overwriting", () => {
    const p = newProfile("ledger add");
    writeTx(() => foodDayCounter.bump(p, DATE, ["vegetables"], 1));
    const second = writeTx(() =>
      foodDayCounter.bump(p, DATE, ["vegetables"], 1)
    );
    expect(second).toBe(2);
    // Still ONE row — the conflict target is the whole natural key.
    expect(rowCount("food_log", p)).toBe(1);
  });

  it("keeps different coordinates on different rows", () => {
    const p = newProfile("ledger coords");
    writeTx(() => {
      foodDayCounter.bump(p, DATE, ["vegetables"], 1);
      foodDayCounter.bump(p, DATE, ["fruit"], 1);
      foodDayCounter.bump(p, "2026-03-05", ["vegetables"], 1);
    });
    expect(rowCount("food_log", p)).toBe(3);
    expect(foodDayCounter.total(p, DATE, ["vegetables"])).toBe(1);
  });

  it("adds N at a time for a counter whose tick is not one", () => {
    const p = newProfile("ledger grams");
    writeTx(() => proteinDayCounter.bump(p, DATE, [], 25));
    const total = writeTx(() => proteinDayCounter.bump(p, DATE, [], 30));
    expect(total).toBe(55);
  });

  it("re-stamps a declared touch column on every bump", () => {
    const p = newProfile("ledger touch");
    writeTx(() =>
      substanceDayCounter.bump(p, DATE, ["nicotine"], 1, [
        "2026-03-04T08:00:00Z",
      ])
    );
    writeTx(() =>
      substanceDayCounter.bump(p, DATE, ["nicotine"], 1, [
        "2026-03-04T21:30:00Z",
      ])
    );
    const row = db
      .prepare(
        "SELECT units, logged_at FROM substance_log WHERE profile_id = ? AND date = ? AND substance = ?"
      )
      .get(p, DATE, "nicotine") as { units: number; logged_at: string };
    expect(row.units).toBe(2);
    expect(row.logged_at).toBe("2026-03-04T21:30:00Z");
  });

  it("never lets one profile's counter reach another's", () => {
    const a = newProfile("ledger scope a");
    const b = newProfile("ledger scope b");
    writeTx(() => foodDayCounter.bump(a, DATE, ["fruit"], 1));
    expect(foodDayCounter.total(b, DATE, ["fruit"])).toBe(0);
    expect(rowCount("food_log", b)).toBe(0);
  });
});

describe("day-counter ledger: unbump and drop-at-zero (#2037)", () => {
  it("decrements without dropping while the day still holds ticks", () => {
    const p = newProfile("ledger dec");
    writeTx(() => {
      foodDayCounter.bump(p, DATE, ["fruit"], 1);
      foodDayCounter.bump(p, DATE, ["fruit"], 1);
    });
    const left = writeTx(() => foodDayCounter.unbump(p, DATE, ["fruit"], 1));
    expect(left).toBe(1);
    expect(rowCount("food_log", p)).toBe(1);
  });

  it("DROPS the row the moment it returns to zero", () => {
    const p = newProfile("ledger drop");
    writeTx(() => foodDayCounter.bump(p, DATE, ["fruit"], 1));
    const left = writeTx(() => foodDayCounter.unbump(p, DATE, ["fruit"], 1));
    expect(left).toBe(0);
    // A zero row is not "nothing logged" to the readers — it renders and counts.
    expect(rowCount("food_log", p)).toBe(0);
  });

  it("is a no-op against a coordinate that was never logged", () => {
    const p = newProfile("ledger noop");
    const left = writeTx(() => foodDayCounter.unbump(p, DATE, ["fruit"], 1));
    expect(left).toBe(0);
    expect(rowCount("food_log", p)).toBe(0);
  });

  it("refuses to drive a CHECK-constrained column negative", () => {
    // grams REAL NOT NULL CHECK (grams >= 0). An unclamped subtract would THROW here
    // and abort the caller's whole transaction — this is the step the clamp exists for.
    const p = newProfile("ledger clamp");
    writeTx(() => proteinDayCounter.bump(p, DATE, [], 20));
    const left = writeTx(() => proteinDayCounter.unbump(p, DATE, [], 500));
    expect(left).toBe(0);
    expect(rowCount("protein_log", p)).toBe(0);
  });

  it("stays at zero rather than going negative under repeated unbumps", () => {
    const p = newProfile("ledger repeat");
    writeTx(() => substanceDayCounter.bump(p, DATE, ["nicotine"], 1, [DATE]));
    for (let i = 0; i < 4; i++)
      writeTx(() => substanceDayCounter.unbump(p, DATE, ["nicotine"], 1));
    expect(substanceDayCounter.total(p, DATE, ["nicotine"])).toBe(0);
    expect(rowCount("substance_log", p)).toBe(0);
    const negatives = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM substance_log WHERE profile_id = ? AND units <= 0"
        )
        .get(p) as { n: number }
    ).n;
    expect(negatives).toBe(0);
  });
});

describe("day-counter ledger: interleavings (#2037)", () => {
  // The concurrent-shaped sequences the copies were most likely to corrupt. The ledger's
  // operations compose inside ONE caller transaction, so an interleaving of taps and
  // undos on one coordinate is exactly a sequence of bumps and unbumps against it.
  const SEQUENCES: { name: string; steps: number[]; expected: number }[] = [
    { name: "tap, tap, undo", steps: [1, 1, -1], expected: 1 },
    { name: "tap, undo, tap", steps: [1, -1, 1], expected: 1 },
    { name: "undo before any tap", steps: [-1, 1], expected: 1 },
    { name: "tap, undo, undo, undo", steps: [1, -1, -1, -1], expected: 0 },
    { name: "three up, three down", steps: [1, 1, 1, -1, -1, -1], expected: 0 },
  ];

  for (const { name, steps, expected } of SEQUENCES) {
    it(`leaves no zero row and no negative count: ${name}`, () => {
      const p = newProfile(`ledger seq ${name}`);
      for (const step of steps)
        writeTx(() =>
          step > 0
            ? foodDayCounter.bump(p, DATE, ["grains"], step)
            : foodDayCounter.unbump(p, DATE, ["grains"], -step)
        );
      expect(foodDayCounter.total(p, DATE, ["grains"])).toBe(expected);
      expect(rowCount("food_log", p)).toBe(expected > 0 ? 1 : 0);
    });
  }

  it("leaves every declared counter free of zero rows after a full unwind", () => {
    const p = newProfile("ledger unwind");
    writeTx(() => {
      foodDayCounter.bump(p, DATE, ["fruit"], 1);
      substanceDayCounter.bump(p, DATE, ["nicotine"], 1, [DATE]);
      proteinDayCounter.bump(p, DATE, [], 40);
    });
    writeTx(() => {
      foodDayCounter.unbump(p, DATE, ["fruit"], 1);
      substanceDayCounter.unbump(p, DATE, ["nicotine"], 1);
      proteinDayCounter.unbump(p, DATE, [], 40);
    });
    for (const spec of Object.values(DAY_COUNTERS))
      expect(rowCount(spec.table, p), spec.table).toBe(0);
  });
});

describe("day-counter ledger: bumpExisting (#2037)", () => {
  it("adds to a live row and reports that it did", () => {
    const p = newProfile("ledger existing");
    writeTx(() => foodDayCounter.bump(p, DATE, ["dairy"], 1));
    const hit = writeTx(() =>
      foodDayCounter.bumpExisting(p, DATE, ["dairy"], 1)
    );
    expect(hit).toBe(true);
    expect(foodDayCounter.total(p, DATE, ["dairy"])).toBe(2);
  });

  it("writes NOTHING and reports false when the row is gone", () => {
    // The undo path's branch point: a delete that emptied the day dropped the row, so
    // the caller must re-insert its captured snapshot rather than mint a bare counter.
    const p = newProfile("ledger existing gone");
    const hit = writeTx(() =>
      foodDayCounter.bumpExisting(p, DATE, ["dairy"], 1)
    );
    expect(hit).toBe(false);
    expect(rowCount("food_log", p)).toBe(0);
  });
});
