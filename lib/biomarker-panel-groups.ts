// The Results › Biomarkers PANEL-GROUP model (issue #1499, section A). Pure — no
// DB, no auth, no React.
//
// WHY. The Biomarkers browser was the tallest page in the app (13.4k px at
// 390×844): the #1482 card mode faithfully renders the unbounded master list, one
// ~90px card per reading, so the first row landed 4.8k px down. A master list of
// analytes is a REFERENCE surface — you arrive knowing which one you want — so it
// wants an index, not a scroll. #1502 minted the normalized panel taxonomy; this
// module turns the flat list into that index: one collapsed header per clinical
// panel ("Lipids · 6 · 1 flagged"), tap to expand its readings.
//
// ONE COMPUTATION (AGENTS.md "one question, one computation"). The collapsed
// header's counts and the rows revealed when it expands are the SAME `PanelGroup`
// object — the header can't claim "6" while the expansion shows five. That is why
// `rows`, `analyteCount` and `flaggedCount` are fields of one value rather than
// three call sites re-deriving from `records`.
//
// PANEL IDENTITY is #1502's resolver, reached through `tablePanelId` — the SAME
// function the Panel cell, the `?panel=` facet and the panel sort already use, so a
// row can never group under one panel and label itself another. The stored
// `medical_records.panel` column is PROVENANCE (in practice the lab vendor) and is
// never a grouping key.
//
// ANALYTE IDENTITY is the caller's, passed in as `identity`. The table already owns
// one — `nameKey` in single view, `multiViewGroupKey` (profile, name) in multi-view
// (#1331) — and the count must agree with the name headings the expansion draws, so
// this takes it rather than inventing a second grouping.
//
// SCOPE. The groups describe the rows they are GIVEN, and since #1581 that is the
// WHOLE filtered set: the browser no longer pages. Readings are observations, not
// analytes (a 6-analyte lipid panel with 12 draws is 72 rows), so a row-denominated
// page could be smaller than a single panel — one panel then rendered on two pages
// with partial counts on each, and the header's "6" described the sliver that
// happened to land there. Ungrouped, the collapsed index is bounded by CONSTRUCTION
// instead: PANEL_IDS is a closed 35-entry taxonomy, so the header list can never
// exceed it however long a lab history grows. A header's counts are now the panel's,
// full stop, and they are still the same object the expansion draws from.

import {
  OTHER_PANEL,
  orderedPanelIds,
  panelLabel,
  type PanelId,
} from "./biomarker-panels";
import { tablePanelId } from "./derived-table";
import { isOutOfRange } from "./reference-range";

// The minimum a row must carry to be grouped: the name pair the panel resolver
// reads, plus the flag/latest markers the flagged summary counts.
export interface PanelGroupRow {
  name: string;
  canonical_name: string | null;
  flag?: string | null;
  is_latest?: number | null;
}

export interface PanelGroup<T> {
  panel: PanelId;
  // The #1502 display label ("Lipids", "Complete blood count"), never the stored
  // free-text heading.
  label: string;
  // The group's rows, in the caller's already-applied sort order (the partition is
  // STABLE, so the active `?sort=` still decides the order inside a group).
  rows: T[];
  // Distinct analytes in the group, by the caller's identity — the "6" in
  // "Lipids · 6 · 1 flagged". Not the row count: several readings of one analyte
  // are one analyte, exactly as the expansion draws one name heading for them.
  analyteCount: number;
  // Distinct analytes whose CURRENT reading (the row marked `is_latest`) is out of
  // range. Deliberately out-of-range only — the same verdict the `?range=oor` facet
  // and the value cell's flag use — so "flagged" means one thing app-wide. A
  // historical out-of-range reading whose latest is back in range is not a flag.
  flaggedCount: number;
}

// "Lipids · 6 · 1 flagged" — the collapsed header as ONE string. The card renders
// the parts with their own styling and uses this as the toggle's accessible name,
// so the visual and the screen-reader answer can't drift.
export function panelGroupSummary<T>(group: PanelGroup<T>): string {
  const analytes = `${group.analyteCount} analyte${group.analyteCount === 1 ? "" : "s"}`;
  return group.flaggedCount > 0
    ? `${group.label} · ${analytes} · ${group.flaggedCount} flagged`
    : `${group.label} · ${analytes}`;
}

/**
 * Partition already-sorted table rows into panel groups.
 *
 * Groups come back in `PANEL_LABELS` order with `other` last (the reserved bucket
 * for un-canonicalized readings — never dropped, always last by design). Rows keep
 * their relative order inside a group, so whatever `?sort=` the user chose still
 * decides what the expansion shows first. A panel with no rows yields no group.
 */
export function groupRowsByPanel<T extends PanelGroupRow>(
  rows: readonly T[],
  identity: (row: T) => string
): PanelGroup<T>[] {
  const buckets = new Map<PanelId, T[]>();
  for (const row of rows) {
    const id = tablePanelId(row);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }
  const groups: PanelGroup<T>[] = [];
  for (const panel of orderedPanelIds()) {
    const groupRows = buckets.get(panel);
    if (!groupRows || groupRows.length === 0) continue;
    const analytes = new Set<string>();
    const flagged = new Set<string>();
    for (const row of groupRows) {
      const key = identity(row);
      analytes.add(key);
      if (row.is_latest && isOutOfRange(row.flag ?? null)) flagged.add(key);
    }
    groups.push({
      panel,
      label: panelLabel(panel),
      rows: groupRows,
      analyteCount: analytes.size,
      flaggedCount: flagged.size,
    });
  }
  return groups;
}

// A result set at or below this many rows opens every group on arrival. A short
// list has nothing to index: collapsing three readings behind two headers hides the
// answer and reads as "no results" — the failure mode section A calls out for
// search. It also keeps a small spec-owned or new-user profile behaving like the
// flat list it effectively is.
//
// Since #1581 this counts the WHOLE filtered set rather than one 50-row page, which
// is the number the rule always meant: "is this person's result set short?", not "is
// this page short?". A page total could never answer that — a full page said
// "long" whether it was page 1 of 1 or 1 of 16 — so the threshold stays where it was
// and only its denominator became honest.
export const AUTO_OPEN_ROW_LIMIT = 12;

// The filters that mean "the user has already narrowed this to what they wanted" —
// every control in the browser's filter bar. `current` ("Current values only") joined
// them in #1581: it is the reader asking for their current picture, which is a request
// to see VALUES, and leaving it out was also the last way a filter change could
// re-collapse a group the reader had opened.
export interface PanelGroupFilters {
  q?: string;
  panel?: PanelId;
  range?: string;
  category?: string;
  current?: boolean;
}

/**
 * Which groups start EXPANDED.
 *
 * Three rules, all about not hiding an answer the user already asked for:
 *   1. A NARROWING filter is active — any control in the filter bar (`?q=` search,
 *      the `?panel=` facet, a range or category filter, "current values only").
 *      Every rendered row already matched it, so every group opens — "search expands
 *      matching groups". A search that hit inside a collapsed group must never look
 *      like no-results, and no filter change may collapse what the reader opened.
 *   2. The whole result set is short (≤ AUTO_OPEN_ROW_LIMIT). There is nothing to
 *      index, so the index would only cost a tap.
 *   3. There is only ONE group. An index of one entry is not an index — it is a
 *      lone header the reader must tap to reach the only thing behind it. Reachable
 *      since #1581 dropped the pager: a page used to hold one to four groups
 *      routinely, so "one group" said nothing about the data; over the whole set it
 *      means the profile really does have readings in a single panel.
 *
 * Otherwise nothing opens: the default view IS the index. The returned ids are the
 * INITIAL state only — once the reader has opened or closed a group, a re-render
 * must not yank it back (the #1455/#1517 disclosure convention).
 */
export function defaultOpenPanels<T>(
  groups: readonly PanelGroup<T>[],
  filters: PanelGroupFilters,
  rowLimit: number = AUTO_OPEN_ROW_LIMIT
): PanelId[] {
  const narrowed =
    !!filters.q?.trim() ||
    !!filters.panel ||
    !!filters.range ||
    !!filters.category ||
    !!filters.current;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (narrowed || groups.length <= 1 || total <= rowLimit)
    return groups.map((g) => g.panel);
  return [];
}

// True when a group holds at least one flagged analyte — the "flagged groups
// visually self-identify" predicate, named once so the header's amber treatment and
// any future surface agree on what earns it.
export function panelGroupIsFlagged<T>(group: PanelGroup<T>): boolean {
  return group.flaggedCount > 0;
}

// Re-exported for callers that need the reserved bucket's identity without
// importing the taxonomy directly (its rows are un-canonicalized readings, and the
// header copy names it "Other").
export { OTHER_PANEL };
