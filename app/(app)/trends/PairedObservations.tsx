import { IconArrowsShuffle } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { buildPairedObservationFindings } from "@/lib/rule-findings";
import FindingsList from "@/components/FindingsList";
import { dismissPairedObservation } from "./actions";

// The paired-observations registry's home surface (#2177): Trends → Insights, the
// hub's "derived views over your own data" tab, beside the situation-impact cards
// that answer the neighbouring question from declared windows.
//
// It renders the SAME findings collectCoachingFindings gathers, with the SAME
// dedupeKeys, so a dismiss here silences the dashboard rollup too through the shared
// bus (and vice versa). Nothing renders when no registered pair clears its gates —
// the absent-pillar rule: under the gates there is no card, no placeholder and no
// "not enough data yet" nag.
export default async function PairedObservations() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  const findings = activeByKey(
    buildPairedObservationFindings(profile.id, now),
    (f) => f.dedupeKey,
    getFindingSuppressions(profile.id),
    now
  );
  return (
    <FindingsList
      findings={findings}
      dismissAction={async (fd) => {
        "use server";
        await dismissPairedObservation(fd);
      }}
      heading="Two things at once"
      subtitle="How one measurement reads on the days you logged something else. Averages from your own log — not a cause."
      icon={
        <IconArrowsShuffle
          className="h-4 w-4 shrink-0 text-slate-400"
          stroke={2}
        />
      }
      testid="paired-observations"
      collapsible
    />
  );
}
