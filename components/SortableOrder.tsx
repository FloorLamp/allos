"use client";

import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { reorderIds } from "@/lib/drag-order";

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

// Wrap a set of `useSortable` items. `ids` is the ordered list the drag moves
// within — it is the MODEL's order, not necessarily the rendered one (the Trends
// grid sinks its empty tiles below the populated ones for layout while keeping
// every tile's slot in the saved order), so `onReorder` always hands back a
// complete, reordered copy of `ids`.
export default function SortableOrder({
  ids,
  onReorder,
  lift,
  children,
}: {
  ids: string[];
  onReorder: (next: string[]) => void;
  lift: LiftMode;
  children: ReactNode;
}) {
  const sensors = useReorderSensors(lift);
  function onDragEnd(e: DragEndEvent) {
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
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}
