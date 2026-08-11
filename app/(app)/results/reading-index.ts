// What the Readings browser READS, separated from what it renders.
//
// Two callers need the identical row set from the identical URL: the section that
// renders the index on arrival, and the server action that loads one panel's
// readings when the reader expands it (#1651). If they gathered independently, an
// expansion could show a different set than the header it came from counted — so the
// URL parsing, the stored+derived merge and the panel grouping all live here, once,
// and both callers go through them.
//
// Auth is NOT here. Every function takes an already-resolved ProfileScope; the page
// and the action each resolve it at their own request boundary.

import {
  getClinicalObservations,
  getDerivedBiomarkerReadings,
} from "@/lib/queries";
import {
  filterDerivedForTable,
  prepareTableObservations,
  prepareMultiViewTableObservations,
  parseBiomarkerSortColumn,
  biomarkerRowKey,
  type BiomarkerSortColumn,
} from "@/lib/derived-table";
import { parseSortDir } from "@/lib/table-sort";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import { NON_BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import { listedInBiomarkerBrowser } from "@/lib/trend-metric-analytes";
import { parsePanelId, type PanelId } from "@/lib/biomarker-panels";
import {
  groupRowsByPanel,
  type PanelGroup,
} from "@/lib/biomarker-panel-groups";
import { tablePanelId } from "@/lib/derived-table";
import type { SortDirection } from "@/lib/queries/medical";
import type { ClinicalObservation } from "@/lib/types";
import type { SubjectInfo } from "@/lib/scope";
import { judgeObservations } from "@/lib/queries/metric-judgment";
import {
  referenceCell,
  type ReferenceCell,
} from "@/lib/reading-reference-cell";

// The query params the Readings section consumes. They ride the canonical
// `/results/readings` URL; the other Results sections ignore them.
export interface ReadingsSearchParams {
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

// The parsed, validated filter set — what the URL actually MEANS to the browser.
export interface BiomarkerFilters {
  category?: string;
  panel?: PanelId;
  range?: "oor" | "nonoptimal";
  q?: string;
  sort: BiomarkerSortColumn;
  dir: SortDirection;
  current: boolean;
}

// A table row in multi-view carries its owning profile + stamped subject identity;
// single-view rows omit both.
export type ReadingTableObservation = ClinicalObservation & {
  profileId?: number;
  subject?: SubjectInfo;
  // What the row's Reference cell says (#2315): the band(s) its FLAG came from,
  // resolved server-side through the one judgement lookup, or the lab's printed
  // string relabelled when nothing canonical covers the analyte. Resolved here so
  // the page render and the expand-a-panel action can never state different bands
  // for the same reading. Absent on a derived index (its Reference cell is
  // structurally absent — see the table).
  referenceCell?: ReferenceCell;
};

// Parse the shared browser filters/sort off the searchParams once — identical for
// the single- and multi-view paths (a filter matches ANY member's rows), and
// identical for the page and the expand-a-panel action. Kept as one helper so no two
// of them can disagree about what the URL means.
export function parseReadingFilters(
  searchParams: ReadingsSearchParams
): BiomarkerFilters {
  // Prescriptions are medications and don't belong in the Readings browser —
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

// Is this scope a MULTI-profile read? The one place the question is asked, so the
// gather, the grouping identity and the table's subject column can never disagree.
export function isMultiView(scope: ProfileScope): boolean {
  return scope.viewIds.length > 1;
}

// Every row the browser would render for this scope + URL, in the active sort order.
//
// SINGLE view reads the acting profile's stored + derived readings. MULTI view is a
// MERGE of per-member partitions: each member's rows are gathered in ITS OWN profile
// context (per-member dedup/is_latest in SQL, per-member derived flags resolved
// against that member's sex/age/reproductive status), tagged with their profileId,
// then merged with is_latest recomputed PER (profile, family) — a family collapse can
// never cross members — and subject-stamped (#534) for the leading chip column.
export function readingIndexRows(
  scope: ProfileScope,
  filters: BiomarkerFilters
): ReadingTableObservation[] {
  const { category, panel, range, q, sort, dir, current } = filters;
  const storedFilters = {
    category,
    excludeCategories: NON_BIOMARKER_CATEGORIES,
    panel,
    range,
    q,
    sort,
    dir,
    current,
  };
  // Read-time derived clinical indices (Non-HDL, the cholesterol ratios, HOMA-IR,
  // eGFR — issues #40/#1582) are folded in as read-only virtual rows, filtered by the
  // same active filters and sorted/marked-latest over the combined set so they behave
  // like stored analytes.
  const derivedFilters = {
    category,
    excludeCategories: NON_BIOMARKER_CATEGORIES,
    panel,
    range,
    q,
  };

  if (!isMultiView(scope)) {
    const profileId = scope.actingProfileId;
    return withReferenceCells(
      scope,
      prepareTableObservations(
        listedRows(getClinicalObservations(profileId, storedFilters)),
        filterDerivedForTable(
          getDerivedBiomarkerReadings(profileId),
          derivedFilters
        ),
        { sort, dir, current }
      )
    );
  }

  const ids = scope.viewIds;
  const storedTagged = readForProfiles(ids, (id) =>
    listedRows(getClinicalObservations(id, storedFilters))
  );
  const derivedTagged = readForProfiles(ids, (id) =>
    filterDerivedForTable(getDerivedBiomarkerReadings(id), derivedFilters)
  );
  const merged = prepareMultiViewTableObservations(
    storedTagged,
    derivedTagged,
    {
      sort,
      dir,
      current,
    }
  );
  return withReferenceCells(scope, stampSubjects(scope, merged));
}

// Drop the rows whose analyte already has a body-metric home (#2365) — a `vitals`
// reading of a quantity that owns a `/trends/metric/<slug>` chart. The exclusion is
// PER ANALYTE, derived from the metric registries rather than hand-listed, so the
// domain vitals that have no other surface (audiogram thresholds, intraocular
// pressure, visual acuity, periodontal depth, the functional-fitness markers) stay
// exactly where #1076 left them.
//
// It runs in JS rather than as a `category NOT IN (…)` clause because the question is
// about the analyte's NAME, matched on the normalized token key SQL cannot compute —
// and it runs BEFORE prepareTableObservations, so a dropped analyte never counts toward a
// panel header or claims an is_latest marker. Grouping is per analyte family, so
// removing one leaves every other analyte's rows and markers untouched.
const listedRows = (rows: ClinicalObservation[]): ClinicalObservation[] =>
  rows.filter(listedInBiomarkerBrowser);

// Resolve every stored row's Reference cell (#2315) — the bands the row's own flag
// was derived from, or the lab's printed string relabelled when nothing canonical
// covers the analyte.
//
// Rows are partitioned by OWNING profile before they are judged: an age band, a
// reproductive status and a cycle log all belong to one data subject, so a
// multi-view page must never judge one member's reading against another's context.
// A DERIVED index is skipped — its Reference cell is structurally absent (it is
// computed, not measured, and the table renders that column as a placeholder).
function withReferenceCells(
  scope: ProfileScope,
  rows: ReadingTableObservation[]
): ReadingTableObservation[] {
  const byProfile = new Map<number, number[]>();
  rows.forEach((r, i) => {
    if (r.derived) return;
    const pid = r.profileId ?? scope.actingProfileId;
    const bucket = byProfile.get(pid);
    if (bucket) bucket.push(i);
    else byProfile.set(pid, [i]);
  });
  const out = rows.slice();
  for (const [pid, indexes] of byProfile) {
    const judgments = judgeObservations(
      pid,
      indexes.map((i) => rows[i])
    );
    indexes.forEach((rowIndex, k) => {
      const r = rows[rowIndex];
      out[rowIndex] = {
        ...r,
        referenceCell: referenceCell({
          judgment: judgments[k],
          printed: r.reference_range,
          unit: r.unit,
        }),
      };
    });
  }
  return out;
}

// Partition those rows into panel groups. The analyte identity is the table's OWN
// row key, so a header's count and the name headings its expansion draws are one
// computation in either view.
export function biomarkerPanelGroups(
  rows: ReadingTableObservation[],
  multiView: boolean
): PanelGroup<ReadingTableObservation>[] {
  return groupRowsByPanel(rows, (r) => biomarkerRowKey(r, multiView));
}

// One panel's readings out of an already-gathered row set — what the expand-a-panel
// action returns. Uses the SAME panel resolver groupRowsByPanel partitions on, over
// rows already in the active sort order, so the rows a group reveals are exactly the
// rows its header counted.
export function biomarkerPanelRows(
  rows: ReadingTableObservation[],
  panel: PanelId
): ReadingTableObservation[] {
  return rows.filter((r) => tablePanelId(r) === panel);
}
