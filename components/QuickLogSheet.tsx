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
// Activity keeps its existing dock handoff. Quick-entry rows stay in this sheet:
// a Back control returns to the normally mounted menu, so visited form drafts
// remain available until the whole sheet closes. The desktop panel continues to
// open those same forms through the provider's direct API.
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
  const beginClose = visit.beginClose;
  const activeId = visit.active?.id ?? null;
  const fullClose = useCallback(() => {
    beginClose();
    onClose();
  }, [beginClose, onClose]);

  useLayoutEffect(() => {
    if (activeId != null) backRef.current?.focus();
    else visit.returnFocus?.focus();
  }, [activeId, visit.returnFocus]);

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
      <QuickEntryVisitBodies identity={visit.identity} onDone={fullClose} />
    </BottomSheet>
  );
}
