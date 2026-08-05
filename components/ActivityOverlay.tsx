"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown } from "@tabler/icons-react";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
import type { FormDeloadContext } from "@/lib/routines";
import type { FormRecoveringContext } from "@/lib/injuries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import type { Equipment } from "@/lib/types";
import ActivityForm, { type ActivityEditData } from "./ActivityForm";
import { useLockBodyScroll } from "./useLockBodyScroll";
import {
  OverlayDragHandle,
  useOverlayDrag,
  OVERLAY_SCRIM_TINT_SM,
} from "./overlay";

// Chrome around the shared ActivityForm. Used everywhere the form isn't docked
// into a page column (e.g. the dashboard "Log activity" button). Full-page on
// mobile; a centered modal from the sm breakpoint up.
//
// ── This is the DOCK, and it is not a sheet (issue #1428's decision rule) ────
//
// It consumes the same overlay primitives as BottomSheet and the nav drawer —
// one slide token pair, one scrim tint, one drag handle, one recognizer (#1469)
// — and it resolves the shared swipe-down gesture DIFFERENTLY, which is the
// whole point of that convergence:
//
//   sheet: swipe down ⇒ DISCARD          dock: swipe down ⇒ MINIMIZE
//
// A live workout runs for an hour, survives navigation as the minimized bar, and
// "away" means STILL RUNNING. So the drag is wired to `onMinimize` and is
// DISABLED outright when there is no minimize to reach (a retro log/edit): the
// gesture never falls back to `onClose`, because a swipe that silently discards
// an in-progress workout is exactly the destructive-gesture class this app
// refuses. The dock never becomes discardable.
export default function ActivityOverlay({
  units,
  suggestions,
  history,
  equipment,
  recentActivityEquipment = [],
  bodyweightKg,
  editData,
  prefill = null,
  live = false,
  deloadContext,
  recoveringContext = { temperedRegions: [], constraints: [] },
  plateauHints = [],
  hidden = false,
  onMinimize,
  onClose,
}: {
  units: UnitPrefs;
  suggestions: ActivitySuggestions;
  history: ExerciseHistoryMap;
  equipment: Equipment[];
  recentActivityEquipment?: number[];
  bodyweightKg: number | null;
  editData: ActivityEditData | null;
  prefill?: ActivityEditData | null;
  live?: boolean;
  deloadContext: FormDeloadContext;
  recoveringContext?: FormRecoveringContext;
  plateauHints?: PlateauFormHint[];
  // Minimized to the app-wide dock (#921): the overlay stays MOUNTED (so the form's
  // rest timer / elapsed clock keep running) but is display:none, and the page
  // behind is unlocked. The bar is the restore affordance.
  hidden?: boolean;
  // When set (a live session), the backdrop tap + the header chevron MINIMIZE to the
  // dock instead of unmounting. Absent ⇒ the overlay closes normally.
  onMinimize?: () => void;
  onClose: () => void;
}) {
  // Lock the page behind only while the overlay is actually visible; a minimized
  // (hidden) overlay must not trap scroll on the page the user is now browsing.
  useLockBodyScroll(!hidden);

  const panelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  // ── The one shared primitive this surface deliberately does NOT take ────────
  //
  // The dock consumes the whole overlay set — scrim tint, panel chrome, the drag
  // handle, the recognizer, the reduced-motion posture — EXCEPT the mount slide,
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
  // The dock arrives instantly, on purpose. See docs/internals/overlays.md.

  // Swipe down to MINIMIZE — the shared recognizer, the dock's own outcome.
  // Disabled when there is no minimize to reach, so the gesture can never fall
  // through to a discard (see the header comment).
  // No `suppressMotion` to consume: this surface renders no motion class (see
  // above), so there is no keyframe for a drag to fight over.
  useOverlayDrag({
    panelRef,
    grabRef: handleRef,
    direction: "down",
    onOutcome: () => onMinimize?.(),
    // The panel is PARKED by a minimize, not unmounted — it comes straight back
    // with the session still live, so it must return to its resting transform.
    commitSettle: "rest",
    enabled: Boolean(onMinimize) && !hidden,
  });

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-white sm:p-8 dark:bg-ink-900 ${OVERLAY_SCRIM_TINT_SM} ${
        hidden ? "hidden" : ""
      }`}
      onClick={onClose}
    >
      {/* Bottom padding is plain p-4: the form's sticky footer re-spans it and
          carries the safe-area inset itself. */}
      <div
        ref={panelRef}
        data-testid="activity-overlay-panel"
        className="min-h-full w-full bg-white p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:min-h-0 sm:max-w-lg sm:rounded-xl sm:p-6 sm:pt-0 sm:shadow-xl dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        {onMinimize && (
          <div className="-mt-1 mb-1 grid grid-cols-[1fr_auto_1fr] items-center sm:mt-0">
            {/* The drag affordance sits centred over the panel and the explicit
                button stays on the right: the gesture is a shortcut, never the
                only way to minimize a running workout. */}
            <span aria-hidden />
            <OverlayDragHandle
              handleRef={handleRef}
              testId="workout-drag-handle"
            />
            <button
              type="button"
              onClick={onMinimize}
              data-testid="minimize-workout"
              aria-label="Minimize workout"
              title="Minimize workout"
              className="justify-self-end rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
            >
              <IconChevronDown
                className="h-5 w-5"
                stroke={1.75}
                aria-hidden="true"
              />
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
          editData={editData}
          prefill={prefill}
          live={live}
          deloadContext={deloadContext}
          recoveringContext={recoveringContext}
          plateauHints={plateauHints}
          onClose={onClose}
          stickyFooter
        />
      </div>
    </div>,
    document.body
  );
}
