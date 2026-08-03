"use client";

import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { reorderIds, type ReorderStrategy } from "@/lib/drag-order";

// The app's ONE drag-reorder mechanism (issue #1485 C).
//
// Reorder used to be two languages: the dashboard's drag handles and the Trends
// Overview tiles' per-tile up/down arrows. C converges them on drag — and the way
// to converge an INTERACTION, not just a value, is the same as for a computation:
// one implementation, two consumers. This component is the shared DndContext +
// SortableContext (collision strategy, sensors, list math); each consumer still
// renders its own items with `useSortable`, because the item chrome is genuinely
// different (a widget's handle bar vs. a tile you lift whole).
//
// LIFT MODES. What starts a drag is the one thing the two surfaces disagree about,
// so it is a prop rather than a fork:
//
//   • "handle" — the dashboard. A dedicated grip button carries the listeners, so a
//     short pointer travel may start the drag immediately; the KeyboardSensor is
//     wired because the handle is a real focusable button and arrow keys on it are
//     the AT path.
//   • "long-press" — the Trends tiles. The whole tile is the target, and the tile
//     is also a link with a sparkline and a ⋯ menu on it, so a drag must NOT start
//     on an ordinary tap or a scroll flick: touch lifts after a press-and-hold
//     (with a movement tolerance that lets a flick scroll the page instead), and a
//     mouse needs a deliberate few pixels of travel. No KeyboardSensor here on
//     purpose — spreading dnd-kit's `role="button"` activator attributes over a
//     card that contains a link would make a mess of the tile's semantics, so the
//     non-pointer path is the tile's ⋯ menu arrows instead (#1485 C's own
//     requirement).
//
// Touch sensor, not pointer sensor, for "long-press": the pointer sensor needs
// `touch-action: none` on the draggable to see a touch drag at all, which on a
// full-page grid of tiles would kill vertical scrolling. TouchSensor listens to
// touch events and only preventDefaults once the press-and-hold has actually
// activated, so scrolling a phone through the grid keeps working.
export type LiftMode = "handle" | "long-press";

// The sensor set for a lift mode. Exported so a consumer that needs its own
// DndContext (a drag overlay, nested contexts) still shares the activation rules.
export function useReorderSensors(lift: LiftMode) {
  const pointer = useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  });
  const keyboard = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });
  const mouse = useSensor(MouseSensor, {
    activationConstraint: { distance: 6 },
  });
  const touch = useSensor(TouchSensor, {
    activationConstraint: { delay: 300, tolerance: 8 },
  });
  // Hooks are unconditional (rules of hooks); only the SELECTION is conditional.
  // useSensors takes the descriptors, so an unused one costs nothing.
  const handleSensors = useSensors(pointer, keyboard);
  const longPressSensors = useSensors(mouse, touch);
  return lift === "handle" ? handleSensors : longPressSensors;
}

// LAYOUT STRATEGY. dnd-kit's sorting strategy decides where every OTHER item
// slides while one is held, and it is a genuine per-surface fact rather than a
// default worth hiding: a wrapped grid and a single column want different
// answers. It is therefore a required prop — both consumers state theirs (#1891).
//
//   • "rect"     — a wrapped, multi-column grid. Items reflow in two dimensions.
//   • "vertical" — a single column. Items only ever move up or down, and the
//                  vertical strategy's arithmetic is exactly that.
//
// Note that the strategy's transform is NOT what a consumer should apply whole:
// `rectSortingStrategy` returns scaleX/scaleY alongside the translation, morphing
// the moving item toward the dimensions of the slot it passes over. With uniform
// items that scale is ~1 and invisible; with items of varying height (the
// dashboard's cards) it visibly squashes and stretches the dragged card. Consumers
// apply `CSS.Translate.toString(transform)` — the translation only. See
// lib/__tests__/sortable-transform-scan.test.ts, which pins that.
//
// The vocabulary itself lives in lib/drag-order.ts beside the list math, so a pure
// module can decide a strategy without importing this client component.
const STRATEGIES: Record<ReorderStrategy, SortingStrategy> = {
  rect: rectSortingStrategy,
  vertical: verticalListSortingStrategy,
};

// Wrap a set of `useSortable` items. `ids` is the ordered list the drag moves
// within — it is the MODEL's order, not necessarily the rendered one (the Trends
// grid sinks its empty tiles below the populated ones for layout while keeping
// every tile's slot in the saved order), so `onReorder` always hands back a
// complete, reordered copy of `ids`.
//
// `renderOverlay`, when supplied, lifts the dragged item into a `DragOverlay`: a
// copy rendered above the list, sized once from the item's measured rect and
// translated with the pointer, so what the user is carrying keeps ONE size for the
// whole gesture no matter what it passes over. The in-list original stays put
// (dimmed by its consumer) as the slot the drop will land in. Omit it and the
// surface keeps the plain in-place lift — the Trends tiles are uniform and their
// lift is already stable, so they do.
export default function SortableOrder({
  ids,
  onReorder,
  lift,
  strategy,
  renderOverlay,
  children,
}: {
  ids: string[];
  onReorder: (next: string[]) => void;
  lift: LiftMode;
  strategy: ReorderStrategy;
  renderOverlay?: (id: string) => ReactNode;
  children: ReactNode;
}) {
  const sensors = useReorderSensors(lift);
  const [activeId, setActiveId] = useState<string | null>(null);
  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const next = reorderIds(
      ids,
      String(e.active.id),
      e.over ? String(e.over.id) : null
    );
    // reorderIds returns a copy even for a no-op drag; only report a real move so
    // a stray tap can't fire a persist.
    if (next.some((id, i) => id !== ids[i])) onReorder(next);
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={ids} strategy={STRATEGIES[strategy]}>
        {children}
      </SortableContext>
      {renderOverlay && (
        <DragOverlay>{activeId ? renderOverlay(activeId) : null}</DragOverlay>
      )}
    </DndContext>
  );
}
