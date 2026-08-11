import { IconCalendarStats } from "@tabler/icons-react";
import type { Finding } from "@/lib/findings";
import FindingsList from "@/components/FindingsList";
import { dismissAdherencePattern } from "./intake-actions";

// Adherence-pattern observations (issue #45, domain 3) for the Supplements & Meds
// page: scheduled doses whose misses cluster on a specific weekday ("most Fridays")
// or on weekends, each suggesting a concrete schedule edit (an earlier slot / a
// day-specific reminder). Calm and observational — this is WHERE the misses cluster,
// not a safety reminder (dose reminders + missed-dose escalation stay their own,
// un-suppressible machinery). Each finding can be dismissed through the shared
// findings-bus suppression store; nothing renders when none are firing. Gathering
// now happens in SupplementsTab so the badge and panel share one exact count.
export default function AdherenceFindings({
  findings,
}: {
  findings: Finding[];
}) {
  return (
    <FindingsList
      findings={findings}
      dismissAction={async (fd) => {
        "use server";
        await dismissAdherencePattern(fd);
      }}
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
