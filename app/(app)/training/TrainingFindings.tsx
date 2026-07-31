import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import {
  buildTrainingObservationFindings,
  buildMuscleVolumeFindings,
} from "@/lib/rule-findings";
import TrainingWatchCard from "./TrainingWatchCard";
import { dismissTrainingObservation } from "./actions";

// Training-balance observations (issue #45, domain 4) for the Training → Overview
// tab: a push/pull volume imbalance over the trailing 4 weeks, exercises that have
// gone stale, and lifts whose estimated 1RM has plateaued (~6 weeks flat → deload or
// variation), plus per-muscle weekly volume-band shortfalls (#742: a muscle trained
// below its weekly band floor, gated by cold start / deload). Calm and observational —
// NOT a "what to train" recommendation (that's the next-workout card). Each can be
// dismissed through the shared findings-bus suppression store; nothing renders when
// none are firing.
//
// #1496: the per-muscle shortfalls render as ONE expandable rollup row and the card
// caps at three rows + "show all" (TrainingWatchCard over the pure
// lib/training-findings-rollup). Rendering only — the engines, the dedupeKeys and the
// dismiss action below are untouched, so a dismiss inside the rollup is still the
// same item-wise write to the shared bus.
export default async function TrainingFindings() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  const findings = activeFindings(
    [
      ...buildTrainingObservationFindings(profile.id, now),
      ...buildMuscleVolumeFindings(profile.id, now),
    ],
    getFindingSuppressions(profile.id),
    now
  );
  return (
    <TrainingWatchCard
      findings={findings}
      dismissAction={dismissTrainingObservation}
    />
  );
}
