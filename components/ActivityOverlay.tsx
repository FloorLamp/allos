"use client";

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

// Chrome around the shared ActivityForm. Used everywhere the form isn't docked
// into a page column (e.g. the dashboard "Log activity" button). Full-page on
// mobile; a centered modal from the sm breakpoint up.
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
  recoveringContext = { temperedRegions: [] },
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

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-white sm:bg-slate-900/40 sm:p-8 dark:bg-ink-900 sm:dark:bg-black/70 ${
        hidden ? "hidden" : ""
      }`}
      onClick={onClose}
    >
      {/* Bottom padding is plain p-4: the form's sticky footer re-spans it and
          carries the safe-area inset itself. */}
      <div
        className="min-h-full w-full bg-white p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:min-h-0 sm:max-w-lg sm:rounded-xl sm:p-6 sm:pt-0 sm:shadow-xl dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        {onMinimize && (
          <div className="-mt-1 mb-1 flex justify-end sm:mt-0">
            <button
              type="button"
              onClick={onMinimize}
              data-testid="minimize-workout"
              aria-label="Minimize workout"
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
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
