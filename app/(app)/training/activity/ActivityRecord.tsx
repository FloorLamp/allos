"use client";

import { useActivityEditor } from "@/components/ActivityEditorProvider";
import type { TrainingLogCardData } from "@/lib/training-log-card";
import type { ProgressDelta } from "@/lib/progress-delta";
import type { ActivityStrengthRecord } from "@/lib/training-activity-detail";
import { activityEditDataHasStrength } from "@/lib/activity-form-model";
import Link from "next/link";
import ActivitySummaryLine from "@/components/activity/ActivitySummaryLine";
import ActivityPartRows from "@/components/activity/ActivityPartRows";
import { equipmentHref, strengthAnalyzeHref } from "@/lib/hrefs";
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
          {(card.metrics.length > 0 || card.gear) && (
            <ul
              data-testid="activity-metrics"
              aria-label="Activity details"
              className="flex flex-wrap text-xs tabular-nums text-slate-500 dark:text-slate-400"
            >
              {card.metrics.map((metric, index) => (
                <li key={metric} className="whitespace-nowrap">
                  {index > 0 ? (
                    <span aria-hidden className="mx-2">
                      ·
                    </span>
                  ) : null}
                  {metric}
                </li>
              ))}
              {card.gear ? (
                <li className="whitespace-nowrap">
                  {card.metrics.length > 0 ? (
                    <span aria-hidden className="mx-2">
                      ·
                    </span>
                  ) : null}
                  {drillInsVisible && card.activity.equipment_id != null ? (
                    <Link
                      href={equipmentHref(card.activity.equipment_id)}
                      data-testid="activity-gear"
                      className="hover:text-slate-700 hover:underline dark:hover:text-slate-200"
                    >
                      {card.gear}
                    </Link>
                  ) : (
                    card.gear
                  )}
                </li>
              ) : null}
            </ul>
          )}
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
          />
        </div>
      )}
    </div>
  );
}
