import { IconTarget } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import { buildGoalPacingFindings } from "@/lib/rule-findings";
import FindingsList from "@/components/FindingsList";
import { dismissGoalPacing } from "@/app/(app)/goals/actions";

// Goal-pacing findings (issue #45, domain 6) for the Training → Goals tab: a weight
// goal that's off pace for its target date (trending away, or landing well past the
// deadline at the current robust pace), plus a gentle safe-rate caution when weight
// is dropping faster than ~1%/week. Reuses the SAME projection the Trends → Body
// chart draws (projectGoal), so the finding and the chart caption can't disagree.
// Each can be dismissed through the shared findings-bus suppression store; nothing
// renders when none are firing.
export default async function GoalPacingFindings() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  const findings = activeFindings(
    buildGoalPacingFindings(profile.id, now),
    getFindingSuppressions(profile.id),
    now
  );
  return (
    <FindingsList
      findings={findings}
      dismissAction={async (fd) => {
        "use server";
        await dismissGoalPacing(fd);
      }}
      heading="Goal pacing"
      subtitle="How your goals are tracking against their target dates."
      icon={
        <IconTarget className="h-4 w-4 shrink-0 text-amber-500" stroke={2} />
      }
      testid="goal-pacing-findings"
    />
  );
}
