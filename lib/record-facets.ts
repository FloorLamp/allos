// How many of the records browser's FACETS are set (issue #2316).
//
// Below `sm` the filter block collapses behind one **Filters** trigger, and the
// trigger has to say what it is hiding: a reader who cannot see the controls must
// still be able to tell a filtered view from an unfiltered one. This is that count
// — the non-default facets, which is also what decides whether the block arrives
// already open.
//
// The free-text search is deliberately NOT a facet here: it stays visible beside
// the trigger at every width (it is the fastest path to a named analyte), so it can
// never be a hidden filter and must not inflate a count about hidden ones.
//
// The filters arrive already normalized — the page's parser drops an unknown
// category, an unrecognized panel slug and a bogus `range` to `undefined` — so a
// truthy value here IS a deliberate non-default choice.
export interface RecordFacets {
  category?: string;
  panel?: string;
  range?: string;
  current?: boolean;
}

export function activeFacetCount(facets: RecordFacets): number {
  return [facets.category, facets.panel, facets.range, facets.current].filter(
    Boolean
  ).length;
}

// What the disclosure's trigger reads. The count is appended only when there is
// one, so an unfiltered view says plainly "Filters" instead of "Filters · 0".
export function filterTriggerLabel(count: number): string {
  return count > 0 ? `Filters · ${count}` : "Filters";
}
