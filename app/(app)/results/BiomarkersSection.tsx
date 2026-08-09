import { getPickerProviders, getRankedBiomarkerOptions } from "@/lib/queries";
import { today } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import MedicalFilters from "@/components/MedicalFilters";
import { type ProfileScope } from "@/lib/scope";
import StarredBiomarkers from "@/components/StarredBiomarkers";
import BioAgeInputsCard from "./BioAgeInputsCard";
import TrajectoryFindings from "./TrajectoryFindings";
import BiomarkersTable from "@/components/BiomarkersTable";
import TableSortSelect from "@/components/TableSortSelect";
import {
  BIOMARKER_SORT_CHOICES,
  DEFAULT_BIOMARKER_SORT,
} from "@/lib/derived-table";
import RecordForm from "@/components/RecordForm";
import AddEntryPanel from "@/components/AddEntryPanel";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import { CanonicalNamesProvider } from "@/components/CanonicalNamesContext";
import { addRecord } from "@/app/(app)/medical/actions";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import { reachablePanelIds } from "@/lib/biomarker-panel-reach";
import { PHONE_STACK } from "@/lib/phone-fold";
import { biomarkerAddHref, dataSectionHref } from "@/lib/hrefs";
import {
  boundPanelGroups,
  defaultOpenPanels,
} from "@/lib/biomarker-panel-groups";
import {
  biomarkerIndexRows,
  biomarkerPanelGroups,
  isMultiView,
  parseBiomarkerFilters,
  type BiomarkersSearchParams,
} from "./biomarker-index";

export type { BiomarkersSearchParams };

// Does this visit want the entry panel OPEN on arrival? Only a deliberate
// add-a-reading deep link — the command palette's "Add result" hit and the
// medication-monitoring "log this lab" action both carry `new=1&name=<analyte>`.
// An ordinary read of the hub gets the collapsed affordance.
function entryPanelOpen(searchParams: BiomarkersSearchParams): boolean {
  return searchParams.new === "1" || !!searchParams.name?.trim();
}

// The Biomarkers browser (#1042 phase 5 → #1331 multi-view). It reads the scope's
// stored + derived readings through the shared gather (./biomarker-index), groups
// them into the panel index HERE on the server, and hands the client table a BOUNDED
// payload (#1651): whole-panel header facts for every group, but readings only for
// the groups that arrive expanded, capped. Expanding a group asks for its readings
// then, through loadBiomarkerPanelRows.
//
// SINGLE vs MULTI view is one dimension of the same render, not two components:
// multi-view adds the leading subject column, per-member grouping and per-row write
// targeting, and gives each member in view its own starred card. The personal "you"
// surfaces — the add form, the bio-age hero, the trajectory rules — stay acting-scoped
// in both, because they write to / summarize the acting profile.
export default function BiomarkersSection({
  scope,
  searchParams,
}: {
  scope: ProfileScope;
  searchParams: BiomarkersSearchParams;
}) {
  const filters = parseBiomarkerFilters(searchParams);
  const { category: active, panel, range, q, current } = filters;
  const multi = isMultiView(scope);
  const rows = biomarkerIndexRows(scope, filters);
  const groups = biomarkerPanelGroups(rows, multi);
  // Which groups start expanded is a SERVER decision (search/facet/short list), and
  // it decides the payload: an expanded group ships readings, a collapsed one ships
  // none. One computation, not a client re-derivation over rows already sent.
  const initialOpen = defaultOpenPanels(groups, filters);
  const panelGroups = boundPanelGroups(groups, initialOpen);
  // The add form + canonical autocomplete + relative-age clock are acting-scoped.
  const now = today(scope.actingProfileId);
  // #1675: relevance-ranked, not alphabetical — a retest-due or flagged analyte leads
  // the canonical-name picker instead of whatever starts with "A".
  const canonicalOptions = getRankedBiomarkerOptions(
    scope.actingProfileId,
    now
  );
  const ids = scope.viewIds;
  const openEntryPanel = entryPanelOpen(searchParams);

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <CanonicalNamesProvider options={canonicalOptions}>
        {/* DOM order is the unchanged #1499 section D order — the CURATED GLANCE
        first (the pinned analytes you chose, then what is moving, then the aging
        index), the panel-group index below it — and from `sm` up that is also what
        renders, because every slot's order resets there. Below `sm` the slots are
        re-ordered so the INDEX leads (#1647); the reasoning, and why caps alone
        could not get there, is in lib/phone-fold's PHONE_STACK. */}
        <div className={PHONE_STACK.container} data-testid="biomarkers-stack">
          {/* Starred leads on desktop because it is the only part the reader
          authored. On a phone it is a surface you go TO, so it sits below the
          index — still whole, still one scroll, never behind a tap. In multi-view the
          lens is per profile: one labeled card per member (each renders nothing when
          that member has no stars), so N cards share this ONE glance slot and the
          stack's shape is unchanged. */}
          <div className={PHONE_STACK.glance}>
            {multi ? (
              scope.profiles
                .filter((p) => ids.includes(p.id))
                .map((p) => (
                  <StarredBiomarkers
                    key={p.id}
                    profileId={p.id}
                    subjectLabel={p.name}
                  />
                ))
            ) : (
              <StarredBiomarkers />
            )}
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

          {/* Biological-age INPUTS (#209 → split by #2367): which of the nine PhenoAge
          analytes this profile has, which it still needs, and a link to the headline
          result on Longevity — the hero itself renders on exactly one page, and the
          catalog half of it belongs on the page where the missing analytes are added.
          Adult-gated; renders nothing for child profiles. */}
          <div className={PHONE_STACK.glance}>
            <BioAgeInputsCard />
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
              // The card-mode sort control (#1426) travels with the facets since
              // #2316: below `sm` "narrow this list" and "reorder this list" are one
              // job behind one disclosure, instead of two strips of chrome stacked
              // above the first reading. Offered only when there is something to
              // order — the empty state has no rows to sort.
              sortControl={
                panelGroups.length > 0 ? (
                  <TableSortSelect
                    choices={BIOMARKER_SORT_CHOICES}
                    defaultSort={DEFAULT_BIOMARKER_SORT}
                    label="Sort by"
                  />
                ) : undefined
              }
              action={
                <AddEntryPanel
                  // A same-route ?new=1 Link preserves this client component. Change
                  // its identity only when route intent changes so defaultOpen is
                  // deliberately re-applied without making the modal controlled.
                  key={openEntryPanel ? "route-add-intent" : "browse-intent"}
                  id="add-result"
                  testId="add-result-panel"
                  panelId="add-result-panel-body"
                  label="Add medical record"
                  addLabel="Add result"
                  defaultOpen={openEntryPanel}
                  presentation="modal"
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
              }
            />

            {panelGroups.length === 0 ? (
              <EmptyState
                message={
                  active || panel || range || q || current
                    ? "No records match these filters."
                    : multi
                      ? "No results yet for these profiles. Add one manually or import a document."
                      : "No results yet. Add one manually or import a document."
                }
                actions={
                  active || panel || range || q || current
                    ? undefined
                    : [
                        { href: biomarkerAddHref(), label: "Add result" },
                        {
                          href: dataSectionHref("import"),
                          label: "Import records",
                        },
                      ]
                }
              />
            ) : (
              <BiomarkersTable
                panelGroups={panelGroups}
                initialOpen={initialOpen}
                now={now}
                searchParams={searchParams}
                filters={filters}
                multiView={
                  multi ? { actingProfileId: scope.actingProfileId } : undefined
                }
              />
            )}
          </div>
        </div>
      </CanonicalNamesProvider>
    </ProviderOptionsProvider>
  );
}
