import { describe, it, expect } from "vitest";
import { DATASET_UNDO_KIND, undoKindForTable } from "@/lib/dataset-undo";
import { UNDO_KINDS } from "@/lib/undo-delete";

// The completeness guard is the TYPE SYSTEM since #2125 (a deletable undo root
// missing from DATASET_UNDO_KIND, or a mapping for a non-deletable root, is a
// compile error — see lib/dataset-undo.ts). This pure suite pins the halves types
// can't see; the DATASETS cross-check (each mapped table is a real, deletable
// dataset table) lives in the db tier (lib/__db_tests__/dataset-undo.test.ts)
// because lib/export imports the SQLite `db`.
describe("dataset table → undo kind mapping", () => {
  it("each mapped kind is rooted at exactly the table it is keyed by", () => {
    for (const [table, kind] of Object.entries(DATASET_UNDO_KIND)) {
      const spec = UNDO_KINDS[kind];
      expect(spec, `kind for ${table}`).toBeDefined();
      expect(spec.ownedTable, `root of ${kind}`).toBe(table);
      // The root entity's table is the owned table the capture ownership-checks.
      expect(spec.entities[0].table).toBe(spec.ownedTable);
    }
  });

  it("each mapped kind is 1:1 — it captures only the selected row and its FK-cascade children", () => {
    // A kind whose non-root entities are deleted EXPLICITLY (convention siblings,
    // e.g. wellness-practice's whole session family) or moved as a COUNTER
    // (food-serving's day-counter decrement) means something different from
    // "delete this row" — routing a bulk delete through it would change the
    // delete's semantics, not just make it reversible. Those kinds stay in
    // lib/dataset-undo.ts's argued exclusions instead.
    for (const [table, kind] of Object.entries(DATASET_UNDO_KIND)) {
      for (const entity of UNDO_KINDS[kind].entities.slice(1)) {
        expect(
          entity.deleteExplicitly ?? false,
          `${kind} (${table}) child ${entity.entity}`
        ).toBe(false);
        expect(
          entity.counter,
          `${kind} (${table}) child ${entity.entity}`
        ).toBeUndefined();
      }
    }
  });

  it("undoKindForTable answers by physical table and returns null for unmapped ones", () => {
    expect(undoKindForTable("immunizations")).toBeNull();
    expect(undoKindForTable("goals")).toBeNull();
    expect(undoKindForTable("nonexistent")).toBeNull();
    // The argued exclusions stay plain bulk deletes.
    expect(undoKindForTable("frequency_targets")).toBeNull();
    expect(undoKindForTable("food_log")).toBeNull();
    expect(undoKindForTable("food_log_events")).toBeNull();
    expect(undoKindForTable("activities")).toBe("activity");
    // The supplements dataset resolves through its physical table.
    expect(undoKindForTable("intake_items")).toBe("intake-item");
    expect(undoKindForTable("supplements")).toBeNull();
    // #2038's kinds, mapped by #2125.
    expect(undoKindForTable("practice_logs")).toBe("practice-session");
    expect(undoKindForTable("substance_log")).toBe("substance-history");
    // #2127: one period row, same single-entity shape.
    expect(undoKindForTable("cycles")).toBe("cycle");
  });
});
