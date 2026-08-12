// The Trends → Overview → body census overview layout mode (#1067 Phase 2). Shared by the page (URL
// parse), the toggle control, and BodySection (visibility classes) so the three
// agree on the three-state responsive default.
//
//   undefined → TILES on mobile, the classic STACK on desktop.
//   "tiles"   → tiles on every viewport.
//   "all"     → still TILES on mobile; the classic STACK on desktop.
//
// Mobile deliberately has no layout choice at any range (#2152): the full stack
// duplicates the tiles as a very long page, while each tile already links to its
// focused metric detail. A `?view=all` URL silently remains tiles on a phone because
// viewport safety outranks the persisted desktop presentation.
// Both layouts remain server-rendered (one gather feeds both, #221); CSS enforces
// the viewport rule without client JS or viewport sniffing.

export type BodyView = "tiles" | "all" | undefined;

export function parseBodyView(v: string | undefined): BodyView {
  return v === "tiles" || v === "all" ? v : undefined;
}

// Visibility class for the TILE grid container.
export function tilesContainerClass(view: BodyView): string {
  if (view === "tiles") return "";
  return "md:hidden"; // "all" and the default still show tiles on mobile
}

// Visibility class for the classic CHART-STACK container (desktop only).
export function stackContainerClass(view: BodyView): string {
  if (view === "tiles") return "hidden";
  return "hidden md:block";
}
