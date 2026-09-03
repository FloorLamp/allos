"use client";

import { useRef, useState } from "react";
import Button from "./Button";
import QuickLogMenu from "./QuickLogMenu";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import { useCompactViewport } from "./useCompactViewport";
import { useMobileChrome } from "./MobileChromeProvider";
import type { SegmentLogDays } from "@/lib/log-sheet";

// `w-96`, told to the positioner so the FIRST paint of the panel is already
// clamped inside the viewport rather than measured into place afterwards.
//
// NOT the sidebar's own 240px, and not a compact desktop menu width either: this
// panel hangs off the column into the page, and 384 leaves its four-segment track
// the same ~88px per segment the phone sheet gets at 390px. At 320 the track was
// tight enough to break "Consume" across two lines — the same content in a
// narrower box is exactly the drift a shared menu exists to avoid, so the box is
// what changed.
const PANEL_WIDTH_PX = 384;

// THE SIDEBAR'S ONE LOG AFFORDANCE (#3154).
//
// It replaced `LogActivityButton`, which called `openCreate()` on the activity
// editor and `return null`ed when the workout product was not relevant — so a
// toddler's profile, or anyone else's without training, had NO log affordance in
// the desktop sidebar at all while the phone puck offered the full menu. There is
// no relevance gate here for the same reason there is none on the puck: food,
// body and care logs apply at every life stage, and `quickLogMenu`'s per-entry
// gates decide the CONTENT (#2651's age-restriction ruling).
//
// ONE BUTTON, TWO HOSTS, ONE MENU. Which host is the only decision this file
// makes, and it is the same fork components/overlay/AnchoredPanel.tsx documents:
//
//   * FROM `md` UP — an anchored panel through that primitive, the same one
//     /history's Calendar trigger opens (components/EventCalendar.tsx, which left
//     this column in #4280). It stays open across logs; Esc and an outside click
//     close it.
//   * BELOW `md` — the log sheet the dock puck already opens, through the shared
//     `logSheetOpen` state. NOT a second sheet of its own: the phone must have
//     exactly one, and routing here is what stops the drawer carrying an
//     activity-only oddity beside a puck that offers everything.
//
// PRIMARY IN BOTH HOSTS (#3982). This is the sidebar's ONE log affordance, so it
// is the action the surface exists for. Its ancestor `LogActivityButton` rendered
// `btn w-full` here until #3759 converged it on the typed Button, which had a
// single secondary paint — the owner reported the lost CTA colour, and the variant
// is what gives it back.
//
// Both hosts render components/QuickLogMenu.tsx, so there is one membership list
// (`QUICK_LOG_ITEMS`) and one grouping (`LOG_SEGMENT_CENSUS`) behind every
// surface — the drift #2184 recorded is what a second copy here would restart.
export default function SidebarLogButton({
  onNavigate,
  cycleRelevant = true,
  substanceRelevant = false,
  logHabitDays = null,
}: {
  // Closes the mobile drawer once the sheet has been asked for; the desktop
  // panel navigates nowhere and never calls it.
  onNavigate?: () => void;
  cycleRelevant?: boolean;
  substanceRelevant?: boolean;
  logHabitDays?: SegmentLogDays | null;
}) {
  const compact = useCompactViewport();
  const { logSheetOpen, setLogSheetOpen } = useMobileChrome();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (compact) {
    return (
      <Button
        variant="primary"
        data-testid="sidebar-log"
        aria-haspopup="dialog"
        aria-expanded={logSheetOpen}
        onClick={() => {
          setLogSheetOpen(true);
          onNavigate?.();
        }}
      >
        + Log
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="primary"
        ref={anchorRef}
        data-testid="sidebar-log"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="sidebar-log-panel"
        onClick={() => setOpen((v) => !v)}
      >
        + Log
      </Button>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        title="Log"
        // What the trigger's `aria-haspopup="dialog"` promises, made true (#3905).
        // Not `aria-modal`: this panel deliberately stays open across logs, so the
        // page behind it is emphatically still in play.
        role="dialog"
        panelId="sidebar-log-panel"
        testId="sidebar-log-panel"
        fallbackWidth={PANEL_WIDTH_PX}
        panelClassName="w-96"
      >
        {/* No height management here: since #4776 AnchoredPanel caps the popover
            to the room between the trigger and the viewport edge and scrolls the
            rest, which is what the 70vh reserve this used to carry was reaching
            for on a short desktop window (a half-screen split, a laptop with a
            docked devtools pane). */}
        {() => (
          <div className="p-4">
            <QuickLogMenu
              open={open}
              cycleRelevant={cycleRelevant}
              substanceRelevant={substanceRelevant}
              logHabitDays={logHabitDays}
            />
          </div>
        )}
      </AnchoredPanel>
    </>
  );
}
