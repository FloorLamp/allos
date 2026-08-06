// In-transaction read and compare-and-swap helpers (#2133, owner mechanism).
//
// A LIFECYCLE transition has the shape "read the current state, refuse or compare, then
// write with the expectation in the WHERE" — and every part of that must run inside ONE
// IMMEDIATE transaction, or the guard is theater (#2139's accept checked `pending`
// outside the transaction it accepted in). These helpers make that discipline a
// SIGNATURE FACT: they require the `Tx` token that only `writeTx` mints, so a compare
// that ran outside the transaction cannot typecheck.
//
// Deliberately thin:
//   • They take an already-prepared Statement, NOT a SQL string — the repo's static
//     SQL guards (profile scoping, the gated-table write scan) read each prepare
//     call's first argument out of the source, and SQL smuggled through a helper
//     would be invisible to both.
//   • They add nothing async. The token is evidence, not a handle; the
//     callback-synchronous `writeTx` contract is unchanged.
//   • They are for lifecycle transitions with an EXPECTATION. Genuinely additive writes
//     (a weight entry, a food serving) and cores that own their own accounting (the
//     day-counter ledger) do not need them and should not adopt them.

import type { Statement } from "better-sqlite3";
import type { Tx } from "./db";

// What a compare-and-swap actually did. `stale` means the WHERE's expectation no longer
// held when the UPDATE ran — the caller maps it to its domain's typed refusal
// ("already-accepted", "already-paused", …) rather than confirming a write it did not
// make.
export type CasOutcome =
  { kind: "applied"; changes: number } | { kind: "stale" };

// An in-transaction guard read. The token proves the read shares the transaction with
// the write it guards, so the row cannot change between the check and the swap.
export function readForUpdate<T>(
  _tx: Tx,
  stmt: Statement,
  ...params: unknown[]
): T | undefined {
  return stmt.get(...params) as T | undefined;
}

// The SET-shaped guard read (#2140): a whole-set rewrite (the active-situations
// machine) diffs the CURRENT set against the wanted one before writing, and that
// before-read is exactly as raceable outside the transaction as a single-row compare —
// the defect this file exists to make unwritable. Same contract as readForUpdate,
// returning every matching row.
export function readAllForUpdate<T>(
  _tx: Tx,
  stmt: Statement,
  ...params: unknown[]
): T[] {
  return stmt.all(...params) as T[];
}

// An in-transaction compare-and-swap: run an UPDATE (or DELETE) whose WHERE carries the
// expected prior state, and report whether it landed. `applied` carries the change
// count for set-shaped transitions (closing every open course); a single-row CAS treats
// anything but 1 as impossible-by-construction once `applied`.
export function casUpdate(
  _tx: Tx,
  stmt: Statement,
  ...params: unknown[]
): CasOutcome {
  const { changes } = stmt.run(...params);
  return changes > 0 ? { kind: "applied", changes } : { kind: "stale" };
}
