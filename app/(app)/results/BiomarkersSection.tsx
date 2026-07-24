import {
  getMedicalRecords,
  getDerivedBiomarkerReadings,
  getCanonicalAutocomplete,
  getPickerProviders,
} from "@/lib/queries";
import { today } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import MedicalFilters from "@/components/MedicalFilters";
import { parseSortColumn, parseSortDir } from "@/lib/table-sort";
import {
  filterDerivedForTable,
  prepareTableRecords,
  prepareMultiViewTableRecords,
  paginateRecords,
} from "@/lib/derived-table";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import BioAgeHero from "@/components/BioAgeHero";
import TrajectoryFindings from "./TrajectoryFindings";
import BiomarkersTable from "@/components/BiomarkersTable";
import RecordForm from "@/components/RecordForm";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import { CanonicalNamesProvider } from "@/components/CanonicalNamesContext";
import { addRecord } from "@/app/(app)/medical/actions";
import {
  BIOMARKER_CATEGORIES,
  NON_BIOMARKER_CATEGORIES,
} from "@/lib/medical-categories";

// The query params the Biomarkers section consumes — the former /biomarkers index
// page's searchParams, unchanged (#1042 phase 5 moved the content, not the
// behavior). They ride the ONE /results URL; the other sections ignore them.
export interface BiomarkersSearchParams {
  category?: string;
  panel?: string;
  range?: string;
  q?: string;
  sort?: string;
  dir?: string;
  current?: string;
  p?: string;
  // Prefill the add form's name from the command palette's "Add result" hit
  // action (#662). Reached as /results?new=1&name=<canonical>#biomarkers.
  name?: string;
}

// Parse the shared browser filters/sort off the searchParams once — identical for
// the single- and multi-view paths (a filter matches ANY member's rows). Kept as
// one helper so the two paths can never disagree about what the URL means.
function parseFilters(searchParams: BiomarkersSearchParams) {
  // Prescriptions are medications and don't belong in the Biomarkers browser —
  // they live on the document detail view and Supplements & Meds. So they're never
  // a valid `?category=` here, never listed (excludeCategories below), and never
  // an add-form / filter option (BIOMARKER_CATEGORIES).
  const category = BIOMARKER_CATEGORIES.includes(searchParams.category as never)
    ? searchParams.category
    : undefined;
  const panel = searchParams.panel?.trim() || undefined;
  const range =
    searchParams.range === "oor"
      ? ("oor" as const)
      : searchParams.range === "nonoptimal"
        ? ("nonoptimal" as const)
        : undefined;
  const q = searchParams.q?.trim() || undefined;
  const sort = parseSortColumn(
    searchParams.sort,
    ["name", "panel", "date"] as const,
    "name"
  );
  const dir = parseSortDir(searchParams.dir);
  const current = searchParams.current === "1";
  return { category, panel, range, q, sort, dir, current };
}

// The Biomarkers browser (#1042 phase 5 → #1331 multi-view). In SINGLE view it
// reads the acting profile's stored + derived readings (below); in MULTI view it
// merges per-member partitions. The multi-view path is structurally additive — a
// single-profile view (`scope.viewIds.length === 1`) always takes the single-view
// branch, which renders byte-identical to the pre-#1331 component.
export default function BiomarkersSection({
  scope,
  searchParams,
}: {
  scope: ProfileScope;
  searchParams: BiomarkersSearchParams;
}) {
  return scope.viewIds.length > 1 ? (
    <MultiBiomarkersView scope={scope} searchParams={searchParams} />
  ) : (
    <SingleBiomarkersView
      profileId={scope.actingProfileId}
      searchParams={searchParams}
    />
  );
}

// The single-profile browser — the filterable analyte table + bio-age hero + starred
// tiles + add form. Byte-identical to the pre-#1331 body: one profile's stored +
// derived readings, deduped/is_latest per family in that one profile's SQL context.
function SingleBiomarkersView({
  profileId,
  searchParams,
}: {
  profileId: number;
  searchParams: BiomarkersSearchParams;
}) {
  const { category, panel, range, q, sort, dir, current } =
    parseFilters(searchParams);
  const active = category;
  const storedRecords = getMedicalRecords(profileId, {
    category: active,
    excludeCategories: NON_BIOMARKER_CATEGORIES,
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
    getDerivedBiomarkerReadings(profileId),
    {
      category: active,
      excludeCategories: NON_BIOMARKER_CATEGORIES,
      panel,
      range,
      q,
    }
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
  const canonicalOptions = getCanonicalAutocomplete(profileId);
  const now = today(profileId);

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <CanonicalNamesProvider names={canonicalOptions}>
        <div>
          {/* Forward-looking trajectory rules (#41), the ONE thing #1164 moved from the
          deleted Trends → Biomarkers tab: a "what's changing" area that warns BEFORE a
          single-value flag catches a range crossing. A full-history standing read, so
          it ignores the browser's filters. Renders nothing when no trajectory fires. */}
          <TrajectoryFindings />

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
              filters={{
                category: active,
                panel,
                range,
                q,
                sort,
                dir,
                current,
              }}
              pagination={{
                total: pageData.total,
                page: pageData.page,
                pageCount: pageData.pageCount,
                pageSize: pageData.pageSize,
              }}
            />
          )}

          <div className="card mb-6" id="add-result">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Add medical record
            </h2>
            <RecordForm
              mode="add"
              action={addRecord}
              categories={BIOMARKER_CATEGORIES}
              defaultDate={now}
              defaultCategory={active ?? "lab"}
              defaultName={searchParams.name?.trim() || undefined}
            />
          </div>
        </div>
      </CanonicalNamesProvider>
    </ProviderOptionsProvider>
  );
}

// The multi-profile browser (#1331). The results table is a MERGE of per-member
// partitions: each member's stored + derived readings are gathered in ITS OWN
// profile context (per-member dedup/is_latest in SQL, per-member derived flags
// resolved against that member's sex/age/reproductive status), tagged with their
// profileId, then merged with is_latest recomputed PER (profile, family) — a family
// collapse can never cross members. Rows are subject-stamped (#534) for the leading
// chip column, and every per-row edit/delete targets the row's OWN subject profile.
// Starred tiles stay per profile: one labeled card per member (its own stars, judged
// in its own demographic context). The add form + bio-age hero + trajectory rules
// stay acting-only — they write to / summarize the acting profile ("you").
function MultiBiomarkersView({
  scope,
  searchParams,
}: {
  scope: ProfileScope;
  searchParams: BiomarkersSearchParams;
}) {
  const { category, panel, range, q, sort, dir, current } =
    parseFilters(searchParams);
  const active = category;
  const ids = scope.viewIds;

  // Per-member gather (loop-composed, #1095/#1096): each getMedicalRecords /
  // getDerivedBiomarkerReadings runs in that member's own profile context, so
  // dedup / is_latest / flags / ranges never evaluate one member against another.
  const storedTagged = readForProfiles(ids, (id) =>
    getMedicalRecords(id, {
      category: active,
      excludeCategories: NON_BIOMARKER_CATEGORIES,
      panel,
      range,
      q,
      sort,
      dir,
      current,
    })
  );
  const derivedTagged = readForProfiles(ids, (id) =>
    filterDerivedForTable(getDerivedBiomarkerReadings(id), {
      category: active,
      excludeCategories: NON_BIOMARKER_CATEGORIES,
      panel,
      range,
      q,
    })
  );
  // Merge the partitions: is_latest recomputed per (profile, family), `current`
  // applied over that per-member latest, then ordered with the subject dimension for
  // stable pagination. Slice one page, then stamp subject identity onto the page.
  const records = prepareMultiViewTableRecords(storedTagged, derivedTagged, {
    sort,
    dir,
    current,
  });
  const pageData = paginateRecords(records, Number(searchParams.p));
  const pageRows = stampSubjects(scope, pageData.rows);
  // The add form + canonical autocomplete + relative-age clock are acting-scoped.
  const canonicalOptions = getCanonicalAutocomplete(scope.actingProfileId);
  const now = today(scope.actingProfileId);

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <CanonicalNamesProvider names={canonicalOptions}>
        <div>
          {/* Personal "you" surfaces stay acting-only in multi-view. */}
          <TrajectoryFindings />
          <BioAgeHero />

          {/* Starred lens is per profile — one labeled card per member (each renders
          nothing when that member has no stars). */}
          {scope.profiles
            .filter((p) => ids.includes(p.id))
            .map((p) => (
              <StarredBiomarkers
                key={p.id}
                profileId={p.id}
                subjectLabel={p.name}
              />
            ))}

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
                  : "No records yet for these profiles. Import documents from the Data page (Data → Import), or add one below."
              }
            />
          ) : (
            <BiomarkersTable
              records={pageRows}
              now={now}
              multiView={{ actingProfileId: scope.actingProfileId }}
              filters={{
                category: active,
                panel,
                range,
                q,
                sort,
                dir,
                current,
              }}
              pagination={{
                total: pageData.total,
                page: pageData.page,
                pageCount: pageData.pageCount,
                pageSize: pageData.pageSize,
              }}
            />
          )}

          <div className="card mb-6" id="add-result">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Add medical record
            </h2>
            <RecordForm
              mode="add"
              action={addRecord}
              categories={BIOMARKER_CATEGORIES}
              defaultDate={now}
              defaultCategory={active ?? "lab"}
              defaultName={searchParams.name?.trim() || undefined}
            />
          </div>
        </div>
      </CanonicalNamesProvider>
    </ProviderOptionsProvider>
  );
}
