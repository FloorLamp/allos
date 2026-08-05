// THE day-counter write ledger (issue #2037) — the PURE half: what a day counter is,
// which tables are one, and the exact SQL the discipline implies. The executing half is
// lib/day-counter-ledger-db.ts (the `X.ts` / `X-db.ts` split lib/undo-delete.ts uses),
// so the statements can be asserted in the pure tier without opening a database.
//
// Three domains keep the same shape of row: ONE row per (profile, date, …identity)
// carrying a running amount that taps push up and undos push back down, and that is
// DROPPED when it returns to zero so a fully-undone day leaves no stray row. Food
// servings (`food_log.servings`), non-food substance units (`substance_log.units`) and
// quick-add protein grams (`protein_log.grams`) are three instances of one idea.
//
// Each of them had hand-written the same four-step discipline, and the file headers
// admitted the copying ("the food-log-write pattern re-instantiated for substance_log",
// "the food_log discipline"). The four steps are:
//
//   1. an upsert that ADDS (`ON CONFLICT … DO UPDATE SET x = x + excluded.x`), so two
//      concurrent taps on the same coordinate compose instead of overwriting;
//   2. a GUARDED decrement (`… WHERE x > 0`, clamped at zero) — every one of these
//      tables carries `CHECK (x >= 0)`, so an unclamped subtract does not corrupt the
//      counter, it THROWS mid-transaction;
//   3. a drop-at-zero DELETE, because a zero row is not "nothing logged" to any of the
//      readers — it is a row that renders, sorts and counts as a logged day;
//   4. an authoritative re-SELECT, so the caller answers with what the database now
//      holds rather than with what it believed it wrote.
//
// All four inside ONE `writeTx` (#468, IMMEDIATE), which is what makes the pair
// "counter moved" + "ledger event written" unobservable apart. The ledger's operations
// are therefore composable INSIDE a caller's transaction — they never open one of their
// own, because the counter move is never the whole write.
//
// Getting any single step wrong corrupts a counter silently, which is what #1963 cost
// once already. So the discipline stops being prose in three headers: the arithmetic
// exists once, and the next domain that needs a day counter declares a spec instead of
// copying whichever file it finds first.
//
// WHAT THIS IS NOT. It is not a repository layer and not an ORM (AGENTS.md: SQL stays
// inline through `db.prepare`, and it still does — this module hands the executing half
// exactly the text it prepares). It owns the counter arithmetic and nothing else.
// Everything domain-specific stays at the call site: catalog validation, typed outcome
// shapes, the event-ledger rows that ride the same transaction, the alcohol/food-group
// coupling (#1078 — alcohol rides `food_log` deliberately, and nothing here changes
// which table anything lands in), and undo/`captureDelete` integration.
//
// RELATIONSHIP TO `CounterSpec` (lib/undo-delete.ts, #2074). That registry DECLARES,
// per undo kind, which captured entity is a day counter the root row is one tick of.
// This module is the arithmetic that declaration implies. Since #2037 the undo path
// runs its decrement and its give-back through a ledger built from that same spec, so
// the write side and the undo side cannot drift about what "give the tick back" means.
//
// SAFETY OF THE INTERPOLATED IDENTIFIERS. Table, key and amount column names come from
// `DAY_COUNTERS` below or from the constant `CounterSpec` registry — never user input,
// exactly as lib/undo-delete-db.ts treats its registry names. Every VALUE is bound.

/** Which table, keyed how, counting what. Names are constants, never user input. */
export interface DayCounterSpec {
  /** The counter table. One row per (profile_id, date, …keyColumns). */
  table: string;
  /**
   * The identity columns BESIDE `profile_id` and `date` — the rest of the natural key,
   * in the order the table's UNIQUE index declares them. Empty for a counter that is
   * one row per day (protein grams).
   */
  keyColumns: readonly string[];
  /** The counted column. Carries `CHECK (… >= 0)` in every instance. */
  amountColumn: string;
  /**
   * Columns a bump also (re)writes on both insert and conflict-update — the "last tap"
   * stamps. Absent when a bump moves nothing but the count.
   */
  touchColumns?: readonly string[];
}

/** The key values beside `profile_id` and `date`, positional to `spec.keyColumns`. */
export type DayCounterKey = readonly (string | number)[];

/** The five statements the discipline is made of. Pure text, from constants only. */
export interface DayCounterSql {
  /** Additive upsert: create the coordinate's row or add to it. */
  upsert: string;
  /** Clamped, guarded decrement. */
  decrement: string;
  /** Drop-at-zero. */
  drop: string;
  /** The authoritative re-read. */
  select: string;
  /** Add to an EXISTING row only (the undo give-back's first arm). */
  incrementExisting: string;
}

/** `profile_id = ? AND date = ?` plus one clause per key column. */
function whereClause(spec: DayCounterSpec): string {
  return [
    "profile_id = ?",
    "date = ?",
    ...spec.keyColumns.map((c) => `${c} = ?`),
  ].join(" AND ");
}

/**
 * The SQL one day counter's discipline compiles to. Pure, so the pure tier can assert
 * that every generated statement carries its guard, its clamp and its drop.
 */
export function dayCounterSql(spec: DayCounterSpec): DayCounterSql {
  const where = whereClause(spec);
  const touch = spec.touchColumns ?? [];
  const insertCols = [
    "profile_id",
    "date",
    ...spec.keyColumns,
    spec.amountColumn,
    ...touch,
  ];
  const conflictCols = ["profile_id", "date", ...spec.keyColumns].join(", ");
  return {
    // `excluded.<amount>` rather than a literal so one statement serves +1 (a serving,
    // a unit) and +N (grams), and so two concurrent taps compose rather than clobber.
    upsert:
      `INSERT INTO ${spec.table} (${insertCols.join(", ")}) ` +
      `VALUES (${insertCols.map(() => "?").join(", ")}) ` +
      `ON CONFLICT (${conflictCols}) DO UPDATE SET ` +
      [
        `${spec.amountColumn} = ${spec.amountColumn} + excluded.${spec.amountColumn}`,
        ...touch.map((c) => `${c} = excluded.${c}`),
      ].join(", "),
    // MAX(0, …) AND the `> 0` guard together: the clamp keeps the CHECK constraint
    // satisfied when an over-large unbump arrives, and the guard keeps the statement
    // from touching a row that is already spent. The drop runs either way, so a zero
    // row cannot survive an unbump whichever of the two did the work.
    decrement:
      `UPDATE ${spec.table} SET ${spec.amountColumn} = MAX(0, ${spec.amountColumn} - ?) ` +
      `WHERE ${where} AND ${spec.amountColumn} > 0`,
    drop: `DELETE FROM ${spec.table} WHERE ${where} AND ${spec.amountColumn} <= 0`,
    select: `SELECT ${spec.amountColumn} AS amount FROM ${spec.table} WHERE ${where}`,
    incrementExisting:
      `UPDATE ${spec.table} SET ${spec.amountColumn} = ${spec.amountColumn} + ? ` +
      `WHERE ${where}`,
  };
}

/**
 * The ledger spec implied by an undo `CounterSpec` (lib/undo-delete.ts, #2074), whose
 * `key` names the whole natural key beside `profile_id`. A DAY counter's key always
 * contains `date` — that is what makes it a day counter rather than a running total —
 * so this splits the date out and keeps the rest as the identity columns. Throws for a
 * key with no date, which would mean the undo registry declared something this ledger
 * cannot be; `lib/__tests__/day-counter-ledger.test.ts` asserts every declared counter
 * entity survives the conversion, so that throw is a test failure, never a runtime one.
 */
export function dayCounterSpecFor(
  table: string,
  amountColumn: string,
  key: readonly string[]
): DayCounterSpec {
  if (!key.includes("date"))
    throw new Error(
      `day counter ${table}.${amountColumn} has no date in its key: ${key.join(", ")}`
    );
  return {
    table,
    amountColumn,
    keyColumns: key.filter((c) => c !== "date"),
  };
}

// ── The declared counters ────────────────────────────────────────────────────
// One entry per day-counter table in the app. A new domain that needs a day counter
// adds an entry here and calls the ledger; it does not re-derive the four steps.

export const DAY_COUNTERS = {
  /**
   * Food-group servings (#579/#682). Alcohol rides this table deliberately (#1078), so
   * this is the general per-group day counter, not a nutrition-only one.
   */
  food: {
    table: "food_log",
    keyColumns: ["group_key"],
    amountColumn: "servings",
  },
  /** Non-food substance units — nicotine/cannabis (#1078). */
  substance: {
    table: "substance_log",
    keyColumns: ["substance"],
    amountColumn: "units",
    // A use re-stamps the day row's LAST tap instant, which is why the substance bump
    // carries a touch column and the other two do not.
    touchColumns: ["logged_at"],
  },
  /** Quick-add protein grams (#824) — one row per day, no identity column. */
  protein: {
    table: "protein_log",
    keyColumns: [],
    amountColumn: "grams",
  },
} as const satisfies Record<string, DayCounterSpec>;
