"use client";

import { useActivityEditor } from "@/components/ActivityEditorProvider";
import LogActivityButton from "@/components/LogActivityButton";

// The landing hub's standing doors (#3062). Recommendation state can change the
// answer above these controls, but it must not make either logging path disappear.
export default function TrainingOverviewActions({
  stacked = false,
}: {
  stacked?: boolean;
}) {
  const { openLive, canStartWorkout, workoutOffer } = useActivityEditor();

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
      <LogActivityButton
        className="btn-ghost"
        testId="training-overview-log-activity"
      >
        Log activity
      </LogActivityButton>
    </div>
  );
}
