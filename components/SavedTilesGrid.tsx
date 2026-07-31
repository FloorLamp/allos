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
// ONE LIST, ONE WRITE. Converging an interaction means more than converging the
// gesture: the arrows and the drag now move within the SAME list (this component's
// order state) through the SAME pure step (`moveInOrder` / `reorderIds`) and the
// SAME persist (`reorderSaved` → `setSavedOrder`). Before this they could not even
// agree on what "earlier" meant — the arrows stepped through the stored SAVED
// order while the grid RENDERS a split (populated tiles two-abreast, then the
// #1485 A one-line rows), so tapping "Move earlier" on a tile whose neighbour in
// the saved list was a sunk empty row changed nothing you could see.
//
// The reorderable list is therefore the POPULATED tiles, in the order they draw.
// An empty tile is sunk below the grid BY RULE (it has nothing to show at this
// window), so its position is not a thing the user can meaningfully move; it keeps
// its ⋯ menu — the #1456 guarantee is that its UNSTAR stays reachable — and simply
// offers no arrows. A persist writes the populated order followed by the empty
// ones, so what you see is what is stored.
//
// The tile CONTENT is server-rendered (TrendMiniCard is a Server Component that
// reads units, colours and reference ranges) and passed in as nodes — this file
// owns motion and order only, so a reorder costs no re-query and the tiles keep
// their server-side data.
export interface SavedTileItem {
  // The Trends series key ("metric:weight" | "bio:ApoB") — the drag id AND the
  // vocabulary the persist action speaks.
  key: string;
  // Whether this tile compacts to a one-line row and sinks below the grid (#1485 A).
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
    useSortable({ id: item.key, disabled: item.empty });
  // dnd-kit's `attributes` (role="button" + the activator aria-* set) are
  // deliberately NOT spread: the tile CONTAINS a link and a ⋯ menu button, and
  // wrapping that in a button role would misdescribe it to AT for the sake of a
  // keyboard path the ⋯ menu's Move earlier / Move later already provide. The
  // listeners alone give the pointer/touch lift.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // `touch-manipulation`, not `touch-none`: the TouchSensor only swallows the
      // gesture once the press-and-hold has actually activated, so an ordinary
      // flick over the grid must still scroll the page.
      // Cards in a two/three-column row share a bottom edge. Sparse cards keep
      // their compact inline content, but the surface still fills the row so the
      // Overview does not become a jagged masonry grid.
      className={`h-full touch-manipulation [&>*]:h-full ${
        isDragging ? "z-20 opacity-80" : ""
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

export default function SavedTilesGrid({ items }: { items: SavedTileItem[] }) {
  const toast = useToast();
  const [, startTransition] = useTransition();

  // The server's list, split the way it draws. `empty` rides along unchanged — it
  // is decided by the window, not by the user.
  const serverOrder = items.filter((i) => !i.empty).map((i) => i.key);
  const emptyKeys = items.filter((i) => i.empty).map((i) => i.key);
  const signature = [...serverOrder, "|", ...emptyKeys].join(" ");
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
  const populated = order
    .map((k) => byKey.get(k))
    .filter((i): i is SavedTileItem => i != null);
  const empty = emptyKeys
    .map((k) => byKey.get(k))
    .filter((i): i is SavedTileItem => i != null);

  function persist(next: string[]) {
    const previous = order;
    setOrder(next);
    startTransition(async () => {
      const fd = new FormData();
      // Empty tiles keep their relative order at the end: the store holds ONE list,
      // and this is the list the user is looking at.
      fd.set("keys", JSON.stringify([...next, ...emptyKeys]));
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
      <SortableOrder ids={order} onReorder={persist} lift="long-press">
        <div className="space-y-3" data-testid="saved-tiles">
          <h2 className="flex items-center gap-2 section-label">★ Starred</h2>
          {populated.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
              {populated.map((i) => (
                <SortableTile key={i.key} item={i} />
              ))}
            </div>
          )}
          {empty.length > 0 && (
            <div className="space-y-2">
              {empty.map((i) => (
                <SortableTile key={i.key} item={i} />
              ))}
            </div>
          )}
        </div>
      </SortableOrder>
    </TileReorderContext.Provider>
  );
}
