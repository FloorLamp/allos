// Pure helpers for merging read-time DERIVED records (issue #40) into the
// Biomarkers table alongside the stored rows. The biomarkers page reads stored
// rows via the SQL getClinicalObservations (which applies its filters + ORDER BY in the
// database) and the derived virtual rows via getDerivedBiomarkerReadings; this
// module folds the two into one list the table renders, re-deriving the
// "current reading per biomarker" marker and the sort over the COMBINED set so a
// derived analyte groups, sorts, and flags-as-latest exactly like a stored one.
//
// Kept pure (no DB) so the merge/sort/latest logic is unit-tested in isolation.

import { isNonOptimal, isOutOfRange } from "./reference-range";
import { biomarkerFamily } from "./canonical-name";
import {
  OTHER_PANEL,
  panelForCanonicalName,
  panelSortOrder,
  type PanelId,
} from "./biomarker-panels";
import { latestByGroup } from "./latest-per-group";
import { parseSortColumn } from "./table-sort";
import type { ClinicalObservation } from "./types";
import type {
  ClinicalObservationSortColumn,
  SortDirection,
} from "./queries/medical";
import type { RangeFilter } from "./queries/medical";

// ---- The Biomarkers browser's sort vocabulary (#1581 section B) --------------

// The sort columns the BROWSER offers. A strict subset of ClinicalObservationSortColumn: the
// query layer still knows how to order by `panel` (the document view's extracted-
// records table offers it, where rows are not panel-grouped), but the browser does
// not, because it partitions its rows into panel groups emitted in curated clinical
// order — "sort by panel" would reorder groups that no ordering can move, which is a
// control that does nothing a reader can perceive.
export const BIOMARKER_SORT_COLUMNS = ["name", "date"] as const;
export type BiomarkerSortColumn = (typeof BIOMARKER_SORT_COLUMNS)[number];

// The column ordered when the URL names none. `name` ascending, which orders the
// readings of one analyte date DESCENDING (medicalOrderBy's `name, date DESC`) —
// newest first under each heading.
export const DEFAULT_BIOMARKER_SORT: BiomarkerSortColumn = "name";

// The same two columns as the card-mode SELECT knows them (#1426): the ids the
// (hidden) SortableHeaders carry, with Date opening newest-first, so the header
// strip and the compact select can't disagree about what "sorted by date" means.
// Declared here rather than in the table because the select is rendered by the
// FILTER block now (#2316) and the headers by the table — one list, two surfaces.
export const BIOMARKER_SORT_CHOICES = [
  { column: "name", label: "Name" },
  { column: "date", label: "Date", defaultDir: "desc" as const },
] as const;

// Resolve a raw `?sort=` value for the browser. Anything unrecognized — including
// the `panel` an old #1499-era bookmark carries — falls back to the default rather
// than failing the parse.
export function parseBiomarkerSortColumn(
  raw: string | undefined
): BiomarkerSortColumn {
  return parseSortColumn(raw, BIOMARKER_SORT_COLUMNS, DEFAULT_BIOMARKER_SORT);
}

// Display identity: canonical name when present, else the raw name — mirrors
// biomarkerNameKey() in the SQL layer. Used for the VISIBLE name sort/heading.
export function tableNameKey(r: {
  name: string;
  canonical_name: string | null;
}): string {
  return r.canonical_name?.trim() || r.name;
}

// Grouping identity for is_latest/current — the #482 biomarker FAMILY, lowercased,
// mirroring the SQL biomarkerFamilyKey so a merged (stored + derived) row groups
// with its family kin exactly like the family-partitioned DB dedup/latest. Kept
// separate from tableNameKey: grouping collapses families, but the visible name
// sort still orders by the row's own display name.
function familyGroupKey(r: {
  name: string;
  canonical_name: string | null;
}): string {
  return biomarkerFamily(tableNameKey(r)).toLowerCase();
}

// The normalized panel a table row belongs to (#1502) — resolved from the row's
// display identity (canonical name, else the raw name), exactly like the SQL
// BIOMARKER_PANEL_KEY, so the merged stored+derived list filters and sorts by the
// same answer the SQL-only list does.
export function tablePanelId(r: {
  name: string;
  canonical_name: string | null;
}): PanelId {
  return panelForCanonicalName(tableNameKey(r));
}

// Case-insensitive compare (NOCASE-equivalent) for the name/panel sort keys.
function nocase(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

// Which derived rows survive the table's active filters — the JS mirror of the SQL
// WHERE getClinicalObservations applies to stored rows, so derived analytes honor the
// same category/panel/range/free-text filters. (The `current` filter is applied
// later, over the COMBINED set, by prepareTableObservations.) Derived rows are always
// category 'lab', so a category!=lab filter excludes them by construction. Their
// stored `panel` column is null, but since #1502 the panel is RESOLVED from the
// canonical name — so a derived index now honors the facet like any stored row
// (Non-HDL and TG/HDL are `lipids`, HOMA-IR `glycemic`, eGFR `kidney`), where the
// old "derived rows carry no panel" rule dropped them from every panel view.
export function filterDerivedForTable(
  derived: ClinicalObservation[],
  filters: {
    category?: string;
    excludeCategories?: string[];
    panel?: PanelId;
    range?: RangeFilter;
    q?: string;
  }
): ClinicalObservation[] {
  const q = filters.q?.trim().toLowerCase();
  return derived.filter((r) => {
    if (filters.category && r.category !== filters.category) return false;
    if (filters.excludeCategories?.includes(r.category)) return false;
    if (filters.panel && tablePanelId(r) !== filters.panel) return false;
    if (filters.range === "oor") {
      if (!isOutOfRange(r.flag)) return false;
    } else if (filters.range === "nonoptimal") {
      if (!(isOutOfRange(r.flag) || isNonOptimal(r.flag))) return false;
    }
    if (q) {
      // Include the canonical name (the row heading) alongside the raw name and
      // panel, mirroring the SQL search in getClinicalObservations so a derived row is
      // findable by the same identity it shows (#383).
      const hay =
        `${r.name} ${r.canonical_name ?? ""} ${r.panel ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Comparator matching medicalOrderBy() (lib/queries/medical) for the whitelisted
// sort columns, so the merged list orders identically to the SQL-only list. Every
// non-name sort tie-breaks on the name ascending then id, like the SQL.
function comparator(
  sort: ClinicalObservationSortColumn | undefined,
  dir: SortDirection
): (a: ClinicalObservation, b: ClinicalObservation) => number {
  const d = dir === "desc" ? -1 : 1;
  const nameOf = (r: ClinicalObservation) => tableNameKey(r);
  if (sort === "name") {
    return (a, b) =>
      d * nocase(nameOf(a), nameOf(b)) ||
      -nocase(a.date, b.date) || // date DESC
      b.id - a.id;
  }
  if (sort === "panel") {
    return (a, b) => {
      // Mirrors medicalOrderBy's `<panelKey> = 'other', <panelOrder> <dir>` —
      // curated clinical order, with the unresolved bucket last in BOTH
      // directions (the successor to the old "nulls last" rule).
      const oa = tablePanelId(a),
        ob = tablePanelId(b);
      if ((oa === OTHER_PANEL) !== (ob === OTHER_PANEL))
        return oa === OTHER_PANEL ? 1 : -1;
      const c = d * (panelSortOrder(oa) - panelSortOrder(ob));
      if (c) return c;
      return nocase(nameOf(a), nameOf(b)) || a.id - b.id;
    };
  }
  if (sort === "date") {
    return (a, b) =>
      d * nocase(a.date, b.date) || nocase(nameOf(a), nameOf(b)) || a.id - b.id;
  }
  // Fallback (no explicit sort): date DESC, id DESC — matches getClinicalObservations.
  return (a, b) => -nocase(a.date, b.date) || b.id - a.id;
}

// The id of the current (newest) reading per family group, over the COMBINED set.
// The ordering rule (newest date wins, id descending tie-break, mirroring the SQL
// LATEST_IDS_CTE `ORDER BY date DESC, id DESC`) lives in the shared latestByGroup
// helper (#944); this only supplies the biomarker-FAMILY grouping identity (#482).
// Derived ids are negative, so among same-date rows a stored (positive id) reading
// is preferred as "latest" over a derived one — a property of the shared id tie-break.
function latestIdByName(records: ClinicalObservation[]): Map<string, number> {
  const best = latestByGroup(records, familyGroupKey);
  return new Map([...best].map(([k, r]) => [k, r.id]));
}

// Merge stored + derived rows into the final table list. Recomputes is_latest per
// name over the combined set (so a derived analyte's newest reading is flagged
// current and stale-badged like a stored one); when `current` is set, keeps only
// that current reading per name; then sorts by the active column to match the
// SQL-only ordering. Pure.
export function prepareTableObservations(
  stored: ClinicalObservation[],
  derived: ClinicalObservation[],
  opts: {
    sort?: ClinicalObservationSortColumn;
    dir?: SortDirection;
    current?: boolean;
  }
): ClinicalObservation[] {
  const combined = [...stored, ...derived];
  const latest = latestIdByName(combined);
  const withLatest = combined.map((r) => ({
    ...r,
    is_latest: latest.get(familyGroupKey(r)) === r.id ? 1 : 0,
  }));
  const filtered = opts.current
    ? withLatest.filter((r) => r.is_latest === 1)
    : withLatest;
  return filtered.sort(comparator(opts.sort, opts.dir ?? "asc"));
}

// ── Multi-view (issue #1331) ──────────────────────────────────────────────────
//
// When several profiles are read into view, the Biomarkers table is a MERGE of
// PER-MEMBER partitions. The load-bearing invariant: is_latest / the `current`
// filter / the family dedup are recomputed PER (profile, family), NEVER across
// members — a family collapse must never merge two people's readings into one
// series (the per-profile-context trap the issue calls out). Single view never
// touches these functions: its path (getClinicalObservations → prepareTableObservations) is
// unchanged and byte-identical; the multi-view path is structurally additive.

export type WithProfile<T> = T & { profileId: number };

// The multi-view is_latest/dedup partition identity: (profileId, family). The
// family half is the SAME #482 identity familyGroupKey uses in single view, so
// within one member the grouping is byte-identical; the profileId prefix keeps
// every member's partition DISJOINT (a NUL separator can't appear in a numeric
// profileId or a lowercased family key), so no cross-member collapse is possible.
function mvFamilyKey(
  r: WithProfile<{ name: string; canonical_name: string | null }>
): string {
  return `${r.profileId}\u0000${familyGroupKey(r)}`;
}

// The multi-view DISPLAY grouping identity: (profileId, display name). Mirrors the
// single-view table's canonical-or-raw nameKey grouping but scoped per member, so
// two members' same-named rows land in DISTINCT contiguous groups (each keeps its
// own name heading + subject chip) instead of collapsing into one heading. The
// ReadingsTable keys groupContiguous on this in multi-view.
export function multiViewGroupKey(
  r: WithProfile<{ name: string; canonical_name: string | null }>
): string {
  return `${r.profileId}\u0000${tableNameKey(r)}`;
}

// The Biomarkers table's ANALYTE identity for a row, in either view: the display
// name alone in single view, (profile, display name) in multi-view so two members'
// same-named analytes stay in distinct groups. Named once because three call sites
// must agree on it — the SERVER's panel grouping (whose header counts are drawn from
// it), the client's run-grouping inside an expanded panel, and the analyte count the
// header publishes. A second spelling anywhere would let "Lipids · 6" disagree with
// the six name headings under it.
export function biomarkerRowKey(
  r: { name: string; canonical_name: string | null; profileId?: number },
  multiView: boolean
): string {
  return multiView && r.profileId != null
    ? multiViewGroupKey({ ...r, profileId: r.profileId })
    : tableNameKey(r);
}

// The multi-view comparator: the SUBJECT dimension (profileId) is woven in right
// AFTER the primary sort key and BEFORE its secondary tie-breaks, so a member's rows
// of the same analyte stay CONTIGUOUS (one heading + one chip per member) instead of
// interleaving with another member's rows of the same name — which happens if
// profileId is only a final tie-break (date-desc would slot the other member's
// reading between a member's two readings, splitting the group). Different analytes
// still interleave across members by the primary key; the trailing id keeps it stable.
function mvComparator(
  sort: ClinicalObservationSortColumn | undefined,
  dir: SortDirection
): (
  a: WithProfile<ClinicalObservation>,
  b: WithProfile<ClinicalObservation>
) => number {
  const d = dir === "desc" ? -1 : 1;
  const name = (r: ClinicalObservation) => tableNameKey(r);
  const subj = (
    a: WithProfile<ClinicalObservation>,
    b: WithProfile<ClinicalObservation>
  ) => a.profileId - b.profileId;
  if (sort === "panel") {
    return (a, b) => {
      const oa = tablePanelId(a),
        ob = tablePanelId(b);
      if ((oa === OTHER_PANEL) !== (ob === OTHER_PANEL))
        return oa === OTHER_PANEL ? 1 : -1;
      const c = d * (panelSortOrder(oa) - panelSortOrder(ob));
      if (c) return c;
      return subj(a, b) || nocase(name(a), name(b)) || a.id - b.id;
    };
  }
  if (sort === "date") {
    return (a, b) =>
      d * nocase(a.date, b.date) ||
      subj(a, b) ||
      nocase(name(a), name(b)) ||
      a.id - b.id;
  }
  // name sort (the default) + the no-sort fallback both order by name then subject.
  return (a, b) =>
    d * nocase(name(a), name(b)) ||
    subj(a, b) ||
    -nocase(a.date, b.date) || // date DESC within a member's analyte
    b.id - a.id;
}

// Merge the per-member stored+derived partitions into the final multi-view table
// list. Recomputes is_latest per (profile, family) over the combined set (so a
// derived analyte's newest reading flags current within its OWN member, never
// against another's), applies the `current` filter over that per-member latest, then
// orders with the subject dimension woven into the sort key (mvComparator) for a
// readable, deterministically ordered merge. Pure — no DB, no auth. Rows keep their
// `profileId` tag so stampSubjects can attach subject identity for the chip.
export function prepareMultiViewTableObservations(
  stored: WithProfile<ClinicalObservation>[],
  derived: WithProfile<ClinicalObservation>[],
  opts: {
    sort?: ClinicalObservationSortColumn;
    dir?: SortDirection;
    current?: boolean;
  }
): WithProfile<ClinicalObservation>[] {
  const combined = [...stored, ...derived];
  // latestByGroup keyed per (profile, family) — same ordering rule as single view
  // (newest date wins, id descending tie-break), isolated within each member.
  const best = latestByGroup(combined, mvFamilyKey);
  const latest = new Map([...best].map(([k, r]) => [k, r.id]));
  const withLatest = combined.map((r) => ({
    ...r,
    is_latest: latest.get(mvFamilyKey(r)) === r.id ? 1 : 0,
  }));
  const filtered = opts.current
    ? withLatest.filter((r) => r.is_latest === 1)
    : withLatest;
  return filtered.sort(mvComparator(opts.sort, opts.dir ?? "asc"));
}
