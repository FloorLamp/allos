import { IconCalendarStats } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { buildAdherencePatternFindings } from "@/lib/rule-findings";
import FindingsList from "@/components/FindingsList";
import { dismissAdherencePattern } from "./actions";

// Adherence-pattern observations (issue #45, domain 3) for the Supplements & Meds
// page: scheduled doses whose misses cluster on a specific weekday ("most Fridays")
// or on weekends, each suggesting a concrete schedule edit (an earlier slot / a
// day-specific reminder). Calm and observational — this is WHERE the misses cluster,
// not a safety reminder (dose reminders + missed-dose escalation stay their own,
// un-suppressible machinery). Each finding can be dismissed through the shared
// findings-bus suppression store; nothing renders when none are firing.
export default async function AdherenceFindings() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  const findings = activeByKey(
    buildAdherencePatternFindings(profile.id, now),
    (f) => f.dedupeKey,
    getFindingSuppressions(profile.id),
    now
  );
  return (
    <FindingsList
      findings={findings}
      dismissAction={dismissAdherencePattern}
      heading="Adherence patterns"
      subtitle="Where your recent misses cluster — and a schedule tweak that might help."
      icon={
        <IconCalendarStats
          className="h-4 w-4 shrink-0 text-brand-500"
          stroke={2}
        />
      }
      testid="adherence-findings"
    />
  );
}
