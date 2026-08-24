// The complete set of border-only layouts a rolling-summary cell may return.
// Keeping the strings in a closed registry lets the delegated-gutter guard
// exhaust the helper without interpreting a class expression (#3507).
export const PERIOD_ITEM_BORDER_CLASSES = {
  first: "",
  stackStart: "border-black/10 dark:border-white/10 border-t",
  rowSibling: "border-black/10 dark:border-white/10 border-t sm:border-l",
  firstRowSibling:
    "border-black/10 dark:border-white/10 border-t sm:border-l sm:border-t-0",
  desktopRowSibling:
    "border-black/10 dark:border-white/10 border-t sm:border-l xl:border-l-0",
  desktopFirstRowSibling:
    "border-black/10 dark:border-white/10 border-t sm:border-l sm:border-t-0 xl:border-l-0 xl:border-t",
} as const;

// The complete set of responsive grid layouts used by PeriodStatsCard. Both
// layout helpers sit between the delegated card and its gutter-owning cells,
// so neither may grow a padding class behind an unchanged call site (#3507).
export const PERIOD_GRID_COLUMN_CLASSES = {
  one: "sm:grid-cols-1",
  two: "sm:grid-cols-2",
  three: "sm:grid-cols-3",
  four: "sm:grid-cols-2",
  fallback: "sm:grid-cols-3",
  desktopOne: "xl:grid-cols-1 sm:grid-cols-1",
  desktopTwo: "xl:grid-cols-1 sm:grid-cols-2",
  desktopThree: "xl:grid-cols-1 sm:grid-cols-3",
  desktopFour: "xl:grid-cols-1 sm:grid-cols-2",
  desktopFallback: "xl:grid-cols-1 sm:grid-cols-3",
} as const;

export function periodGridColumns(
  statCount: number,
  desktopSidebar: boolean
): string {
  const suffix =
    statCount === 1
      ? "One"
      : statCount === 2
        ? "Two"
        : statCount === 3
          ? "Three"
          : statCount === 4
            ? "Four"
            : "Fallback";
  const key = desktopSidebar
    ? `desktop${suffix}`
    : `${suffix[0].toLowerCase()}${suffix.slice(1)}`;
  return PERIOD_GRID_COLUMN_CLASSES[
    key as keyof typeof PERIOD_GRID_COLUMN_CLASSES
  ];
}

// How many `sm` columns the rolling-summary grid resolves to. Four windows use
// a 2×2 grid; smaller sets stay in one row.
export function periodGridCols(statCount: number): number {
  return statCount === 4 ? 2 : Math.max(1, statCount);
}

// Pick the registered separators for this cell: phone top rules, `sm` left/top
// edges, then top-only edges when the desktop sidebar restacks at `xl`.
export function periodItemBorders(
  index: number,
  cols: number,
  desktopSidebar: boolean
): string {
  if (index === 0) return PERIOD_ITEM_BORDER_CLASSES.first;
  const startsRow = index % cols === 0;
  if (startsRow) return PERIOD_ITEM_BORDER_CLASSES.stackStart;
  if (index < cols) {
    return desktopSidebar
      ? PERIOD_ITEM_BORDER_CLASSES.desktopFirstRowSibling
      : PERIOD_ITEM_BORDER_CLASSES.firstRowSibling;
  }
  return desktopSidebar
    ? PERIOD_ITEM_BORDER_CLASSES.desktopRowSibling
    : PERIOD_ITEM_BORDER_CLASSES.rowSibling;
}
