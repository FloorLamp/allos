import { IconDownload, IconFileExport } from "@tabler/icons-react";
import { DATASETS, PAGE_SIZE } from "@/lib/export";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import DataTableManager from "@/components/DataTableManager";

// Datasets tied to the age-gated fitness surfaces (Activities, Goals); hidden
// here for restricted profiles to match the rest of the UI (see lib/age-gate.ts).
const RESTRICTED_DATASETS = new Set(["activities", "goals"]);

function firstParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

// Data → Manage tab: one card per dataset with a row count, a CSV download, and
// a paginated table. Each card has an edit mode (in DataTableManager) for
// selecting and deleting rows. The CSV download always contains every row.
//
// Issue #113: each table reads only the current page (LIMIT/OFFSET) plus a
// COUNT(*) for the pager — NOT the whole dataset. Page position is per-dataset in
// the URL (`p_<key>`), so a visit ships ~25 rows/table instead of every row (the
// old path serialized 22.5 MB / 183k hr_minutes rows just to display 25).
export default async function DataExport({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { profile } = await requireSession();
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

      {datasets.map((ds) => {
        const total = ds.count(profile.id);
        const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
        // Per-dataset page position (`p_<key>`), 1-based, clamped to what exists.
        const requested = Number(firstParam(searchParams[`p_${ds.key}`]));
        const page =
          Number.isInteger(requested) && requested >= 1
            ? Math.min(requested, pageCount)
            : 1;
        const offset = (page - 1) * PAGE_SIZE;
        return (
          <DataTableManager
            key={ds.key}
            dataset={{
              key: ds.key,
              label: ds.label,
              columns: ds.columns,
              // Undefined defaults to deletable (the original six datasets).
              deletable: ds.deletable !== false,
            }}
            rows={total > 0 ? ds.page(profile.id, PAGE_SIZE, offset) : []}
            total={total}
            page={page}
            pageSize={PAGE_SIZE}
            pageParam={`p_${ds.key}`}
          />
        );
      })}
    </div>
  );
}
