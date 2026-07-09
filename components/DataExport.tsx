import { IconDownload, IconFileExport } from "@tabler/icons-react";
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
      {/* Full-account export (issue #18): one portable bundle for this profile —
          every dataset (JSON + CSV), the clinical passport as a FHIR bundle, the
          profile's medical files, and a manifest. Plain GET download links (each
          route re-checks the session and scopes strictly to the active profile). */}
      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Export everything
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Take a complete, portable copy of {profile.name}&apos;s record — every
          dataset as JSON and CSV, uploaded medical files, and the clinical
          passport as a FHIR bundle, all in one zip.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href="/api/export/full"
            download
            data-testid="export-all-link"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
          >
            <IconDownload className="h-4 w-4" />
            Export all my data (.zip)
          </a>
          <a
            href="/api/export/fhir"
            download
            data-testid="export-fhir-link"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-brand-300 hover:text-brand-700 dark:border-slate-700 dark:text-slate-200 dark:hover:border-brand-800 dark:hover:text-brand-300"
          >
            <IconFileExport className="h-4 w-4" />
            Clinical passport (FHIR)
          </a>
        </div>
      </div>

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
