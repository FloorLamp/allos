// Which Data → Manage bulk deletes route through the undo machinery (issues
// #29/#30, completed at this surface by #2125). Pure map from a dataset's
// physical TABLE (lib/export DATASETS / DELETE_POLICY) to the undoable kind
// (lib/undo-delete UNDO_KINDS) whose root is that table, so a bulk delete of
// those rows captures each one and is restorable from a single
// "Deleted N · Undo" toast.
//
// The completeness guard is the TYPE, not a test (#2125, owner ruling): the keys
// below are `satisfies`-checked against the set of undo-kind root tables that are
// deletable datasets, both directions —
//   • an UNDO_KINDS entry whose root table is a deletable dataset compiles only
//     once it is mapped here or argued into EXCLUDED_UNDO_ROOTS, and
//   • a mapping for a non-deletable or non-undoable table is an excess-key error —
// so the next #2038-style kind cannot silently reopen the two-contracts hole
// (bulk delete permanent, row delete restorable, same rows). Each VALUE is
// checked to be a kind actually rooted at its key table.
//
// What the types cannot see — that a deletable dataset KEY is the same string as
// its physical table (except `supplements` → intake_items), and that a mapped
// kind captures ONLY its root row plus FK-cascade children (a 1:1 delete, safe to
// run per selected row) — is pinned by lib/__tests__/dataset-undo.test.ts and
// lib/__db_tests__/dataset-undo.test.ts.

import type { UndoKind, UndoKindRegistry } from "./undo-delete";
import type { DeletableDatasetKey } from "./export"; // type-only: no db import

type UndoRootTable = UndoKindRegistry[UndoKind]["ownedTable"];

// Deletable dataset keys read as physical tables (the one key/table divergence is
// `supplements`, whose table is intake_items — pinned at runtime by the db-tier
// test beside this module).
type DeletableDatasetTable =
  Exclude<DeletableDatasetKey, "supplements"> | "intake_items";

// Undo-kind root tables whose rows are bulk-deletable on Data → Manage — the set
// the mapping below must decide about.
type DeletableUndoRoot = Extract<UndoRootTable, DeletableDatasetTable>;

// Argued exclusions: undoable roots whose kinds are NOT 1:1 with one selected row,
// so routing the dataset's bulk delete through them would change what the delete
// MEANS, not just make it reversible. Extract<> keeps this honest — a name that
// stops being a deletable undo root drops out (and its Record key becomes
// required again), so a stale exclusion cannot linger.
//   • frequency_targets — its kind ("wellness-practice") deletes the practice's
//     WHOLE name-family: every session and its suppression row. Bulk-deleting
//     target rows must not wipe session history.
//   • food_log — its kind ("substance-alcohol-history") captures and deletes the
//     day's alcohol tap events beside the selected day row, and only speaks
//     alcohol; the dataset holds every food group.
//   • food_log_events — its kind ("food-serving") is one serving = ledger row +
//     a DECREMENT of the food_log day counter. The dataset's documented contract
//     (lib/export.ts) is "clear the timing layer, counters untouched"; mapping it
//     would silently turn that into a servings decrement across a second dataset.
type ExcludedUndoRoot = Extract<
  DeletableUndoRoot,
  "frequency_targets" | "food_log" | "food_log_events"
>;

// For a root table, the undo kinds actually rooted there — so a mapping cannot
// name a kind whose ownedTable is a different table.
type KindsRootedAt<T extends UndoRootTable> = {
  [K in UndoKind]: UndoKindRegistry[K]["ownedTable"] extends T ? K : never;
}[UndoKind];

export const DATASET_UNDO_KIND = {
  activities: "activity",
  body_metrics: "body-metric",
  medical_records: "biomarker-record",
  intake_items: "intake-item",
  // #2038's 1:1 kinds, mapped by #2125 so the bulk surface matches the row menu.
  // practice_logs deliberately takes "practice-session" (one row), never
  // "wellness-practice-history" (which drags every same-practice sibling along).
  practice_logs: "practice-session",
  substance_log: "substance-history",
  // #2127: one period row, no children — the row-menu delete and the dataset's bulk
  // delete now speak the same restorable kind (the very hole the type guard exists
  // to keep closed: an undoable root that is a deletable dataset must be decided).
  cycles: "cycle",
  // #1847's clinical kinds. All three are 1:1 (the root row plus, for allergies, its
  // ON DELETE CASCADE `allergy_reactions`), so bulk-deleting N selected rows means
  // exactly N per-row deletes and the batch restores from one toast. Mapping them is
  // not optional here — they are deletable datasets AND undoable roots, which is the
  // decision this type forces. (`skin_lesions` is not a deletable dataset, so its kind
  // needs no entry; medical_documents is not an undoable root yet.)
  allergies: "allergy",
  conditions: "condition",
  immunizations: "immunization",
  // #1847's fifth clinical kind. Mapping it does more than make the bulk delete
  // reversible: the visit's inbound `encounter_id` detach moved into captureDelete, so
  // this is also the first time bulk-deleting a LINKED visit works at all (it used to
  // throw on the FK — the identical hole the `conditions` mapping closed).
  encounters: "visit",
  // #2123: the readings table's other two stores. Both are single profile-owned rows
  // with no children, so the bulk delete is N per-row deletes restorable from one toast
  // — the same treatment the row menu now gives them.
  metric_samples: "metric-sample",
  mood_logs: "mood-log",
  // #2124: one symptom-day. Its `photos` child is deleted EXPLICITLY only because SQLite
  // carries no ON DELETE on that FK — the rows are selected by the ROOT's own id and
  // remap to it on restore, so the delete still means exactly "this row and what hangs
  // off it" (see the 1:1 rule in lib/__tests__/dataset-undo.test.ts). As with visits,
  // mapping it also fixes the bulk path: a plain `DELETE FROM symptom_logs` threw on the
  // photo FK whenever the day carried one.
  symptom_logs: "symptom-day",
} as const satisfies {
  [T in Exclude<DeletableUndoRoot, ExcludedUndoRoot>]: KindsRootedAt<T>;
};

// The undoable kind for a dataset's physical table, or null when its bulk delete
// is not reversible.
export function undoKindForTable(table: string): UndoKind | null {
  return (
    (DATASET_UNDO_KIND as Record<string, UndoKind | undefined>)[table] ?? null
  );
}
