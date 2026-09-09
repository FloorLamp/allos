"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { IconArrowLeft } from "@tabler/icons-react";
import BottomSheet from "./BottomSheet";
import QuickLogMenu from "./QuickLogMenu";
import {
  QuickEntryVisitBodies,
  useQuickEntryVisit,
} from "./QuickEntryProvider";
import type { SegmentLogDays } from "@/lib/log-sheet";

// The phone's log sheet — what the dock's raised puck opens (issue #2651), and
// since #3154 one of TWO hosts for the same menu. The menu itself, both its
// sections and every decision they rest on, is components/QuickLogMenu.tsx; the
// desktop sidebar's "+ Log" panel (components/SidebarLogButton.tsx) is the other
// host. This file is the phone's presentation and nothing else.
//
// `onRun={onClose}`: the sheet CLOSES behind a row, because whatever opens next
// is its own overlay and should stand alone rather than stack over a sheet that
// has finished its job. The desktop panel makes the opposite call and stays
// open; that difference is the only thing the two hosts do not share.
export default function QuickLogSheet({
  open,
  onClose,
  cycleRelevant = true,
  substanceRelevant = false,
  logHabitDays = null,
}: {
  open: boolean;
  onClose: () => void;
  cycleRelevant?: boolean;
  substanceRelevant?: boolean;
  logHabitDays?: SegmentLogDays | null;
}) {
  const visit = useQuickEntryVisit(open, onClose);
  const backRef = useRef<HTMLButtonElement>(null);
  const fullClose = useCallback(() => {
    visit.beginClose();
    onClose();
  }, [onClose, visit]);

  useLayoutEffect(() => {
    if (visit.active) backRef.current?.focus();
    else visit.returnFocus?.focus();
  }, [visit.active, visit.returnFocus]);

  return (
    <BottomSheet
      open={open}
      onClose={fullClose}
      title={visit.active?.title ?? "Log"}
      size={visit.active?.size ?? "sm"}
      testId={visit.active ? "quick-entry-sheet" : "quick-log-sheet"}
      titleAdornment={visit.titleAdornment}
      belowTitle={visit.belowTitle}
      leadingTitle={
        visit.active ? (
          <button
            ref={backRef}
            type="button"
            aria-label="Back to log menu"
            data-testid="quick-log-back"
            onClick={visit.back}
            className="-ml-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-850"
          >
            <IconArrowLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : null
      }
    >
      <div hidden={visit.active !== null}>
        <QuickLogMenu
          open={open}
          onRun={fullClose}
          onOpenOverlay={visit.open}
          cycleRelevant={cycleRelevant}
          substanceRelevant={substanceRelevant}
          logHabitDays={logHabitDays}
        />
      </div>
      <QuickEntryVisitBodies onDone={fullClose} />
    </BottomSheet>
  );
}
