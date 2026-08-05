// The day-counter ledger's PURE surface (issue #2037): which tables are declared day
// counters, and that every statement the discipline compiles to still carries the four
// steps that make it safe. The behaviour lives in lib/__db_tests__/day-counter-ledger.
//
// These assertions are deliberately about the SQL TEXT. The whole point of #2037 is that
// the guard, the clamp, the drop-at-zero and the additive conflict clause exist exactly
// once; a change that quietly drops one of them from the generator would corrupt five
// call sites at a stroke, and text is what proves they are still there.

import { describe, it, expect } from "vitest";
import {
  DAY_COUNTERS,
  dayCounterSpecFor,
  dayCounterSql,
  type DayCounterSpec,
} from "@/lib/day-counter-ledger";
import { UNDO_KINDS } from "@/lib/undo-delete";

const ALL: DayCounterSpec[] = Object.values(DAY_COUNTERS);

describe("declared day counters (#2037)", () => {
  it("declares the three counters the issue names", () => {
    expect(Object.keys(DAY_COUNTERS).sort()).toEqual([
      "food",
      "protein",
      "substance",
    ]);
    expect(DAY_COUNTERS.food.table).toBe("food_log");
    expect(DAY_COUNTERS.substance.table).toBe("substance_log");
    expect(DAY_COUNTERS.protein.table).toBe("protein_log");
  });

  it("gives every counter an amount column and a key it can address", () => {
    for (const spec of ALL) {
      expect(spec.table.length, spec.table).toBeGreaterThan(0);
      expect(spec.amountColumn.length, spec.table).toBeGreaterThan(0);
      // profile_id and date are implicit; anything else is declared, never guessed.
      expect(spec.keyColumns, spec.table).not.toContain("profile_id");
      expect(spec.keyColumns, spec.table).not.toContain("date");
    }
  });
});

describe("the compiled discipline (#2037)", () => {
  it("makes every upsert ADDITIVE rather than an overwrite", () => {
    for (const spec of ALL) {
      const { upsert } = dayCounterSql(spec);
      expect(upsert, spec.table).toContain(
        `${spec.amountColumn} = ${spec.amountColumn} + excluded.${spec.amountColumn}`
      );
      // Conflict target is the whole natural key, so two taps on the SAME coordinate
      // compose and two taps on different ones stay separate rows.
      expect(upsert, spec.table).toContain(
        `ON CONFLICT (${["profile_id", "date", ...spec.keyColumns].join(", ")})`
      );
    }
  });

  it("guards and clamps every decrement", () => {
    for (const spec of ALL) {
      const { decrement } = dayCounterSql(spec);
      // The clamp keeps CHECK (x >= 0) satisfied for an over-large unbump…
      expect(decrement, spec.table).toContain(
        `MAX(0, ${spec.amountColumn} - ?)`
      );
      // …and the guard keeps the statement off a row that is already spent.
      expect(decrement, spec.table).toContain(`${spec.amountColumn} > 0`);
    }
  });

  it("drops at zero rather than leaving a zero row", () => {
    for (const spec of ALL) {
      const { drop } = dayCounterSql(spec);
      expect(drop, spec.table).toContain(`DELETE FROM ${spec.table}`);
      expect(drop, spec.table).toContain(`${spec.amountColumn} <= 0`);
    }
  });

  it("scopes every statement by profile and day", () => {
    for (const spec of ALL) {
      const sql = dayCounterSql(spec);
      for (const [name, text] of Object.entries(sql)) {
        if (name === "upsert") continue; // an INSERT names its columns, not a WHERE
        expect(text, `${spec.table}.${name}`).toContain("profile_id = ?");
        expect(text, `${spec.table}.${name}`).toContain("date = ?");
        for (const c of spec.keyColumns)
          expect(text, `${spec.table}.${name}`).toContain(`${c} = ?`);
      }
    }
  });

  it("touches the last-tap stamp only where one is declared", () => {
    expect(dayCounterSql(DAY_COUNTERS.substance).upsert).toContain(
      "logged_at = excluded.logged_at"
    );
    // The other two move the count and nothing else: their only `excluded.` reference
    // is the additive amount clause every counter has.
    for (const spec of [DAY_COUNTERS.food, DAY_COUNTERS.protein]) {
      const refs = dayCounterSql(spec).upsert.match(/excluded\.\w+/g) ?? [];
      expect(refs, spec.table).toEqual([`excluded.${spec.amountColumn}`]);
    }
  });

  it("binds every value it interpolates no identifier for", () => {
    // One placeholder per bound value: the insert binds profile_id, date, every key
    // column, the amount and every touch column.
    const { upsert } = dayCounterSql(DAY_COUNTERS.substance);
    const placeholders = (upsert.match(/\?/g) ?? []).length;
    expect(placeholders).toBe(
      2 + DAY_COUNTERS.substance.keyColumns.length + 1 + 1
    );
  });
});

describe("the undo registry's counters are ledger counters (#2037 / #2074)", () => {
  it("converts every declared CounterSpec into a ledger spec", () => {
    // `CounterSpec` (lib/undo-delete.ts) declares WHICH captured entity is a day counter;
    // this module is the arithmetic that declaration implies. A counter entity whose key
    // carries no date could not be one, and this is where that would surface.
    const counters = Object.values(UNDO_KINDS).flatMap((kind) =>
      kind.entities
        .filter((e) => e.counter)
        .map((e) => ({ table: e.table, counter: e.counter! }))
    );
    expect(counters.length).toBeGreaterThan(0);
    for (const { table, counter } of counters) {
      const spec = dayCounterSpecFor(table, counter.column, counter.key);
      expect(spec.table).toBe(table);
      expect(spec.amountColumn).toBe(counter.column);
      expect(spec.keyColumns).not.toContain("date");
      // The undo counter for a food serving is the SAME table the write side declares.
      if (table === DAY_COUNTERS.food.table)
        expect(spec.keyColumns).toEqual(DAY_COUNTERS.food.keyColumns);
    }
  });

  it("refuses a key with no day in it", () => {
    expect(() =>
      dayCounterSpecFor("food_log", "servings", ["group_key"])
    ).toThrow(/no date/);
  });
});
