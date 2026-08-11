"use client";

import {
  createContext,
  useContext,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import SortableOrder from "@/components/SortableOrder";
import { useToast } from "@/components/Toast";
import { moveInOrder } from "@/lib/saved-items";
import { reorderSaved } from "@/app/(app)/saved-actions";

// The Trends Overview "★ Starred" grid, made DRAGGABLE (issue #1485 C).
//
// The tiles' order used to move only through a pair of up/down arrows in each
// tile's corner ⋯ menu — a SECOND reorder language beside DashboardGrid's
// established drag, for the same job. C converges them: a tile is lifted and
// dropped (press-and-hold on touch, a deliberate few pixels with a mouse) through
// the SHARED mechanism in components/SortableOrder.tsx that the dashboard also
// uses. The arrows survive inside the ⋯ menu as the non-pointer / AT fallback,
// which is exactly where the issue asks for them — not as always-visible chrome.
//
// ONE LIST, ONE WRITE. #2153 retires #1485 A's populated/empty split: every tile
// draws in its saved slot at uniform geometry, including an empty one. The arrows
// and drag therefore move the same complete list through the same pure step and
// persist. Position drawn = position meant.
//
// The tile CONTENT is server-rendered (TrendMiniCard is a Server Component that
// reads units, colours and reference ranges) and passed in as nodes — this file
// owns motion and order only, so a reorder costs no re-query and the tiles keep
// their server-side data.
export interface SavedTileItem {
  // The Trends series key ("metric:weight" | "bio:ApoB") — the drag id AND the
  // vocabulary the persist action speaks.
  key: string;
  // Whether this full-size tile has no reading in the window. It stays reorderable
  // in its saved slot; the flag only gives the empty state a quiet dim treatment.
  empty: boolean;
  node: ReactNode;
}

// What a tile's ⋯ menu needs to offer the non-pointer fallback: the reorderable
// order (so it knows whether this tile can move, and which way) and the one step
// function. Provided by the grid so the menu never re-derives an order of its own.
export interface TileReorder {
  keys: string[];
  move: (key: string, direction: "up" | "down") => void;
}

export const TileReorderContext = createContext<TileReorder | null>(null);

export function useTileReorder(): TileReorder | null {
  return useContext(TileReorderContext);
}

function SortableTile({ item }: { item: SavedTileItem }) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.key });
  // dnd-kit's `attributes` (role="button" + the activator aria-* set) are
  // deliberately NOT spread: the tile CONTAINS a link and a ⋯ menu button, and
  // wrapping that in a button role would misdescribe it to AT for the sake of a
  // keyboard path the ⋯ menu's Move earlier / Move later already provide. The
  // listeners alone give the pointer/touch lift.
  return (
    <div
      ref={setNodeRef}
      // TRANSLATE, not Transform (#1891). The rect strategy's transform carries
      // scaleX/scaleY as well, morphing the lifted item toward the dimensions of
      // the slot it is crossing. These tiles are uniform — a fixed number of equal
      // columns, and `h-full` makes every tile in a row share its height — so the
      // scale was ~1 and the distortion never showed here; it is the dashboard's
      // wildly-varying card heights that made it visible. Dropping the scale is
      // therefore a no-op for this grid's lift, and the translation is the whole
      // of what a same-size tile ever needed.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // `touch-manipulation`, not `touch-none`: the TouchSensor only swallows the
      // gesture once the press-and-hold has actually activated, so an ordinary
      // flick over the grid must still scroll the page.
      // Cards in a two/three-column row share a bottom edge. Empty cards retain
      // this same surface so the Overview never becomes a ragged split layout.
      className={`h-full touch-manipulation *:h-full ${
        isDragging ? "z-20 opacity-80" : item.empty ? "opacity-70" : ""
      }`}
      data-testid="saved-tile"
      data-tile-key={item.key}
      data-dragging={isDragging ? "true" : "false"}
      {...listeners}
    >
      {item.node}
    </div>
  );
}

export default function SavedTilesGrid({
  items,
  addTile,
}: {
  items: SavedTileItem[];
  // The one non-sortable empty slot after the saved list. On a phone it stays a
  // compact full-width row; at lg it occupies otherwise-unused grid geometry.
  addTile?: ReactNode;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();

  const serverOrder = items.map((i) => i.key);
  const signature = serverOrder.join(" ");
  const [order, setOrder] = useState<string[]>(serverOrder);
  const [seenSignature, setSeenSignature] = useState(signature);
  // Re-sync when the server hands back a different set (our own persist
  // revalidating, a star/unstar, a window change that populated a tile, a profile
  // switch). Derived-state-during-render is the sanctioned React pattern for this
  // and avoids the extra paint an effect would spend at the stale order.
  if (signature !== seenSignature) {
    setSeenSignature(signature);
    setOrder(serverOrder);
  }

  const byKey = new Map(items.map((i) => [i.key, i]));
  const ordered = order
    .map((k) => byKey.get(k))
    .filter((i): i is SavedTileItem => i != null);

  function persist(next: string[]) {
    const previous = order;
    setOrder(next);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("keys", JSON.stringify(next));
      try {
        const res = await reorderSaved(fd);
        if (!res.ok) {
          setOrder(previous);
          toast(res.error, { tone: "error" });
        }
      } catch {
        setOrder(previous);
        toast("Couldn't save that order. Try again.", { tone: "error" });
      }
    });
  }

  // The arrows' step — the SAME list and the same persist the drag uses, which is
  // the whole point of C's convergence.
  const reorder: TileReorder = {
    keys: order,
    move: (key, direction) => {
      const index = order.indexOf(key);
      if (index < 0) return;
      const next = moveInOrder(order, index, direction);
      if (next.some((k, i) => k !== order[i])) persist(next);
    },
  };

  return (
    <TileReorderContext.Provider value={reorder}>
      {/* `rect`: this grid genuinely wraps (two columns, three at `lg`), so a tile
          moves in two dimensions and the rect strategy is the right one. Stated
          explicitly since #1891 made it a prop — the dashboard's single-column
          phone editor needs the vertical one, and neither surface should inherit
          the other's answer by accident. No `renderOverlay`: the tiles are uniform,
          so the in-place lift is already stable. */}
      <SortableOrder
        ids={order}
        onReorder={persist}
        lift="long-press"
        strategy="rect"
      >
        <div className="space-y-3" data-testid="saved-tiles">
          <h2 className="flex items-center gap-2 section-label">★ Starred</h2>
          {ordered.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
              {ordered.map((i) => (
                <SortableTile key={i.key} item={i} />
              ))}
              {addTile ? (
                <div
                  className="col-span-2 flex items-center justify-center rounded-xl border border-dashed border-black/10 bg-white/40 px-4 py-3 lg:col-span-1 lg:min-h-48 dark:border-white/10 dark:bg-ink-900/40"
                  data-testid="save-trend-picker-slot"
                >
                  {addTile}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </SortableOrder>
    </TileReorderContext.Provider>
  );
}
