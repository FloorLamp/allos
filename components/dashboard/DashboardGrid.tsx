"use client";

import {
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  IconAdjustmentsHorizontal,
  IconGripVertical,
  IconEye,
  IconEyeOff,
  IconX,
  IconDeviceFloppy,
} from "@tabler/icons-react";
import {
  dashboardCustomizeMode,
  type WidgetSpan,
} from "@/lib/dashboard-widgets";
import SaveStatus from "@/components/SaveStatus";
import SortableOrder from "@/components/SortableOrder";
import { LG_QUERY } from "@/components/mobileDetail";

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

// Chrome shared by every Customize presentation — the two controls, written once.
// `useSortable`'s activator bindings are passed in rather than looked up here so
// the grip is the same button whether it sits on a card corner or a compact row.
const CONTROL_CLASS =
  "rounded-md border border-black/10 bg-white/90 p-1 text-slate-500 shadow-xs hover:text-slate-800 dark:border-white/10 dark:bg-ink-900/90 dark:text-slate-400 dark:hover:text-slate-100";

// Taken off `useSortable`'s own return type rather than imported from a dnd-kit
// subpath: `SyntheticListenerMap` only lives behind a `dist/` deep import, and the
// bindings are exactly what the hook hands back anyway.
type SortableBag = ReturnType<typeof useSortable>;
interface GripBindings {
  ref: SortableBag["setActivatorNodeRef"];
  attributes: SortableBag["attributes"];
  listeners: SortableBag["listeners"];
}

function WidgetControls({
  widget,
  hidden,
  onToggle,
  grip,
}: {
  widget: GridWidget;
  hidden: boolean;
  // Null on the drag ghost, which is a picture of what you are carrying rather
  // than a second set of controls (see DragGhost).
  onToggle: ((id: string) => void) | null;
  grip: GripBindings | null;
}) {
  const eyeIcon = hidden ? (
    <IconEyeOff className="h-4 w-4" />
  ) : (
    <IconEye className="h-4 w-4" />
  );
  if (!onToggle || !grip) {
    return (
      <div className="flex items-center gap-1">
        <span className={CONTROL_CLASS}>
          <IconGripVertical className="h-4 w-4" />
        </span>
        <span className={CONTROL_CLASS}>{eyeIcon}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        ref={grip.ref}
        {...grip.attributes}
        {...grip.listeners}
        aria-label={`Drag ${widget.label}`}
        title="Drag to reorder"
        className={`cursor-grab touch-none active:cursor-grabbing ${CONTROL_CLASS}`}
      >
        <IconGripVertical className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onToggle(widget.id)}
        aria-label={hidden ? `Show ${widget.label}` : `Hide ${widget.label}`}
        title={hidden ? "Show widget" : "Hide widget"}
        className={CONTROL_CLASS}
      >
        {eyeIcon}
      </button>
    </div>
  );
}

// One widget as Customize draws it — ONE component, two presentations (#1891).
//
//   compact  a ~48px reorder row: grip, label, eye. Below `lg` the grid is a
//            single column anyway and a live card is half a phone screen, so the
//            editor shows the thing being edited (the ORDER) and nothing else —
//            the whole list fits a screen and a move is a flick. The card's
//            hidden ring and "Hidden" badge translate to row styling.
//   card     the in-place live widget with its controls floated on the corner.
//            At `lg`+ spans and adjacency are visible and worth editing against.
//
// Both are driven by the SAME `widget` / `hidden` inputs and the same controls;
// neither derives any state of its own. This is a presentation switch, not a
// responsive fork of the feature.
function WidgetEditorItem({
  widget,
  hidden,
  compact,
  controls,
}: {
  widget: GridWidget;
  hidden: boolean;
  compact: boolean;
  controls: ReactNode;
}) {
  if (compact) {
    return (
      <div
        className={`flex min-h-12 items-center gap-2 rounded-lg bg-white px-2 py-2 dark:bg-ink-900 ${
          hidden
            ? "ring-1 ring-dashed ring-slate-300 dark:ring-ink-700"
            : "ring-1 ring-brand-300 dark:ring-brand-700"
        }`}
      >
        {controls}
        <span
          className={`min-w-0 flex-1 truncate text-sm font-medium text-slate-700 dark:text-slate-200 ${
            hidden ? "opacity-50" : ""
          }`}
        >
          {widget.label}
        </span>
        {hidden && (
          <span className="shrink-0 rounded-md bg-slate-800/80 px-2 py-0.5 text-xs font-medium text-white">
            Hidden
          </span>
        )}
        {!widget.available && !hidden && (
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            No data yet
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">{controls}</div>
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

// What the DragOverlay carries: the SAME item, sized once by dnd-kit from the
// lifted node's measured rect and translated with the pointer, so it keeps one
// size for the whole gesture instead of being reshaped by whatever it crosses.
// `aria-hidden` because it is a picture of a control the user is already holding
// — duplicating "Drag {label}" into the accessibility tree mid-drag would just
// give AT two of everything, and the real controls never leave the list.
function DragGhost({
  widget,
  hidden,
  compact,
}: {
  widget: GridWidget;
  hidden: boolean;
  compact: boolean;
}) {
  return (
    // `pointer-events-none` is load-bearing, not cosmetic. dnd-kit's DragOverlay
    // wrapper is `position: fixed; z-index: 999` and sets NO pointer-events of its
    // own, and it stays mounted through the drop animation — so for the couple of
    // hundred milliseconds after you let go, the ghost swallows taps on whatever it
    // happens to be lying over. On a phone the very next thing a user reaches for
    // after dropping a row is Save. A picture of a card you are already holding must
    // never be able to take a tap; the real controls never leave the list.
    <div
      aria-hidden="true"
      data-testid="dashboard-drag-ghost"
      className="pointer-events-none cursor-grabbing opacity-90 shadow-xl"
    >
      <WidgetEditorItem
        widget={widget}
        hidden={hidden}
        compact={compact}
        controls={
          <WidgetControls
            widget={widget}
            hidden={hidden}
            onToggle={null}
            grip={null}
          />
        }
      />
    </div>
  );
}

// One draggable/hideable widget slot in Customize mode. In card presentation the
// widget's own content is made inert (pointer-events-none) so its links don't fire
// while editing; the controls sit above it with pointer events.
function SortableWidget({
  widget,
  hidden,
  compact,
  onToggle,
}: {
  widget: GridWidget;
  hidden: boolean;
  compact: boolean;
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
      // TRANSLATE, not Transform (#1891). The sorting strategy's transform also
      // carries scaleX/scaleY, which morphs the moving item toward the dimensions
      // of the slot it is passing over — invisible on a uniform grid, but these
      // cards vary wildly in height, so the dragged card visibly squashed and
      // stretched as it crossed shorter and taller neighbours. The translation is
      // the only part of the transform a reorder ever needed.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`dashboard-widget-${widget.id}`}
      className={`${compact ? "" : SPAN_CLASS[widget.span]} ${
        // The lifted card rides in the DragOverlay; what stays here is the SLOT
        // the drop will land in, so it fades rather than following the pointer.
        isDragging ? "opacity-40" : ""
      }`}
    >
      <WidgetEditorItem
        widget={widget}
        hidden={hidden}
        compact={compact}
        controls={
          <WidgetControls
            widget={widget}
            hidden={hidden}
            onToggle={onToggle}
            grip={{ ref: setActivatorNodeRef, attributes, listeners }}
          />
        }
      />
    </div>
  );
}

// The `lg` boundary, read once per grid. Same query as every other JS check of
// the master/detail breakpoint (components/mobileDetail.ts), so the editor's
// presentation cannot drift from the grid's own `lg:grid-cols-6`.
function subscribeToLg(onChange: () => void) {
  const query = window.matchMedia(LG_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getLgSnapshot() {
  return window.matchMedia(LG_QUERY).matches;
}

// The dashboard grid. Normal mode renders the visible widgets in order. Customize
// mode reveals every eligible widget (visible + hidden, available or temporarily
// unavailable) with a drag handle and a show/hide toggle; Save persists order +
// user-hidden ids only and refreshes, Cancel restores the pre-edit state.
export default function DashboardGrid({
  widgets,
  promoted = [],
  saveAction,
}: {
  widgets: GridWidget[];
  // Widget ids the "Now" strip is rendering above the grid right now (issue #1413).
  // Skipped in NORMAL mode only, so the card appears once on the page rather than
  // twice. Deliberately NOT filtered out of `widgets`: Customize must keep showing
  // every eligible widget, or a momentarily-promoted card would vanish from the
  // editor and the user could neither reorder nor un-hide it — and, worse, Save
  // would persist an order missing it. Promotion is transient; the layout is not.
  promoted?: string[];
  saveAction: (order: string[], hidden: string[]) => Promise<void>;
}) {
  const promotedIds = useMemo(() => new Set(promoted), [promoted]);
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
  // ONE breakpoint reading, ONE decision (#1891): the same answer chooses the
  // presentation and the drag strategy, so they can never disagree.
  const isWide = useSyncExternalStore(
    subscribeToLg,
    getLgSnapshot,
    () => false
  );
  const { compact, strategy } = dashboardCustomizeMode(isWide);

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
      .filter((id) => !hidden.has(id) && !promotedIds.has(id))
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
      {/* The SHARED drag mechanism (#1485 C) — the same DndContext/SortableContext
          and list math the Trends Overview tiles lift with, differing only in the
          lift mode: this surface has a dedicated grip handle, so it keeps the
          immediate pointer lift + keyboard activator. The strategy and the ghost
          are this surface's own (#1891). */}
      <SortableOrder
        ids={order}
        onReorder={setOrder}
        lift="handle"
        strategy={strategy}
        renderOverlay={(id) => {
          const w = byId.get(id);
          return w ? (
            <DragGhost widget={w} hidden={hidden.has(id)} compact={compact} />
          ) : null;
        }}
      >
        <div
          data-testid="dashboard-customize"
          data-presentation={compact ? "rows" : "cards"}
          className={
            compact ? "space-y-2" : "grid grid-cols-1 gap-6 lg:grid-cols-6"
          }
        >
          {order.map((id) => {
            const w = byId.get(id);
            if (!w) return null;
            return (
              <SortableWidget
                key={id}
                widget={w}
                hidden={hidden.has(id)}
                compact={compact}
                onToggle={toggle}
              />
            );
          })}
        </div>
      </SortableOrder>

      {/* Sticky Save / Cancel bar. */}
      <div className="sticky bottom-4 z-30 mt-6 flex items-center justify-end gap-3 rounded-xl border border-black/10 bg-white/95 px-4 py-3 shadow-lg backdrop-blur-sm dark:border-white/10 dark:bg-ink-900/95">
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
