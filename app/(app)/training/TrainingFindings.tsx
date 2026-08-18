import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import { buildTrainingObservationFindings } from "@/lib/rule-findings";
import TrainingWatchCard from "./TrainingWatchCard";
import { dismissTrainingObservation } from "./actions";

// Recent training observations for the Overview tab. Muscle-volume coverage now
// lives in the anatomy card, so this card only receives distinct patterns such as
// imbalance, staleness, and plateaus. Existing finding suppressions still apply.
export default async function TrainingFindings() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  const findings = activeFindings(
    [...buildTrainingObservationFindings(profile.id, now)],
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
