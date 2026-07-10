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
  paginateRecords,
} from "@/lib/derived-table";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import BioAgeHero from "@/components/BioAgeHero";
import BiomarkersTable from "@/components/BiomarkersTable";
import RecordForm from "@/components/RecordForm";
import ProviderDatalist from "@/components/ProviderDatalist";
import { addRecord } from "@/app/(app)/medical/actions";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";

export const dynamic = "force-dynamic";

export default async function BiomarkersPage(props: {
  searchParams: Promise<{
    category?: string;
    panel?: string;
    range?: string;
    q?: string;
    sort?: string;
    dir?: string;
    current?: string;
    p?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
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
  // Ship only ONE page to the client BiomarkersTable so the RSC payload stays
  // bounded as lab history grows (#114) — the full deduped list is built above in
  // one pass, then sliced here by the `?p=` page (clamped to a real page).
  const pageData = paginateRecords(records, Number(searchParams.p));
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

      {/* Biological-age hero (#209): the derived PhenoAge index (#157) surfaced as a
          headline "how am I aging" result, pinned above the analyte table. Adult-
          gated; renders nothing for child profiles. The derived table row remains. */}
      <BioAgeHero />

      <StarredBiomarkers />

      <MedicalFilters
        category={active}
        panel={panel}
        range={range}
        q={q}
        current={current}
      />

      {pageData.total === 0 ? (
        <EmptyState
          message={
            active || panel || range || q || current
              ? "No records match these filters."
              : "No records yet. Import documents from the Data page (Data → Import), or add one below."
          }
        />
      ) : (
        <BiomarkersTable
          records={pageData.rows}
          now={now}
          filters={{ category: active, panel, range, q, sort, dir, current }}
          pagination={{
            total: pageData.total,
            page: pageData.page,
            pageCount: pageData.pageCount,
            pageSize: pageData.pageSize,
          }}
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
