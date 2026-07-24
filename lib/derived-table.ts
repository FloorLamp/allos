// Pure helpers for merging read-time DERIVED records (issue #40) into the
// Biomarkers table alongside the stored rows. The biomarkers page reads stored
// rows via the SQL getMedicalRecords (which applies its filters + ORDER BY in the
// database) and the derived virtual rows via getDerivedBiomarkerReadings; this
// module folds the two into one list the table renders, re-deriving the
// "current reading per biomarker" marker and the sort over the COMBINED set so a
// derived analyte groups, sorts, and flags-as-latest exactly like a stored one.
//
// Kept pure (no DB) so the merge/sort/latest logic is unit-tested in isolation.

import { isNonOptimal, isOutOfRange } from "./reference-range";
import { biomarkerFamily } from "./canonical-name";
import { latestByGroup } from "./latest-per-group";
import type { MedicalRecord } from "./types";
import type { MedicalSortColumn, SortDirection } from "./queries/medical";
import type { RangeFilter } from "./queries/medical";

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

// Case-insensitive compare (NOCASE-equivalent) for the name/panel sort keys.
function nocase(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

// Which derived rows survive the table's active filters — the JS mirror of the SQL
// WHERE getMedicalRecords applies to stored rows, so derived analytes honor the
// same category/panel/range/free-text filters. (The `current` filter is applied
// later, over the COMBINED set, by prepareTableRecords.) Derived rows are always
// category 'lab' with a null panel, so a category!=lab or any panel filter excludes
// them by construction.
export function filterDerivedForTable(
  derived: MedicalRecord[],
  filters: {
    category?: string;
    excludeCategories?: string[];
    panel?: string;
    range?: RangeFilter;
    q?: string;
  }
): MedicalRecord[] {
  const q = filters.q?.trim().toLowerCase();
  return derived.filter((r) => {
    if (filters.category && r.category !== filters.category) return false;
    if (filters.excludeCategories?.includes(r.category)) return false;
    if (filters.panel) return false; // derived rows carry no panel
    if (filters.range === "oor") {
      if (!isOutOfRange(r.flag)) return false;
    } else if (filters.range === "nonoptimal") {
      if (!(isOutOfRange(r.flag) || isNonOptimal(r.flag))) return false;
    }
    if (q) {
      // Include the canonical name (the row heading) alongside the raw name and
      // panel, mirroring the SQL search in getMedicalRecords so a derived row is
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
  sort: MedicalSortColumn | undefined,
  dir: SortDirection
): (a: MedicalRecord, b: MedicalRecord) => number {
  const d = dir === "desc" ? -1 : 1;
  const nameOf = (r: MedicalRecord) => tableNameKey(r);
  if (sort === "name") {
    return (a, b) =>
      d * nocase(nameOf(a), nameOf(b)) ||
      -nocase(a.date, b.date) || // date DESC
      b.id - a.id;
  }
  if (sort === "panel") {
    return (a, b) => {
      const pa = a.panel,
        pb = b.panel;
      if ((pa == null) !== (pb == null)) return pa == null ? 1 : -1; // nulls last
      if (pa != null && pb != null) {
        const c = d * nocase(pa, pb);
        if (c) return c;
      }
      return nocase(nameOf(a), nameOf(b)) || a.id - b.id;
    };
  }
  if (sort === "date") {
    return (a, b) =>
      d * nocase(a.date, b.date) || nocase(nameOf(a), nameOf(b)) || a.id - b.id;
  }
  // Fallback (no explicit sort): date DESC, id DESC — matches getMedicalRecords.
  return (a, b) => -nocase(a.date, b.date) || b.id - a.id;
}

// The id of the current (newest) reading per family group, over the COMBINED set.
// The ordering rule (newest date wins, id descending tie-break, mirroring the SQL
// LATEST_IDS_CTE `ORDER BY date DESC, id DESC`) lives in the shared latestByGroup
// helper (#944); this only supplies the biomarker-FAMILY grouping identity (#482).
// Derived ids are negative, so among same-date rows a stored (positive id) reading
// is preferred as "latest" over a derived one — a property of the shared id tie-break.
function latestIdByName(records: MedicalRecord[]): Map<string, number> {
  const best = latestByGroup(records, familyGroupKey);
  return new Map([...best].map(([k, r]) => [k, r.id]));
}

// Merge stored + derived rows into the final table list. Recomputes is_latest per
// name over the combined set (so a derived analyte's newest reading is flagged
// current and stale-badged like a stored one); when `current` is set, keeps only
// that current reading per name; then sorts by the active column to match the
// SQL-only ordering. Pure.
export function prepareTableRecords(
  stored: MedicalRecord[],
  derived: MedicalRecord[],
  opts: { sort?: MedicalSortColumn; dir?: SortDirection; current?: boolean }
): MedicalRecord[] {
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
// touches these functions: its path (getMedicalRecords → prepareTableRecords →
// paginateRecords) is unchanged and byte-identical; the multi-view path is
// structurally additive.

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
// BiomarkersTable keys groupContiguous on this in multi-view.
export function multiViewGroupKey(
  r: WithProfile<{ name: string; canonical_name: string | null }>
): string {
  return `${r.profileId}\u0000${tableNameKey(r)}`;
}

// Merge the per-member stored+derived partitions into the final multi-view table
// list. Recomputes is_latest per (profile, family) over the combined set (so a
// derived analyte's newest reading flags current within its OWN member, never
// against another's), applies the `current` filter over that per-member latest,
// then orders for a stable merged pagination: the active sort column first (the
// single-view comparator), then the SUBJECT dimension (profileId, id) as a final
// tie-break so the page order is deterministic even when two members' derived rows
// share a negative id. Pure — no DB, no auth. Rows keep their `profileId` tag so
// stampSubjects can attach subject identity for the chip.
export function prepareMultiViewTableRecords(
  stored: WithProfile<MedicalRecord>[],
  derived: WithProfile<MedicalRecord>[],
  opts: { sort?: MedicalSortColumn; dir?: SortDirection; current?: boolean }
): WithProfile<MedicalRecord>[] {
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
  const base = comparator(opts.sort, opts.dir ?? "asc");
  return filtered.sort(
    (a, b) => base(a, b) || a.profileId - b.profileId || a.id - b.id
  );
}

// How many biomarker rows the table ships (and renders) per page. The full
// content-deduped list is built server-side (prepareTableRecords over the single
// getMedicalRecords dedup pass), but only ONE page is serialized into the client
// BiomarkersTable — so the RSC payload is bounded regardless of lab history
// instead of shipping every deduped row (#114: 2,594 rows ≈ 2.97 MB unbounded).
export const BIOMARKER_PAGE_SIZE = 50;

export interface TablePage<T = MedicalRecord> {
  // The rows to render for the current page. Generic so the multi-view path can
  // paginate profile-tagged rows (WithProfile<MedicalRecord>) without losing the tag.
  rows: T[];
  // Total rows across all pages (for the "N of M" footer and pager math).
  total: number;
  // The resolved 1-based page (clamped into [1, pageCount]).
  page: number;
  pageCount: number;
  pageSize: number;
}

// Slice the already-built, already-sorted combined table list to one page.
// `page` is 1-based and may be any user-supplied value (from `?p=`); it's clamped
// into [1, pageCount] so an out-of-range or garbage value lands on a real page.
// Pure — no DB; this only bounds what the client component receives, not the DB
// read (the window-CTE dedup still runs once in getMedicalRecords). An empty list
// reads as page 1 of 1.
export function paginateRecords<T = MedicalRecord>(
  records: T[],
  page: number,
  pageSize: number = BIOMARKER_PAGE_SIZE
): TablePage<T> {
  const total = records.length;
  const count = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const clamped = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const current = Math.min(clamped, count);
  const start = (current - 1) * pageSize;
  return {
    rows: records.slice(start, start + pageSize),
    total,
    page: current,
    pageCount: count,
    pageSize,
  };
}
