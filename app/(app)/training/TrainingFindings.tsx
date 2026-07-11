import { IconBarbell } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { buildTrainingObservationFindings } from "@/lib/rule-findings";
import FindingsList from "@/components/FindingsList";
import { dismissTrainingObservation } from "./actions";

// Training-balance observations (issue #45, domain 4) for the Training → Overview
// tab: a push/pull volume imbalance over the trailing 4 weeks, exercises that have
// gone stale, and lifts whose estimated 1RM has plateaued (~6 weeks flat → deload or
// variation). Calm and observational — NOT a "what to train" recommendation (that's
// the next-workout card). Each can be dismissed through the shared findings-bus
// suppression store; nothing renders when none are firing.
export default async function TrainingFindings() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  const findings = activeByKey(
    buildTrainingObservationFindings(profile.id, now),
    (f) => f.dedupeKey,
    getFindingSuppressions(profile.id),
    now
  );
  return (
    <FindingsList
      findings={findings}
      dismissAction={dismissTrainingObservation}
      heading="Training watch"
      subtitle="Patterns worth a look from your recent training."
      icon={
        <IconBarbell className="h-4 w-4 shrink-0 text-amber-500" stroke={2} />
      }
      testid="training-findings"
    />
  );
}
