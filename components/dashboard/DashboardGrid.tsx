"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  IconAdjustmentsHorizontal,
  IconGripVertical,
  IconEye,
  IconEyeOff,
  IconX,
  IconDeviceFloppy,
} from "@tabler/icons-react";
import type { WidgetSpan } from "@/lib/dashboard-widgets";
import SaveStatus from "@/components/SaveStatus";

export interface GridWidget {
  id: string;
  label: string;
  span: WidgetSpan;
  // The user's persisted show/hide preference. Keep this separate from
  // `available`: temporary data absence must never become a saved hidden id.
  visible: boolean;
  // Whether this widget has something useful to render right now. Unavailable
  // widgets stay in Customize so their preference/order survives, but leave no
  // empty slot in the normal dashboard grid.
  available: boolean;
  node: ReactNode;
}

// Widget span → column footprint on the 6-column `lg` grid (full=6, two-thirds=4,
// half=3, third=2). Collapses to a single column below `lg`.
const SPAN_CLASS: Record<WidgetSpan, string> = {
  full: "lg:col-span-6",
  "two-thirds": "lg:col-span-4",
  half: "lg:col-span-3",
  third: "lg:col-span-2",
};

// One draggable/hideable widget slot in Customize mode. The widget's own content
// is made inert (pointer-events-none) so its links don't fire while editing; the
// control bar (drag handle + show/hide toggle) sits above it with pointer events.
function SortableWidget({
  widget,
  hidden,
  onToggle,
}: {
  widget: GridWidget;
  hidden: boolean;
  onToggle: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`dashboard-widget-${widget.id}`}
      className={`${SPAN_CLASS[widget.span]} relative ${
        isDragging ? "z-20 opacity-80" : ""
      }`}
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={() => onToggle(widget.id)}
          aria-label={hidden ? `Show ${widget.label}` : `Hide ${widget.label}`}
          className="rounded-md border border-black/10 bg-white/90 p-1 text-slate-500 shadow-sm hover:text-slate-800 dark:border-white/10 dark:bg-ink-900/90 dark:text-slate-400 dark:hover:text-slate-100"
        >
          {hidden ? (
            <IconEyeOff className="h-4 w-4" />
          ) : (
            <IconEye className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag ${widget.label}`}
          className="cursor-grab touch-none rounded-md border border-black/10 bg-white/90 p-1 text-slate-500 shadow-sm hover:text-slate-800 active:cursor-grabbing dark:border-white/10 dark:bg-ink-900/90 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <IconGripVertical className="h-4 w-4" />
        </button>
      </div>
      {hidden && (
        <div className="absolute left-2 top-2 z-10 rounded-md bg-slate-800/80 px-2 py-0.5 text-xs font-medium text-white">
          Hidden
        </div>
      )}
      <div
        className={`pointer-events-none select-none rounded-xl ${
          hidden
            ? "opacity-40 ring-1 ring-dashed ring-slate-300 dark:ring-ink-700"
            : "ring-1 ring-brand-300 dark:ring-brand-700"
        }`}
      >
        {widget.available ? (
          widget.node
        ) : (
          <div className="card min-h-28">
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              {widget.label}
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Nothing to show right now.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// The dashboard grid. Normal mode renders the visible widgets in order. Customize
// mode reveals every eligible widget (visible + hidden, available or temporarily
// unavailable) with a drag handle and a show/hide toggle; Save persists order +
// user-hidden ids only and refreshes, Cancel restores the pre-edit state.
export default function DashboardGrid({
  widgets,
  saveAction,
}: {
  widgets: GridWidget[];
  saveAction: (order: string[], hidden: string[]) => Promise<void>;
}) {
  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets]);

  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState<string[]>(() => widgets.map((w) => w.id));
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(widgets.filter((w) => !w.visible).map((w) => w.id))
  );
  // Snapshot taken on entering edit mode, restored on Cancel.
  const [snapshot, setSnapshot] = useState<{
    order: string[];
    hidden: string[];
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function enterEdit() {
    setSnapshot({ order: [...order], hidden: [...hidden] });
    setEditing(true);
    setError(false);
  }

  function cancel() {
    if (snapshot) {
      setOrder(snapshot.order);
      setHidden(new Set(snapshot.hidden));
    }
    setSnapshot(null);
    setEditing(false);
    setError(false);
  }

  function toggle(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setOrder((prev) => {
      const oldIndex = prev.indexOf(String(active.id));
      const newIndex = prev.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }

  function save() {
    setError(false);
    startTransition(async () => {
      try {
        await saveAction(order, [...hidden]);
        setSavedAt(Date.now());
        setSnapshot(null);
        setEditing(false);
      } catch {
        setError(true);
      }
    });
  }

  if (!editing) {
    const visible = order
      .filter((id) => !hidden.has(id))
      .map((id) => byId.get(id))
      .filter((w): w is GridWidget => !!w && w.available);
    return (
      <div>
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={enterEdit}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-900 dark:hover:text-slate-300"
          >
            <IconAdjustmentsHorizontal className="h-4 w-4" />
            Edit dashboard
          </button>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
          {visible.map((w) => (
            <div
              key={w.id}
              className={SPAN_CLASS[w.span]}
              data-testid={`dashboard-widget-${w.id}`}
            >
              {w.node}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-700 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300">
        Drag the handle to reorder. Use the eye to show or hide a widget.
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
            {order.map((id) => {
              const w = byId.get(id);
              if (!w) return null;
              return (
                <SortableWidget
                  key={id}
                  widget={w}
                  hidden={hidden.has(id)}
                  onToggle={toggle}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* Sticky Save / Cancel bar. */}
      <div className="sticky bottom-4 z-30 mt-6 flex items-center justify-end gap-3 rounded-xl border border-black/10 bg-white/95 px-4 py-3 shadow-lg backdrop-blur dark:border-white/10 dark:bg-ink-900/95">
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-ink-800"
        >
          <IconX className="h-4 w-4" />
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="btn btn-sm"
        >
          <IconDeviceFloppy className="h-4 w-4" />
          Save
        </button>
      </div>
    </div>
  );
}
