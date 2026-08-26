"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { RpeTracking } from "@/lib/rpe";
import type { Equipment } from "@/lib/types";
import ActivityForm, { type ActivityEditData } from "./ActivityForm";
import { useLockBodyScroll } from "./useLockBodyScroll";
import { useFocusTrap } from "./useFocusTrap";
import {
  OVERLAY_DRAG_HANDLE_BAR,
  OVERLAY_DRAG_HANDLE_HIT,
  OVERLAY_SCRIM_TINT_SM,
  useOverlayDrag,
} from "./overlay";

// A RECORDED EXCEPTION TO THE DIALOG-HOST CONVERGENCE (#3405) — see
// docs/internals/overlays.md. It is not hostless in the sense that matters: it is
// CONVERGED, onto components/overlay rather than onto the dialog host, and it is
// registered in lib/__tests__/overlay-motion-chokepoint.test.ts as an
// OVERLAY_SURFACE. The dialog host is transactional — mount to open, unmount to
// close, swipe-down resolves to DISCARD — and this workspace is the opposite of
// all three: a live workout runs for an hour, survives navigation as the minimized
// bar, and its drag resolves to MINIMIZE. See the lifecycle note below, which is
// the same argument in the words of #1469.
//
// The one activity workspace around the shared ActivityForm. Every create, edit,
// repeat, and live entry uses it: full-screen on mobile and a right drawer from
// the sm breakpoint up. Pages never re-parent the form into their own layout.
//
// ── This is a persistent workspace, not a transient sheet ───────────────────
//
// A live workout runs for an hour, survives navigation as the minimized bar, and
// "away" means STILL RUNNING. On mobile its minimize bar supports both a click
// and a downward drag; both park the session instead of closing it.
export default function ActivityOverlay({
  units,
  suggestions,
  history,
  equipment,
  recentActivityEquipment = [],
  bodyweightKg,
  strengthTrainingAvailable,
  editData,
  prefill = null,
  initialDate,
  live = false,
  adoptRowId = null,
  adoptPending = false,
  onRowOwned,
  deloadContext,
  recoveringContext = { temperedRegions: [], constraints: [] },
  plateauHints = [],
  rpeTracking = null,
  hidden = false,
  onMinimize,
  onClose,
  onCloseRequestReady,
  onLiveFinished,
  onDeleted,
}: {
  units: UnitPrefs;
  suggestions: ActivitySuggestions;
  history: ExerciseHistoryMap;
  equipment: Equipment[];
  recentActivityEquipment?: number[];
  bodyweightKg: number | null;
  strengthTrainingAvailable: boolean;
  editData: ActivityEditData | null;
  prefill?: ActivityEditData | null;
  initialDate?: string;
  live?: boolean;
  // Create-at-start row + first-ownership callback for a live session (#2870
  // step 3), forwarded whole.
  adoptRowId?: number | null;
  // The create-at-start POST is still in flight (#3441).
  adoptPending?: boolean;
  onRowOwned?: (id: number) => void;
  deloadContext: FormDeloadContext;
  recoveringContext?: FormRecoveringContext;
  plateauHints?: PlateauFormHint[];
  rpeTracking?: RpeTracking | null;
  // Minimized to the app-wide bar (#921): the workspace stays MOUNTED (so the form's
  // rest timer / elapsed clock keep running) but is display:none, and the page
  // behind is unlocked. The bar is the restore affordance.
  hidden?: boolean;
  // When set (a live session), the backdrop tap and minimize bar park the
  // workspace instead of unmounting it. Absent ⇒ it closes normally.
  onMinimize?: () => void;
  onClose: () => void;
  onCloseRequestReady?: (
    requestClose: ((beforeClose?: () => void) => Promise<boolean>) | null
  ) => void;
  onLiveFinished?: () => void;
  onDeleted?: (id: number) => void;
}) {
  const [workoutRunning, setWorkoutRunning] = useState(live);
  const minimizeRunningWorkout = workoutRunning ? onMinimize : undefined;
  const panelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const dismissWorkspace = workoutRunning && onMinimize ? onMinimize : onClose;
  const closeRequestRef =
    useRef<(beforeClose?: () => void) => void | Promise<boolean>>(
      dismissWorkspace
    );
  const registerCloseRequest = useCallback(
    (requestClose: ((beforeClose?: () => void) => Promise<boolean>) | null) => {
      closeRequestRef.current = requestClose ?? dismissWorkspace;
      onCloseRequestReady?.(requestClose);
    },
    [dismissWorkspace, onCloseRequestReady]
  );
  const dismissFromOverlay = useCallback(() => {
    if (minimizeRunningWorkout) {
      minimizeRunningWorkout();
      return;
    }
    void closeRequestRef.current();
  }, [minimizeRunningWorkout]);

  // Lock the page behind only while the overlay is actually visible; a minimized
  // (hidden) overlay must not trap scroll on the page the user is now browsing.
  useLockBodyScroll(!hidden);
  useFocusTrap({
    panelRef,
    onClose: dismissFromOverlay,
    active: !hidden,
  });

  // ── The shared motion primitive this surface deliberately does NOT take ─────
  //
  // The workspace consumes the shared scrim and chrome but not the mount slide,
  // and that exception is load-bearing rather than lazy.
  //
  // This panel is a full-height (`min-h-full`) child of its own SCROLL container,
  // so sliding it in changes that container's scroll extent for the length of the
  // animation, which flips its scrollbar on and off. A scrollbar appearing and
  // vanishing changes the available width, and the activity form re-wraps around
  // it: a browser test caught the date/duration row landing 132px apart mid-enter
  // (e2e/entry-ergonomics.spec.ts's #188 layout assertion). Suppressing the
  // scrollbar for that window traded the visual glitch for a 240ms period where
  // the app's most complex form cannot scroll — a worse deal on a surface people
  // fill in one-handed at the gym.
  //
  // A mount animation would also be inconsistent here in a way it is not on a
  // sheet: minimizing HIDES this element rather than unmounting it (the rest
  // timer has to keep running), so restoring it could never replay the slide.
  // The drawer arrives instantly, on purpose. See docs/internals/overlays.md.

  useOverlayDrag({
    panelRef,
    grabRef: handleRef,
    direction: "down",
    onOutcome: () => minimizeRunningWorkout?.(),
    // Minimizing parks this panel instead of unmounting it. Clear the drag
    // transform before hiding so the restored workspace returns at rest.
    commitSettle: "rest",
    enabled: Boolean(minimizeRunningWorkout) && !hidden,
  });

  return createPortal(
    <div
      data-testid="activity-workspace"
      className={`fixed inset-0 z-50 flex items-start justify-end overflow-y-auto overscroll-contain bg-surface ${OVERLAY_SCRIM_TINT_SM} ${
        hidden ? "hidden" : ""
      }`}
      onClick={dismissFromOverlay}
    >
      {/* Bottom padding is plain p-4: the form's sticky footer re-spans it and
          carries the safe-area inset itself. */}
      <div
        ref={panelRef}
        data-testid="activity-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label={
          workoutRunning
            ? "Workout in progress"
            : editData
              ? "Edit activity"
              : "Add activity"
        }
        tabIndex={-1}
        className="min-h-full w-full bg-surface p-4 pt-[max(1rem,env(safe-area-inset-top))] outline-hidden sm:max-w-2xl sm:border-l-2 sm:border-slate-300 sm:p-8 sm:pt-0 sm:shadow-2xl sm:dark:border-white/25"
        onClick={(e) => e.stopPropagation()}
      >
        {minimizeRunningWorkout && (
          <div className="-mt-4 flex h-12 items-center justify-center sm:hidden">
            <button
              ref={handleRef}
              type="button"
              onClick={minimizeRunningWorkout}
              data-testid="minimize-workout"
              aria-label="Minimize workout"
              className={OVERLAY_DRAG_HANDLE_HIT}
            >
              <span className={OVERLAY_DRAG_HANDLE_BAR} />
            </button>
          </div>
        )}
        <ActivityForm
          units={units}
          suggestions={suggestions}
          history={history}
          equipment={equipment}
          recentActivityEquipment={recentActivityEquipment}
          bodyweightKg={bodyweightKg}
          strengthTrainingAvailable={strengthTrainingAvailable}
          editData={editData}
          prefill={prefill}
          initialDate={initialDate}
          live={live}
          onLiveFinished={() => {
            setWorkoutRunning(false);
            onLiveFinished?.();
          }}
          adoptRowId={adoptRowId}
          adoptPending={adoptPending}
          onRowOwned={onRowOwned}
          deloadContext={deloadContext}
          recoveringContext={recoveringContext}
          plateauHints={plateauHints}
          rpeTracking={rpeTracking}
          onClose={dismissWorkspace}
          onCloseRequestReady={registerCloseRequest}
          onDeleted={onDeleted}
          stickyFooter
        />
      </div>
    </div>,
    document.body
  );
}
