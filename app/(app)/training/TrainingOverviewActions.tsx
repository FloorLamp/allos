"use client";

import { useActivityEditor } from "@/components/ActivityEditorProvider";
import LogActivityButton from "@/components/LogActivityButton";
import type { ReactNode } from "react";

// The landing hub's standing doors (#3062). Recommendation state can change the
// answer above these controls, but it must not make either logging path disappear.
//
// TWO ARRANGEMENTS, AND `stacked` PICKS ONE (#3473). Unstacked is a wrapping row
// — the Activity card's pair, and the shape TodaysSessionCard writes for itself.
// Stacked is the next-workout card's RIGHT-HAND RAIL: a column beside the card
// text at `md`+, where a column is what a rail is.
//
// Below `md` that rail collapses under the content and used to bring the column
// with it, so a phone spent one line per control on buttons of DESCENDING
// importance — three lines. Now the primary keeps its own line and the ghost
// controls share the one beneath it: two lines, and the hierarchy says what the
// card wants you to do.
//
// `secondary` is how a surface hands its OWN ghost control into that pair — the
// next-workout card's "View details", which belongs to the card rather than to
// the standing doors. It is rendered here because the pair is one flex line, and
// a sibling of this component could never join it.
//
// THE BOUNDARY IS `md`, AND IT IS NOT THE CARD-MODE ONE.
// `CARD_MODE_BREAKPOINT_PX` (`sm`, lib/card-row.ts, #3457) is where a
// `.table-cards` TABLE becomes a stack of records. This is a card's action rail
// collapsing under its text — the card's own `md:flex-row` seam in
// OverviewSection, which this arrangement follows. Same word, different
// boundary; docs/internals/design-system.md §5 lists them as separate idioms.
export default function TrainingOverviewActions({
  stacked = false,
  secondary,
}: {
  stacked?: boolean;
  secondary?: ReactNode;
}) {
  const { openLive, canStartWorkout, workoutOffer } = useActivityEditor();

  const logActivity = (
    <LogActivityButton testId="training-overview-log-activity">
      Log activity
    </LogActivityButton>
  );

  return (
    <div
      className={
        stacked
          ? "flex flex-col items-start gap-2 md:items-end"
          : "flex flex-wrap gap-2"
      }
      data-testid="training-overview-actions"
    >
      {canStartWorkout && (
        <button
          type="button"
          className="btn whitespace-nowrap"
          data-testid="training-overview-start-workout"
          data-workout-offer={workoutOffer.kind}
          onClick={openLive}
        >
          {workoutOffer.label}
        </button>
      )}
      {secondary ? (
        // The ghost pair. Below `md` it is one wrapping line under the primary;
        // at `md`+ the stacked rail's copy becomes a column of its own, and
        // because it repeats the rail's `gap-2` and `items-end` it renders as
        // the rail's second and third rows exactly as before.
        <div
          className={
            stacked
              ? "flex flex-wrap items-center gap-2 md:flex-col md:items-end"
              : "flex flex-wrap items-center gap-2"
          }
        >
          {logActivity}
          {secondary}
        </div>
      ) : (
        logActivity
      )}
    </div>
  );
}
