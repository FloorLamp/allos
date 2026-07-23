import { IconBinoculars } from "@tabler/icons-react";
import type { Finding } from "@/lib/findings";
import FindingsList from "@/components/FindingsList";
import {
  capDashboardList,
  COACHING_OBSERVATIONS_CAP,
} from "@/lib/dashboard-widgets";
import { dismissCoachingObservation } from "@/app/(app)/actions";

// Dashboard "Coaching observations" rollup (issue #449). The four #45 observational
// domains (training balance/plateau, body-metric hygiene, goal pacing, adherence
// patterns) render only on their own tabs; a finding a user never opens that tab for
// is indistinguishable from one that never fired. This calm rollup gives them
// dashboard REACH WITHOUT NOISE — no notification, no non-hideable hero slot (it's a
// hideable Customize widget) — surfacing the SAME findings (one computation:
// lib/rule-findings collectCoachingFindings) with their SAME dedupeKeys, so a dismiss
// here silences the origin tab too and vice-versa, through the shared findings bus.
// Renders through the shared FindingsList so its rows can't drift from the tab cards;
// returns nothing when there are no active observations.
export default function CoachingObservations({
  findings,
}: {
  findings: Finding[];
}) {
  const n = findings.length;
  // Cap + overflow (#1219): the rows beyond the cap stay reachable via the
  // FindingsList "Show N more" disclosure instead of being findable only by
  // knowing which tab each finding lives on.
  const { shown, overflow } = capDashboardList(
    findings,
    COACHING_OBSERVATIONS_CAP
  );
  return (
    <FindingsList
      findings={shown}
      moreFindings={overflow}
      dismissAction={dismissCoachingObservation}
      heading="Coaching observations"
      subtitle={
        n > shown.length
          ? `${shown.length} of ${n} patterns worth reviewing.`
          : `${n} pattern${n === 1 ? "" : "s"} worth reviewing.`
      }
      icon={
        <IconBinoculars
          className="h-4 w-4 shrink-0 text-slate-400"
          stroke={2}
        />
      }
      testid="coaching-observations"
    />
  );
}
