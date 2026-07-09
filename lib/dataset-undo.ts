// Which Data → Manage datasets route their bulk delete through the undo machinery
// (issue #29 + #30). Pure map from a dataset key (lib/export DATASETS) to an
// undoable kind (lib/undo-delete UNDO_KINDS), so a bulk delete of those rows can
// capture each one and be restored from a single "Deleted N · Undo" toast.
//
// Only the four datasets whose table is an undoable ROOT are listed here; every
// other deletable dataset (immunizations, goals, allergies, conditions,
// encounters, metric_samples) has no undo kind and keeps the plain bulk delete.
// A pure test (lib/__tests__/dataset-undo.test.ts) asserts each mapped kind
// exists and that the two sides agree on the underlying table.

export const DATASET_UNDO_KIND: Record<string, string> = {
  activities: "activity",
  body_metrics: "body-metric",
  medical_records: "biomarker-record",
  supplements: "intake-item",
};

// The undoable kind for a dataset key, or null when its bulk delete is not
// reversible.
export function undoKindForDataset(datasetKey: string): string | null {
  return DATASET_UNDO_KIND[datasetKey] ?? null;
}
