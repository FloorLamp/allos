"use client";

import BottomSheet from "./BottomSheet";
import QuickLogMenu from "./QuickLogMenu";
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
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Log"
      testId="quick-log-sheet"
    >
      <QuickLogMenu
        open={open}
        onRun={onClose}
        cycleRelevant={cycleRelevant}
        substanceRelevant={substanceRelevant}
        logHabitDays={logHabitDays}
      />
    </BottomSheet>
  );
}
