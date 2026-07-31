import {
  getMedicalRecords,
  getDerivedBiomarkerReadings,
  getCanonicalAutocomplete,
  getPickerProviders,
} from "@/lib/queries";
import { today } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import MedicalFilters from "@/components/MedicalFilters";
import { parseSortDir } from "@/lib/table-sort";
import {
  filterDerivedForTable,
  prepareTableRecords,
  prepareMultiViewTableRecords,
  parseBiomarkerSortColumn,
} from "@/lib/derived-table";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import BioAgeHero from "@/components/BioAgeHero";
import TrajectoryFindings from "./TrajectoryFindings";
import BiomarkersTable from "@/components/BiomarkersTable";
import RecordForm from "@/components/RecordForm";
import AddEntryPanel from "@/components/AddEntryPanel";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import { CanonicalNamesProvider } from "@/components/CanonicalNamesContext";
import { addRecord } from "@/app/(app)/medical/actions";
import {
  BIOMARKER_CATEGORIES,
  NON_BIOMARKER_CATEGORIES,
} from "@/lib/medical-categories";
import { parsePanelId } from "@/lib/biomarker-panels";
import { reachablePanelIds } from "@/lib/biomarker-panel-reach";
import { PHONE_STACK } from "@/lib/phone-fold";

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
  // Prefill the add form's name from the command palette's "Add result" hit
  // action (#662). Reached as /results?new=1&name=<canonical>#biomarkers.
  name?: string;
  // The intent half of that deep link. Since #1499 section C the add form lives
  // behind "+ Add result", so an "I came here to add a reading" link has to say so:
  // `?new=1` (or a prefilled `?name=`) auto-expands the panel.
  new?: string;
}

// Does this visit want the entry panel OPEN on arrival? Only a deliberate
// add-a-reading deep link — the command palette's "Add result" hit and the
// medication-monitoring "log this lab" action both carry `new=1&name=<analyte>`.
// An ordinary read of the hub gets the collapsed affordance.
function entryPanelOpen(searchParams: BiomarkersSearchParams): boolean {
  return searchParams.new === "1" || !!searchParams.name?.trim();
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
  // `?panel=` is a normalized panel SLUG (#1502), validated against the closed
  // PanelId set: an unknown/legacy value (an old bookmark carrying the free-text
  // "Quest Diagnostics" the facet used to emit) is IGNORED rather than filtering
  // the table to nothing, and a typo can never fork a group.
  const panel = parsePanelId(searchParams.panel);
  const range =
    searchParams.range === "oor"
      ? ("oor" as const)
      : searchParams.range === "nonoptimal"
        ? ("nonoptimal" as const)
        : undefined;
  const q = searchParams.q?.trim() || undefined;
  // Default sort is NAME ascending, which orders readings of one analyte date
  // DESCENDING (medicalOrderBy's `name, date DESC, id DESC`) — newest first under
  // each heading. #1499 briefly defaulted to `panel` instead, for a reason that was
  // entirely a paging artifact: one bounded page (#114) held an alphabetical slice
  // scattered across a dozen panels, so each header counted the sliver of its panel
  // that landed there. #1581 dropped the page, so the groups are whole either way
  // and the ordering the reader can actually perceive — the order of names INSIDE an
  // expanded group — is what the default should serve.
  //
  // `panel` is deliberately NOT an offered sort column any more: grouping already
  // emits the panels in curated clinical order, so "sort by panel" reorders groups
  // that are no longer paged apart and does nothing visible. An old `?sort=panel`
  // bookmark falls back to `name` through parseSortColumn rather than failing.
  const sort = parseBiomarkerSortColumn(searchParams.sort);
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
  const canonicalOptions = getCanonicalAutocomplete(profileId);
  const now = today(profileId);

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <CanonicalNamesProvider names={canonicalOptions}>
        {/* DOM order is the unchanged #1499 section D order — the CURATED GLANCE
        first (the pinned analytes you chose, then what is moving, then the aging
        index), the panel-group index below it — and from `sm` up that is also what
        renders, because every slot's order resets there. Below `sm` the slots are
        re-ordered so the INDEX leads (#1647); the reasoning, and why caps alone
        could not get there, is in lib/phone-fold's PHONE_STACK. */}
        <div className={PHONE_STACK.container} data-testid="biomarkers-stack">
          <div className={PHONE_STACK.glance}>
            {/* Starred leads on desktop because it is the only part the reader
            authored. On a phone it is a surface you go TO, so it sits below the
            index — still whole, still one scroll, never behind a tap. */}
            <StarredBiomarkers />
          </div>

          {/* Forward-looking trajectory rules (#41), the ONE thing #1164 moved from the
          deleted Trends → Biomarkers tab: a "what's changing" area that warns BEFORE a
          single-value flag catches a range crossing. A full-history standing read, so
          it ignores the browser's filters. Renders nothing when no trajectory fires.
          It KEEPS its place above the index on a phone — it is the one card here that
          has to find the reader rather than be looked up — and pays for it by folding
          its rows at that width (#1647). */}
          <div className={PHONE_STACK.warning}>
            <TrajectoryFindings />
          </div>

          {/* Biological-age hero (#209): the derived PhenoAge index (#157) surfaced as a
          headline "how am I aging" result, pinned above the analyte table. Adult-
          gated; renders nothing for child profiles. The derived table row remains. */}
          <div className={PHONE_STACK.glance}>
            <BioAgeHero />
          </div>

          <div className={PHONE_STACK.index}>
            {/* The facet offers the taxonomy intersected with what this browser's
            category scope can actually surface (#1581 section D) — a STATIC
            derivation, so its contents stay stable while filters change. It travels
            WITH the table across the phone re-order: a control that filters a list
            has to stay attached to the list it filters. */}
            <MedicalFilters
              category={active}
              panel={panel}
              panels={reachablePanelIds()}
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
                filters={{
                  category: active,
                  panel,
                  range,
                  q,
                  sort,
                  dir,
                  current,
                }}
              />
            )}
          </div>

          {/* Entry behind "+ Add result" (#1499 section C — the #1497 rare-cadence
          rule). Lab readings arrive a few times a year, mostly by import; a standing
          form charged every read of the hub for it. `#add-result` stays on the
          wrapper so the palette / medication-monitoring deep links still land here,
          and they auto-expand it. */}
          <div className={PHONE_STACK.entry}>
            <AddEntryPanel
              id="add-result"
              testId="add-result-panel"
              panelId="add-result-panel-body"
              label="Add medical record"
              addLabel="Add result"
              defaultOpen={entryPanelOpen(searchParams)}
            >
              <RecordForm
                mode="add"
                action={addRecord}
                categories={BIOMARKER_CATEGORIES}
                defaultDate={now}
                defaultCategory={active ?? "lab"}
                defaultName={searchParams.name?.trim() || undefined}
              />
            </AddEntryPanel>
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
  // a deterministic merge. Subject identity is stamped onto the merged rows.
  const records = prepareMultiViewTableRecords(storedTagged, derivedTagged, {
    sort,
    dir,
    current,
  });
  const rows = stampSubjects(scope, records);
  // The add form + canonical autocomplete + relative-age clock are acting-scoped.
  const canonicalOptions = getCanonicalAutocomplete(scope.actingProfileId);
  const now = today(scope.actingProfileId);

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <CanonicalNamesProvider names={canonicalOptions}>
        {/* The same four phone slots as single view (#1647) — a caregiver on a phone
        reads the index first for the same reason, and one member's stars must not
        push it further down than another's. N starred cards share ONE glance slot, so
        their relative order (and the whole card list's position) is unchanged. */}
        <div className={PHONE_STACK.container} data-testid="biomarkers-stack">
          {/* Starred lens is per profile — one labeled card per member (each renders
          nothing when that member has no stars). Ordered ahead of the trajectory
          rollup and the bio-age hero, matching single view (#1499 section D). */}
          <div className={PHONE_STACK.glance}>
            {scope.profiles
              .filter((p) => ids.includes(p.id))
              .map((p) => (
                <StarredBiomarkers
                  key={p.id}
                  profileId={p.id}
                  subjectLabel={p.name}
                />
              ))}
          </div>

          {/* Personal "you" surfaces stay acting-only in multi-view. */}
          <div className={PHONE_STACK.warning}>
            <TrajectoryFindings />
          </div>
          <div className={PHONE_STACK.glance}>
            <BioAgeHero />
          </div>

          <div className={PHONE_STACK.index}>
            {/* The facet offers the taxonomy intersected with what this browser's
            category scope can actually surface (#1581 section D) — a STATIC
            derivation, so its contents stay stable while filters change. */}
            <MedicalFilters
              category={active}
              panel={panel}
              panels={reachablePanelIds()}
              range={range}
              q={q}
              current={current}
            />

            {records.length === 0 ? (
              <EmptyState
                message={
                  active || panel || range || q || current
                    ? "No records match these filters."
                    : "No records yet for these profiles. Import documents from the Data page (Data → Import), or add one below."
                }
              />
            ) : (
              <BiomarkersTable
                records={rows}
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
              />
            )}
          </div>

          {/* Entry behind "+ Add result" (#1499 section C), acting-scoped as before. */}
          <div className={PHONE_STACK.entry}>
            <AddEntryPanel
              id="add-result"
              testId="add-result-panel"
              panelId="add-result-panel-body"
              label="Add medical record"
              addLabel="Add result"
              defaultOpen={entryPanelOpen(searchParams)}
            >
              <RecordForm
                mode="add"
                action={addRecord}
                categories={BIOMARKER_CATEGORIES}
                defaultDate={now}
                defaultCategory={active ?? "lab"}
                defaultName={searchParams.name?.trim() || undefined}
              />
            </AddEntryPanel>
          </div>
        </div>
      </CanonicalNamesProvider>
    </ProviderOptionsProvider>
  );
}
