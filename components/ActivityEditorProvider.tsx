"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useHistoryBackClose } from "./useHistoryBackClose";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { Equipment } from "@/lib/types";
import ActivityOverlay from "./ActivityOverlay";
import ActivityForm, { type ActivityEditData } from "./ActivityForm";
import { buildRepeatPrefill, todayStr } from "./activity-form/model";
import { useTimezone } from "./TimezoneProvider";

interface ActivityEditorApi {
  openCreate: () => void;
  openEdit: (data: ActivityEditData) => void;
  // "Log again" / "Repeat last": open a CREATE form pre-filled from a stored
  // activity (title, exercises, sets) with the date reset to today (issue #29).
  openRepeat: (data: ActivityEditData) => void;
  // Repeat the single most recent activity — the palette command / mobile quick
  // action so repeat-last isn't desktop-only (issue #337). No-op when nothing's
  // been logged; `hasLastActivity` gates the affordance.
  openRepeatLast: () => void;
  hasLastActivity: boolean;
  close: () => void;
  // Whether an editor is currently open, and what it's editing — so a page can
  // hand the editor a column to dock into and react to it being active.
  open: boolean;
  editData: ActivityEditData | null;
  // Register a DOM node for the editor to render into inline instead of the
  // overlay. Pass null to unregister.
  registerDock: (el: HTMLElement | null) => void;
}

const Ctx = createContext<ActivityEditorApi | null>(null);

export function useActivityEditor(): ActivityEditorApi {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error(
      "useActivityEditor must be used within ActivityEditorProvider"
    );
  return ctx;
}

export default function ActivityEditorProvider({
  units,
  suggestions,
  history,
  equipment,
  recentActivityEquipment = [],
  bodyweightKg,
  lastActivity = null,
  children,
}: {
  units: UnitPrefs;
  suggestions: ActivitySuggestions;
  history: ExerciseHistoryMap;
  equipment: Equipment[];
  // Recently-used session gear, most-recent-first (issues #342/#339) — defaults the
  // form's activity-level equipment picker, narrowed per-activity by the form.
  recentActivityEquipment?: number[];
  bodyweightKg: number | null;
  // The single most recent activity (issue #337), seeding the "Repeat last
  // activity" palette command / mobile quick action. null when nothing's logged.
  lastActivity?: ActivityEditData | null;
  children: React.ReactNode;
}) {
  const tz = useTimezone();
  const [open, setOpen] = useState(false);
  const [editData, setEditData] = useState<ActivityEditData | null>(null);
  // Repeat-last prefill: seeds a create form. Bumped `repeatNonce` forces a fresh
  // remount so tapping "Log again" twice on the same source re-seeds cleanly.
  const [prefill, setPrefill] = useState<ActivityEditData | null>(null);
  const [repeatNonce, setRepeatNonce] = useState(0);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  // Whether the currently-open editor should render into the dock. Captured
  // when the editor opens (from whether a dock existed then) and held for that
  // session, so a dock that registers mid-edit can't yank an open overlay
  // editor into it — which would re-parent the form to a new portal, remounting
  // it back to a blank state and dropping the user's unfinished input. This
  // happens on the journal page's 0→1-activities transition: with no activities
  // the page shows an empty state (no dock), so "Log activity" opens the
  // overlay; the first auto-save's router.refresh() mounts JournalView, which
  // registers the dock. A ref mirrors it so open* can read the live dock
  // presence without taking dockEl as a dependency (which would churn the
  // memoized api on every dock registration).
  const [docked, setDocked] = useState(false);
  const dockElRef = useRef<HTMLElement | null>(null);

  const registerDock = useCallback((el: HTMLElement | null) => {
    dockElRef.current = el;
    setDockEl(el);
    // The dock is going away (e.g. navigating off the journal). Close the editor
    // rather than letting it pop back as an overlay on the next page; the
    // docked ActivityForm flushes any pending auto-save on unmount.
    if (!el) setOpen(false);
  }, []);

  // Memoized so always-mounted consumers (e.g. MobileNav's quick-log button)
  // only re-render when open/editData actually change — not on every provider
  // render (dock registration churns on journal mount/unmount).
  const api: ActivityEditorApi = useMemo(
    () => ({
      openCreate: () => {
        setEditData(null);
        setPrefill(null);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      openEdit: (data) => {
        setEditData(data);
        setPrefill(null);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      openRepeat: (data) => {
        setEditData(null);
        setPrefill(buildRepeatPrefill(data, todayStr(tz)));
        setRepeatNonce((n) => n + 1);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      openRepeatLast: () => {
        if (!lastActivity) return;
        setEditData(null);
        setPrefill(buildRepeatPrefill(lastActivity, todayStr(tz)));
        setRepeatNonce((n) => n + 1);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      hasLastActivity: lastActivity != null,
      close: () => setOpen(false),
      open,
      editData,
      registerDock,
    }),
    [open, editData, registerDock, tz, lastActivity]
  );

  // The editor renders into the dock only when it was opened with one present
  // (see `docked`) and that dock is still mounted; otherwise it's the overlay.
  const showDock = docked && dockEl != null;

  // On mobile the overlay reads as its own page (full-screen below sm), so hold
  // a history entry while it's open: the phone's back button/gesture closes the
  // form instead of leaving the page. From sm up — and for the docked editor —
  // history is left alone. This lives on the provider (mounted once, keyed to
  // `open`) rather than ActivityOverlay: a mount-tied effect would push/pop on
  // StrictMode's dev double-mount.
  useHistoryBackClose(
    open && !showDock,
    () => setOpen(false),
    () => !window.matchMedia("(min-width: 640px)").matches
  );

  // Remount fresh each time so state initializes from editData/prefill. The
  // nonce keeps repeated "Log again" taps from reusing a stale mount.
  const formKey = editData
    ? `edit-${editData.id}`
    : prefill
      ? `repeat-${repeatNonce}`
      : "create";

  return (
    <Ctx.Provider value={api}>
      {children}
      {open &&
        (showDock ? (
          createPortal(
            <ActivityForm
              key={formKey}
              units={units}
              suggestions={suggestions}
              history={history}
              equipment={equipment}
              recentActivityEquipment={recentActivityEquipment}
              bodyweightKg={bodyweightKg}
              editData={editData}
              prefill={prefill}
              onClose={() => setOpen(false)}
            />,
            dockEl
          )
        ) : (
          <ActivityOverlay
            key={formKey}
            units={units}
            suggestions={suggestions}
            history={history}
            equipment={equipment}
            recentActivityEquipment={recentActivityEquipment}
            bodyweightKg={bodyweightKg}
            editData={editData}
            prefill={prefill}
            onClose={() => setOpen(false)}
          />
        ))}
    </Ctx.Provider>
  );
}
