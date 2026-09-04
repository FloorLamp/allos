"use client";

import { useActivityEditor } from "@/components/ActivityEditorProvider";
import type { TrainingLogCardData } from "@/lib/training-log-card";
import type { ProgressDelta } from "@/lib/progress-delta";
import type { ActivityStrengthRecord } from "@/lib/training-activity-detail";
import { activityEditDataHasStrength } from "@/lib/activity-form-model";
import ActivitySummaryLine from "@/components/activity/ActivitySummaryLine";
import ActivityMetricsLine from "@/components/activity/ActivityMetricsLine";
import ActivityPartRows from "@/components/activity/ActivityPartRows";
import {
  equipmentHref,
  strengthAnalyzeHref,
  trainingLogHref,
} from "@/lib/hrefs";
import type { MuscleId } from "@/lib/lifts";

// The canonical activity page's session body. The page owns identity, actions,
// navigation, and section chrome; this component renders the shared activity
// values without recreating the Training Log card presentation.
export default function ActivityRecord({
  card,
  partDeltas,
  partRecords,
  highlightMusclesByExercise,
  drillInsVisible = true,
}: {
  card: TrainingLogCardData;
  partDeltas?: (ProgressDelta | null)[];
  partRecords?: (ActivityStrengthRecord | null)[];
  highlightMusclesByExercise?: Record<string, MuscleId[]>;
  drillInsVisible?: boolean;
}) {
  const { strengthTrainingAvailable } = useActivityEditor();
  const strengthRecord = activityEditDataHasStrength(card.activity);

  const exerciseHref =
    drillInsVisible && (!strengthRecord || strengthTrainingAvailable)
      ? (name: string) => strengthAnalyzeHref(name)
      : undefined;

  return (
    <div data-testid="activity-record-body">
      <ActivitySummaryLine
        timeText={null}
        durationText={card.durationText}
        distanceText={card.distanceText}
        speedText={card.speedText}
        heartRateText={card.heartRateText}
        relativeEffort={card.activity.imported_metrics?.relative_effort}
        relativeEffortProvider={card.provenance.label}
        calorieText={card.calorieText}
        intensity={card.activity.intensity}
        heartRateZone={card.activity.heart_rate_zone}
        density="detail"
      />
      {(card.metrics.length > 0 || card.gear || card.parts.length > 0) && (
        <div data-testid="activity-details" className="mt-4">
          <ActivityMetricsLine
            metrics={card.metrics}
            gear={
              card.gear
                ? {
                    label: card.gear,
                    href:
                      drillInsVisible && card.activity.equipment_id != null
                        ? equipmentHref(card.activity.equipment_id)
                        : undefined,
                  }
                : null
            }
          />
          <ActivityPartRows
            parts={card.parts}
            className={
              card.metrics.length > 0 || card.gear
                ? "mt-3 border-t border-black/5 pt-2 dark:border-white/10"
                : ""
            }
            partDeltas={
              strengthRecord && !strengthTrainingAvailable
                ? undefined
                : partDeltas
            }
            partRecords={
              !drillInsVisible || (strengthRecord && !strengthTrainingAvailable)
                ? undefined
                : partRecords
            }
            exerciseHref={exerciseHref}
            highlightMusclesByExercise={highlightMusclesByExercise}
            // The muscle badge is the Log's tag filter's door (#4079): "show me
            // every session that worked this".
            tagHref={(kind, value) => trainingLogHref({ tag: { kind, value } })}
          />
        </div>
      )}
    </div>
  );
}
