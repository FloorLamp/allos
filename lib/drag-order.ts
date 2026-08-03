// The ONE list computation behind every drag-reorder in the app (issue #1485 C).
//
// Reorder had grown two languages: DashboardGrid's drag handles (the established
// one) and the Trends Overview tiles' per-tile up/down arrows. C converges them on
// drag, and the rule that makes "one reorder language" true below the UI is that
// both consumers move ids through the SAME pure function — the drag mechanics are
// shared in components/SortableOrder.tsx, and the list math is here.
//
// It is deliberately id-based rather than index-based: a drag reports the id it
// picked up and the id it was dropped over, and an index derived from a stale
// render (a revalidation landing mid-drag, a tile that left the window) would move
// the wrong row. An id that is not in the list is simply a no-op.

// How the OTHER items lay themselves out while one is held (#1891). The shared
// wrapper hard-coded dnd-kit's rect strategy; a single-column list wants the
// vertical one, so the choice became a `SortableOrder` prop and its vocabulary
// lives here, beside the list math, where a pure caller can name it without
// importing a client component.
export type ReorderStrategy = "rect" | "vertical";

// Move `activeId` to `overId`'s slot, shifting everything between them — the
// standard sortable semantics (dnd-kit's arrayMove), expressed over the ids so the
// caller never has to hold indices.
//
// No-ops, all of which a real drag can produce: dropping an item on itself,
// dropping outside any sortable (the caller passes a null `overId`), and either id
// being absent from the list.
export function reorderIds(
  ids: readonly string[],
  activeId: string,
  overId: string | null
): string[] {
  const out = [...ids];
  if (!overId || activeId === overId) return out;
  const from = out.indexOf(activeId);
  const to = out.indexOf(overId);
  if (from < 0 || to < 0) return out;
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}
