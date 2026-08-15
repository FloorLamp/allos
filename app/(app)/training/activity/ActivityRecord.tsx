"use client";

import { useRouter } from "next/navigation";
import TrainingLogCard from "../TrainingLogCard";
import type { TrainingLogCardData } from "@/lib/training-log-card";
import type { ActivityDetailSibling } from "@/lib/training-activity-detail";
import type { UnitPrefs } from "@/lib/settings";

// The activity page's client host for the record card (#2870 step 1). The
// record IS the Training Log card — one component, another host (#2897's
// three-host rule starts here). This wrapper exists because the exercise-name
// doors need a client callback: names deep-link their Analyze pages, the same
// door every exercise-level number carries.
export default function ActivityRecord({
  card,
  siblings,
  units,
  canWrite,
}: {
  card: TrainingLogCardData;
  siblings: ActivityDetailSibling[];
  units: UnitPrefs;
  canWrite: boolean;
}) {
  const router = useRouter();
  return (
    <TrainingLogCard
      activity={card.activity}
      timeText={card.timeText}
      durationText={card.durationText}
      distanceText={card.distanceText}
      speedText={card.speedText}
      heartRateText={card.heartRateText}
      calorieText={card.calorieText}
      metrics={card.metrics}
      gear={card.gear}
      parts={card.parts}
      fault={card.fault}
      provenance={card.provenance}
      routePolyline={card.routePolyline}
      mergeSiblings={siblings}
      keeperLabel={card.provenance.label}
      foldValues={card.foldValues}
      units={units}
      videos={card.videos}
      canWrite={canWrite}
      onSelectExercise={(name) =>
        router.push(
          `/training?tab=analyze&kind=strength&item=${encodeURIComponent(name)}`
        )
      }
    />
  );
}
