"use client";

import { createPortal } from "react-dom";
import type { UnitPrefs } from "@/lib/settings";
import type { ActivitySuggestions, ExerciseHistoryMap } from "@/lib/queries";
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
  onClose: () => void;
}) {
  // Mounted only while open, so the page behind is locked for exactly that span.
  useLockBodyScroll(true);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-white sm:bg-slate-900/40 sm:p-8 dark:bg-ink-900 sm:dark:bg-black/70"
      onClick={onClose}
    >
      {/* Bottom padding is plain p-4: the form's sticky footer re-spans it and
          carries the safe-area inset itself. */}
      <div
        className="min-h-full w-full bg-white p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:min-h-0 sm:max-w-lg sm:rounded-xl sm:p-6 sm:pt-0 sm:shadow-xl dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
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
          onClose={onClose}
          stickyFooter
        />
      </div>
    </div>,
    document.body
  );
}
