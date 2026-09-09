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
// importance — three lines. Now the first control keeps its own line and the two
// beneath it share the next: two lines rather than three. THE ARRANGEMENT IS
// WHAT THAT BUYS, not a rank. It reads as a hierarchy here only because the
// control below still wears the raw `.btn` fill, and that is temporary.
//
// WHAT RANK THIS ROW ACTUALLY STATES, so the next reader is not told a story the
// code stopped telling (#4978 slice 3). "Start workout" is `type="button"` with
// an `onClick` and NO `<form>` ancestor, so the owner's form ruling — every form
// commit is `SubmitButton variant="primary"`, one per form — does not reach it,
// and Overview is a tab hosting several independent cards, none of which can
// claim the route's one filled paint. Whether a non-form commit on a multi-card
// route may be primary is OPEN on #4978 and is not settled by this comment or by
// the layout below it. TodaysSessionCard writes the unstacked shape for itself
// and its copy is already two controls of ONE rank; this one is the last raw
// mount in `app/(app)/training` because ruling (3) holds a commit back until its
// ghost can convert with it, and this commit's ghost is the `secondary` below.
//
// `secondary` is how a surface hands its OWN quiet control into that pair — the
// next-workout card's "View details", which belongs to the card rather than to
// the standing doors. It is rendered here because the pair is one flex line, and
// a sibling of this component could never join it. It is a `PendingTextLink`: a
// link that answers its own tap, which no button primitive can express, so it
// keeps its raw class and is reported on #4978 rather than converted.
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
