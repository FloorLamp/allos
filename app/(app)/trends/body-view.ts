// The Trends → Body overview layout mode (#1067 Phase 2). Shared by the page (URL
// parse), the toggle control, and BodySection (visibility classes) so the three
// agree on the three-state responsive default.
//
//   undefined → responsive default: TILES on mobile, the classic STACK on desktop.
//   "tiles"   → tiles pinned on every viewport.
//   "all"     → the classic full-chart stack pinned on every viewport.
//
// Both layouts are rendered server-side (one gather feeds both, #221); these classes
// only toggle which is visible — no client JS, no viewport sniffing.

export type BodyView = "tiles" | "all" | undefined;

export function parseBodyView(v: string | undefined): BodyView {
  return v === "tiles" || v === "all" ? v : undefined;
}

// Visibility class for the TILE grid container.
export function tilesContainerClass(view: BodyView): string {
  if (view === "all") return "hidden";
  if (view === "tiles") return "";
  return "md:hidden"; // responsive default: mobile only
}

// Visibility class for the classic CHART-STACK container (chips + charts + history).
export function stackContainerClass(view: BodyView): string {
  if (view === "tiles") return "hidden";
  if (view === "all") return "";
  return "hidden md:block"; // responsive default: desktop only
}
