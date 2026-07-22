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
import { usePathname } from "next/navigation";
import { useHistoryBackClose } from "./useHistoryBackClose";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { Equipment } from "@/lib/types";
import type { WorkoutPresence } from "@/lib/workout-presence";
import ActivityOverlay from "./ActivityOverlay";
import ActivityForm, { type ActivityEditData } from "./ActivityForm";
import WorkoutDock from "./WorkoutDock";
import { buildRepeatPrefill, todayStr } from "./activity-form/model";
import { useTimezone } from "./TimezoneProvider";

// The training route hosts the inline docked editor (JournalView registers a dock
// column), so the app-wide bottom bar is suppressed there — the session is already
// visible in the page column. Everywhere else the minimized bar carries it.
const JOURNAL_ROUTE = "/training";

interface ActivityEditorApi {
  openCreate: () => void;
  // Start a LIVE workout (issue #340): opens a fresh create form (date=today,
  // start=now) in the in-gym layout — the rest timer + set check-off flow. A
  // no-op for an age-restricted profile (strength is gated, #489); gate the
  // affordance on `canStartWorkout`.
  openLive: () => void;
  // Whether live workout mode is available (false for age-restricted profiles).
  canStartWorkout: boolean;
  // "Log this session" (#740): open a CREATE form pre-filled with a resolved
  // routine session (the day's slots as exercises + prescribed sets) IN live mode,
  // so a routine day goes straight into the in-gym flow. A no-op for an
  // age-restricted profile (strength is gated, #489) — gate on `canStartWorkout`.
  openSession: (prefill: ActivityEditData) => void;
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
  restricted = false,
  deloadContext,
  recoveringContext = { temperedRegions: [] },
  plateauHints = [],
  presence,
  liveEditData = null,
  liveStartEpochMs = null,
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
  // True for an age-restricted profile (#489): strength is gated, so live
  // workout mode (issue #340) is unavailable. Hides the Start-workout affordances.
  restricted?: boolean;
  // Deload/plateau inputs for the strength editor (#923): whether the active routine
  // is in its deload week (+ which lifts to shave), and the active plateau hints.
  deloadContext: FormDeloadContext;
  // The recovering-injury regions the form tempers by (#1144), gathered server-side from
  // the SAME temperedRegions the Analyze/detail panel reads — so the live logger and its
  // deep-link target agree on the injury axis (#221/#1115).
  recoveringContext?: FormRecoveringContext;
  plateauHints?: PlateauFormHint[];
  // Derived workout presence for the acting profile (#921), gathered server-side —
  // the source that HYDRATES the minimized dock on a fresh load / another device, so
  // an in-progress session is never invisible after a reload.
  presence?: WorkoutPresence;
  // The active session's editor data, for reopening the live editor from the dock.
  liveEditData?: ActivityEditData | null;
  // The active session's start instant (epoch ms), so the dock ticks elapsed off the
  // real start after a reload (client rest-timer state is honestly lost there).
  liveStartEpochMs?: number | null;
  children: React.ReactNode;
}) {
  const tz = useTimezone();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Minimized-but-MOUNTED: the live overlay collapses to the bottom bar without
  // unmounting ActivityForm, so the running rest timer + elapsed clock survive
  // (unmounting would silently kill them — the #921 regression this fixes). The form
  // stays mounted (rendered hidden); the bar is the affordance to restore it.
  const [minimized, setMinimized] = useState(false);
  // The mounted live session's start instant (epoch ms) for the minimized bar.
  const [liveStartEpoch, setLiveStartEpoch] = useState<number | null>(null);
  const [editData, setEditData] = useState<ActivityEditData | null>(null);
  // Whether the currently-open editor is in live workout mode (issue #340).
  const [live, setLive] = useState(false);
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
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      openLive: () => {
        // Age-restricted profiles have no strength surface (#489) — no-op.
        if (restricted) return;
        setEditData(null);
        setPrefill(null);
        setLive(true);
        setLiveStartEpoch(Date.now());
        setMinimized(false);
        // Live mode is a focused, full-attention flow — never dock it into the
        // journal's side column; use the overlay so it reads as its own screen.
        setDocked(false);
        setOpen(true);
      },
      canStartWorkout: !restricted,
      openSession: (prefillData) => {
        // Age-restricted profiles have no strength surface (#489) — no-op.
        if (restricted) return;
        setEditData(null);
        setPrefill(prefillData);
        setLive(true);
        setLiveStartEpoch(Date.now());
        setMinimized(false);
        setRepeatNonce((n) => n + 1);
        // Live mode is its own focused screen — never dock it into a page column.
        setDocked(false);
        setOpen(true);
      },
      openEdit: (data) => {
        setEditData(data);
        setPrefill(null);
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      openRepeat: (data) => {
        setEditData(null);
        setPrefill(buildRepeatPrefill(data, todayStr(tz)));
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        setRepeatNonce((n) => n + 1);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      openRepeatLast: () => {
        if (!lastActivity) return;
        setEditData(null);
        setPrefill(buildRepeatPrefill(lastActivity, todayStr(tz)));
        setLive(false);
        setLiveStartEpoch(null);
        setMinimized(false);
        setRepeatNonce((n) => n + 1);
        setDocked(dockElRef.current != null);
        setOpen(true);
      },
      hasLastActivity: lastActivity != null,
      close: () => {
        setMinimized(false);
        setOpen(false);
      },
      open,
      editData,
      registerDock,
    }),
    [open, editData, registerDock, tz, lastActivity, restricted]
  );

  // Resume the acting profile's active session in the live editor from the dock —
  // hydrated from the persisted #451 draft (getActivityEditData). Docks into the
  // journal column when one is present, else the overlay.
  const resumeLive = useCallback(() => {
    if (!liveEditData) return;
    setEditData(liveEditData);
    setPrefill(null);
    setLive(true);
    setLiveStartEpoch(liveStartEpochMs ?? Date.now());
    setMinimized(false);
    setDocked(dockElRef.current != null);
    setOpen(true);
  }, [liveEditData, liveStartEpochMs]);

  // Collapse the live overlay to the bar WITHOUT unmounting the form.
  const minimizeLive = useCallback(() => setMinimized(true), []);

  // The editor renders into the dock only when it was opened with one present
  // (see `docked`) and that dock is still mounted; otherwise it's the overlay.
  const showDock = docked && dockEl != null;

  const onJournal = pathname === JOURNAL_ROUTE;
  const hydrationActive =
    !open && presence?.state === "active" && liveEditData != null;
  // The bar shows for a client-minimized live session (mounted, hidden) anywhere,
  // and for a fresh-load active session everywhere except the journal route (where
  // the editor docks inline instead). A docked-open editor never shows the bar.
  const showBar = (minimized && !showDock) || (hydrationActive && !onJournal);
  // Elapsed baseline + copy for the bar: the mounted session's own start when
  // minimized, else the server-hydrated start.
  const barStartEpoch = minimized
    ? (liveStartEpoch ?? liveStartEpochMs ?? Date.now())
    : (liveStartEpochMs ?? Date.now());
  const barLabel =
    (minimized ? editData?.title : null) || presence?.title || "Resume";

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
      : live
        ? "live"
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
              live={live}
              deloadContext={deloadContext}
              recoveringContext={recoveringContext}
              plateauHints={plateauHints}
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
            live={live}
            deloadContext={deloadContext}
            recoveringContext={recoveringContext}
            plateauHints={plateauHints}
            // While minimized the overlay stays MOUNTED but hidden — the running
            // rest timer + elapsed clock keep ticking; the bar restores it.
            hidden={minimized}
            // A live session gets the explicit minimize chevron (collapse without
            // unmounting). The backdrop/Done still fully close; a still-active
            // session then re-hydrates the bar from presence, so it's never lost.
            onMinimize={live ? minimizeLive : undefined}
            onClose={() => {
              setMinimized(false);
              setOpen(false);
            }}
          />
        ))}
      {/* Spacer so the fixed bottom bar never overlaps the last of the page
          content — the layout "gains bottom padding while the dock is present". */}
      {showBar && <div className="h-20 shrink-0" aria-hidden="true" />}
      {showBar && (
        <WorkoutDock
          label={barLabel}
          startEpochMs={barStartEpoch}
          live={minimized ? live : true}
          stale={presence?.stale ?? false}
          onOpen={minimized ? () => setMinimized(false) : resumeLive}
        />
      )}
    </Ctx.Provider>
  );
}
