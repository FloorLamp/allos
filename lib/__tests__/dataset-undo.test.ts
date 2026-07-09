import { describe, it, expect } from "vitest";
import { DATASET_UNDO_KIND, undoKindForDataset } from "@/lib/dataset-undo";
import { UNDO_KINDS } from "@/lib/undo-delete";

// The DATASETS cross-check (each mapped key's table == the kind's ownedTable)
// lives in the db tier (lib/__db_tests__/dataset-undo.test.ts) because lib/export
// imports the SQLite `db`; this pure suite only checks the two pure registries.
describe("dataset → undo kind mapping", () => {
  it("maps only to real undo kinds whose root is the owned table", () => {
    for (const [datasetKey, kind] of Object.entries(DATASET_UNDO_KIND)) {
      expect(UNDO_KINDS[kind], `kind for ${datasetKey}`).toBeDefined();
      // The root entity's table is the owned table the capture ownership-checks.
      expect(UNDO_KINDS[kind].entities[0].table).toBe(
        UNDO_KINDS[kind].ownedTable
      );
    }
  });

  it("undoKindForDataset returns null for unmapped datasets", () => {
    expect(undoKindForDataset("immunizations")).toBeNull();
    expect(undoKindForDataset("goals")).toBeNull();
    expect(undoKindForDataset("nonexistent")).toBeNull();
    expect(undoKindForDataset("activities")).toBe("activity");
    expect(undoKindForDataset("supplements")).toBe("intake-item");
  });
});
