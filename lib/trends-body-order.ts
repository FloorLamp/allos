// Relevance ordering for the Trends → Body tab's synced-metric charts (#1067).
//
// The Body tab used to render its ~8 synced daily charts (steps, sleep, HR, BMI,
// lean/bone mass, BMR, hydration, calories, macros) in a FIXED order, so a metric
// you actually track daily (HR, sleep) could sit far down a long single-column
// stack. This applies the app's gating idiom to SEQUENCE instead of visibility:
// charts WITH data float ahead of the fixed order, most-recently-updated first.
//
// The predicate is ONE thing (issue #221 flavor): a chartless metric is filtered
// out here entirely, and BOTH the chart card AND its sticky jump chip are rendered
// from this same visible list — so a chip can never point at an absent chart, and
// a present chart can never lack its chip.

export interface BodyChartDescriptor {
  // Stable in-page anchor id (`/trends?tab=body#<id>`) — also the jump-chip target.
  id: string;
  // Short label for the jump chip.
  label: string;
  // Has-data gate: false ⇒ the metric renders nothing and its chip hides with it.
  present: boolean;
  // Most-recent data point's date (YYYY-MM-DD) for the recency sort; null when a
  // present entry carries no single dated tail (sorts after any dated entry).
  latestDate: string | null;
  // Fixed base order (the historical sequence), used only to break recency ties.
  order: number;
}

// Filter to present charts and sort by relevance: most-recent first, ties broken
// by the fixed base order. A null latestDate sorts after every dated entry (a
// present-but-undated chart still shows, just not jumped to the top by recency).
export function orderBodyCharts<T extends BodyChartDescriptor>(
  entries: readonly T[]
): T[] {
  return entries
    .filter((e) => e.present)
    .slice()
    .sort((a, b) => {
      const ra = a.latestDate ?? "";
      const rb = b.latestDate ?? "";
      if (ra !== rb) return ra < rb ? 1 : -1; // later date first; "" (null) last
      return a.order - b.order;
    });
}
