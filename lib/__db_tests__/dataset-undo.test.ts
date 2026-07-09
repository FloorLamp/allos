// DB INTEGRATION TIER — the bulk-delete undo mapping stays consistent with the
// real DATASETS registry (which imports the SQLite `db`, so this can't run in the
// pure suite). Asserts every dataset key that opts into undoable bulk delete
// exists, is deletable, and shares its table with the mapped undo kind's root.

import { describe, it, expect } from "vitest";
import { DATASET_UNDO_KIND } from "@/lib/dataset-undo";
import { UNDO_KINDS } from "@/lib/undo-delete";
import { DATASETS } from "@/lib/export";

describe("DATASET_UNDO_KIND ↔ DATASETS", () => {
  it("maps existing, deletable datasets to a kind on the same table", () => {
    for (const [datasetKey, kind] of Object.entries(DATASET_UNDO_KIND)) {
      const ds = DATASETS.find((d) => d.key === datasetKey);
      expect(ds, `dataset ${datasetKey} exists`).toBeDefined();
      expect(ds!.deletable).not.toBe(false);
      expect(ds!.table).toBe(UNDO_KINDS[kind].ownedTable);
    }
  });
});
