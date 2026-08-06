// DB INTEGRATION TIER — the bulk-delete undo mapping stays consistent with the
// real DATASETS registry (which imports the SQLite `db`, so this can't run in the
// pure suite). The completeness guard itself is the type system since #2125
// (lib/dataset-undo.ts); this suite pins the runtime facts the types stand on:
// every mapped table is a real, deletable dataset's physical table, and the
// dataset-key ⇄ table correspondence the DeletableDatasetTable alias assumes
// (key == table everywhere except supplements → intake_items) actually holds.

import { describe, it, expect } from "vitest";
import { DATASET_UNDO_KIND } from "@/lib/dataset-undo";
import { UNDO_KINDS } from "@/lib/undo-delete";
import { DATASETS, DELETE_POLICY } from "@/lib/export";

describe("DATASET_UNDO_KIND ↔ DATASETS", () => {
  it("maps physical tables of existing, deletable datasets to a kind on the same table", () => {
    for (const [table, kind] of Object.entries(DATASET_UNDO_KIND)) {
      const ds = DATASETS.find((d) => d.table === table);
      expect(ds, `dataset with table ${table} exists`).toBeDefined();
      expect(ds!.deletable).not.toBe(false);
      expect(ds!.key in DELETE_POLICY, `${ds!.key} is deletable`).toBe(true);
      expect(table).toBe(UNDO_KINDS[kind].ownedTable);
    }
  });

  it("every deletable dataset's key IS its table, except supplements → intake_items", () => {
    // lib/dataset-undo.ts translates DeletableDatasetKey (DELETE_POLICY keys) into
    // physical tables at the TYPE level with exactly this one special case; a new
    // dataset whose key diverges from its table must extend that alias too.
    for (const key of Object.keys(DELETE_POLICY)) {
      const ds = DATASETS.find((d) => d.key === key);
      expect(ds, `dataset ${key} exists`).toBeDefined();
      expect(ds!.table).toBe(key === "supplements" ? "intake_items" : key);
    }
  });
});
