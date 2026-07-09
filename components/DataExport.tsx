import { DATASETS } from "@/lib/export";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import DataTableManager from "@/components/DataTableManager";

// Datasets tied to the age-gated fitness surfaces (Activities, Goals); hidden
// here for restricted profiles to match the rest of the UI (see lib/age-gate.ts).
const RESTRICTED_DATASETS = new Set(["activities", "goals"]);

// Data → Manage tab: one card per dataset with a row count, a CSV download, and
// a paginated table. Each card has an edit mode (in DataTableManager) for
// selecting and deleting rows. The CSV download always contains every row.
export default function DataExport() {
  const { profile } = requireSession();
  const datasets = isTrainingRestricted(profile.id)
    ? DATASETS.filter((ds) => !RESTRICTED_DATASETS.has(ds.key))
    : DATASETS;
  return (
    <div className="space-y-6">
      {datasets.map((ds) => (
        <DataTableManager
          key={ds.key}
          dataset={{
            key: ds.key,
            label: ds.label,
            columns: ds.columns,
            // Undefined defaults to deletable (the original six datasets).
            deletable: ds.deletable !== false,
          }}
          rows={ds.rows(profile.id)}
        />
      ))}
    </div>
  );
}
