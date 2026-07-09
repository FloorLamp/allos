import {
  getMedicalRecords,
  getDerivedBiomarkerReadings,
  getCanonicalAutocomplete,
  getProviderNames,
} from "@/lib/queries";
import { today } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { PageHeader, EmptyState } from "@/components/ui";
import MedicalFilters from "@/components/MedicalFilters";
import { parseSortColumn, parseSortDir } from "@/lib/table-sort";
import {
  filterDerivedForTable,
  prepareTableRecords,
} from "@/lib/derived-table";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import BiomarkersTable from "@/components/BiomarkersTable";
import RecordForm from "@/components/RecordForm";
import ProviderDatalist from "@/components/ProviderDatalist";
import { addRecord } from "@/app/(app)/medical/actions";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";

export const dynamic = "force-dynamic";

export default function BiomarkersPage({
  searchParams,
}: {
  searchParams: {
    category?: string;
    panel?: string;
    range?: string;
    q?: string;
    sort?: string;
    dir?: string;
    current?: string;
  };
}) {
  const { profile } = requireSession();
  // Prescriptions are medications and don't belong in the Biomarkers browser —
  // they live on the document detail view and Supplements & Meds. So they're never
  // a valid `?category=` here, never listed (excludeCategories below), and never
  // an add-form / filter option (BIOMARKER_CATEGORIES).
  const active = BIOMARKER_CATEGORIES.includes(searchParams.category as never)
    ? searchParams.category
    : undefined;
  const panel = searchParams.panel?.trim() || undefined;
  const range =
    searchParams.range === "oor"
      ? "oor"
      : searchParams.range === "nonoptimal"
        ? "nonoptimal"
        : undefined;
  const q = searchParams.q?.trim() || undefined;
  const sort = parseSortColumn(
    searchParams.sort,
    ["name", "panel", "date"] as const,
    "name"
  );
  const dir = parseSortDir(searchParams.dir);
  const current = searchParams.current === "1";
  const storedRecords = getMedicalRecords(profile.id, {
    category: active,
    excludeCategories: ["prescription"],
    panel,
    range,
    q,
    sort,
    dir,
    current,
  });
  // Read-time derived clinical indices (Non-HDL, TG/HDL, HOMA-IR, eGFR — issue #40)
  // are folded in as read-only virtual rows, filtered by the same active filters and
  // sorted/marked-latest over the combined set so they behave like stored analytes.
  const derivedRecords = filterDerivedForTable(
    getDerivedBiomarkerReadings(profile.id),
    { category: active, excludeCategories: ["prescription"], panel, range, q }
  );
  const records = prepareTableRecords(storedRecords, derivedRecords, {
    sort,
    dir,
    current,
  });
  const canonicalOptions = getCanonicalAutocomplete(profile.id);
  const now = today(profile.id);

  return (
    <div>
      <PageHeader
        title="Biomarkers"
        subtitle="Explore your results, track each biomarker over time, and star the ones you watch."
      />

      {/* Shared datalists for the record forms' autocomplete inputs: canonical
          names for the canonical-name field, and the provider registry for the
          inline editor's "Performed by" field (mirrors the document view). */}
      <datalist id="canonical-names">
        {canonicalOptions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <ProviderDatalist names={getProviderNames()} />

      <StarredBiomarkers />

      <MedicalFilters
        category={active}
        panel={panel}
        range={range}
        q={q}
        current={current}
      />

      {records.length === 0 ? (
        <EmptyState
          message={
            active || panel || range || q || current
              ? "No records match these filters."
              : "No records yet. Import documents from the Data page (Data → Import), or add one below."
          }
        />
      ) : (
        <BiomarkersTable
          records={records}
          now={now}
          filters={{ category: active, panel, range, q, sort, dir, current }}
        />
      )}

      <div className="card mb-6">
        <h2 className="mb-4 font-semibold text-slate-800 dark:text-slate-100">
          Add medical record
        </h2>
        <RecordForm
          mode="add"
          action={addRecord}
          categories={BIOMARKER_CATEGORIES}
          defaultDate={now}
          defaultCategory={active ?? "lab"}
        />
      </div>
    </div>
  );
}
