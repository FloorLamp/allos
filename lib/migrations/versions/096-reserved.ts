import type { Migration } from "../runner";

// Migration 096 — RESERVED SLOT (deliberate no-op). Slots 096/097 were allocated
// to a concurrently-developed branch while this branch (#1078/#1085, whose schema
// change is migration 098) was in flight; the runner requires 1-based CONTIGUOUS
// ids (assertContiguousIds), so the reservation is realized as a no-op rather
// than a gap. Merge-order resolution, decided up front:
//   • if the reserving branch lands FIRST, this file is DELETED from the not-yet-
//     shipped branch before merge and its real 096 takes the slot (append-only
//     applies to migrations shipped on main, not to an open branch);
//   • if THIS branch lands first, the file ships as a permanent no-op (a DB
//     stamps through it instantly) and the other branch renumbers to the next
//     free slot — an id, once shipped, is never reused.
export function up(): void {
  // Intentionally empty.
}

export const migration: Migration = {
  id: 96,
  name: "096-reserved",
  up,
};
