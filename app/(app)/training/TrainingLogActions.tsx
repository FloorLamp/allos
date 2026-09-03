"use client";

import { IconBolt, IconRepeat } from "@tabler/icons-react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import LogActivityButton from "@/components/LogActivityButton";

// THE LOG'S OWN DOORS (#4079's anti-drop census: "repeat-last → Log mount").
//
// ADD RENDERS AT EVERY VIEWPORT, and that is the change. The page header's create
// slot is desktop-only, so below `md` the Log carried no in-page way to log a
// session at all — the dock's quick-log was the only door, and a reader standing in
// their own log had to leave it to add to it. Above `md` the header's create is the
// page primary and this one stands down rather than saying it twice (#4014's
// one-primary-kind rule).
//
// REPEAT-LAST TAKES NO ROW. It used to need the feed's newest card to know what to
// repeat; `openRepeatLast` reads that from the editor provider, which is where the
// answer already lived — so the control survives the feed that used to feed it, and
// `hasLastActivity` is the same gate it always had.
export default function TrainingLogActions() {
  const {
    openLive,
    openRepeatLast,
    hasLastActivity,
    canStartWorkout,
    workoutOffer,
  } = useActivityEditor();

  return (
    <div
      data-testid="training-log-actions"
      className="flex flex-wrap items-center gap-2"
    >
      <div className="md:hidden">
        <LogActivityButton testId="training-log-add-activity-inline">
          Log activity
        </LogActivityButton>
      </div>
      {hasLastActivity && (
        <button
          type="button"
          onClick={openRepeatLast}
          data-testid="repeat-last"
          className="btn-ghost"
        >
          <IconRepeat className="h-4 w-4" stroke={2} />
          Repeat last
        </button>
      )}
      {canStartWorkout && (
        <button
          type="button"
          onClick={openLive}
          data-testid="start-workout"
          data-workout-offer={workoutOffer.kind}
          className="btn-ghost"
        >
          <IconBolt className="h-4 w-4" stroke={2} />
          {/* The label IS the offer (#1893) — "Resume workout" while a session is
              live, because openLive reopens it rather than resetting its clock. */}
          {workoutOffer.label}
        </button>
      )}
    </div>
  );
}
