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
import { reorderSavedMetrics } from "@/app/(app)/saved-actions";

// The Body census's ONE tile grid (#3387). Saved metric cards form a contiguous
// pinned run at its head (after any structural life-stage lead), followed by the
// ranked census remainder and one non-card picker cell. Only the pinned run is
// sortable: ranking is not user-authored, and the picker never enters either list.
//
// The tile content stays server-rendered. This client boundary owns only the
// optimistic saved-order movement and the pointer/keyboard affordances that write
// the existing saved_items positions.
export interface SavedTileItem {
  // Stable census identity. A pinned metric uses its series key so the drag and
  // saved-store vocabularies are identical; unpinned/special cards use their slug.
  key: string;
  pinned: boolean;
  // Structural life-stage cards can be saved (and therefore need their unstar
  // menu) without joining the movable saved run. Their fixed prefix outranks user
  // arrangement; only the remaining pins are sortable.
  reorderable: boolean;
  empty: boolean;
  node: ReactNode;
}

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
  return (
    <div
      ref={setNodeRef}
      // Translation only (#1891): a sort moves a card; it never scales it toward
      // another slot's dimensions.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`h-full touch-manipulation *:h-full ${
        isDragging ? "z-20 opacity-80" : item.empty ? "opacity-70" : ""
      }`}
      data-testid="pinned-census-tile"
      data-tile-key={item.key}
      data-dragging={isDragging ? "true" : "false"}
      {...listeners}
    >
      {item.node}
    </div>
  );
}

function StaticTile({ item }: { item: SavedTileItem }) {
  return (
    <div
      className={`h-full *:h-full ${item.empty ? "opacity-70" : ""}`}
      data-testid={item.pinned ? "pinned-census-tile" : "census-tile"}
      {...(item.pinned
        ? { "data-tile-key": item.key }
        : { "data-card-key": item.key })}
    >
      {item.node}
    </div>
  );
}

export default function SavedTilesGrid({
  items,
  addTile,
}: {
  // Already in the server's census order: structural lead, pinned run, ranked tail.
  items: SavedTileItem[];
  addTile?: ReactNode;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const serverOrder = items
    .filter((item) => item.reorderable)
    .map((item) => item.key);
  const signature = serverOrder.join(" ");
  const [order, setOrder] = useState<string[]>(serverOrder);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (signature !== seenSignature) {
    setSeenSignature(signature);
    setOrder(serverOrder);
  }

  const pinnedByKey = new Map(
    items.filter((item) => item.reorderable).map((item) => [item.key, item])
  );
  const firstPinned = items.findIndex((item) => item.reorderable);
  const leading = firstPinned < 0 ? items : items.slice(0, firstPinned);
  const trailing =
    firstPinned < 0
      ? []
      : items.filter(
          (item, index) => !item.reorderable && index >= firstPinned
        );
  const pinned = order
    .map((key) => pinnedByKey.get(key))
    .filter((item): item is SavedTileItem => item != null);

  function persist(next: string[]) {
    const previous = order;
    setOrder(next);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("keys", JSON.stringify(next));
      try {
        const res = await reorderSavedMetrics(fd);
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

  const reorder: TileReorder = {
    keys: order,
    move: (key, direction) => {
      const index = order.indexOf(key);
      if (index < 0) return;
      const next = moveInOrder(order, index, direction);
      if (next.some((candidate, i) => candidate !== order[i])) persist(next);
    },
  };

  return (
    <TileReorderContext.Provider value={reorder}>
      <SortableOrder
        ids={order}
        onReorder={persist}
        lift="long-press"
        strategy="rect"
      >
        <div
          className="grid auto-rows-fr grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3"
          data-testid="body-metric-tiles"
        >
          {leading.map((item) => (
            <StaticTile key={item.key} item={item} />
          ))}
          {pinned.map((item) => (
            <SortableTile key={item.key} item={item} />
          ))}
          {trailing.map((item) => (
            <StaticTile key={item.key} item={item} />
          ))}
          {addTile ? (
            <div
              className="flex h-full min-h-48 items-center justify-center rounded-xl border border-dashed border-(--border) bg-surface/40 px-4 py-3"
              data-testid="save-trend-picker-slot"
            >
              {addTile}
            </div>
          ) : null}
        </div>
      </SortableOrder>
    </TileReorderContext.Provider>
  );
}
