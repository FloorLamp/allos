import { IconAlertTriangle } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getUnitPrefs } from "@/lib/settings";
import { getFindingSuppressions } from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { buildBodyHygieneFindings } from "@/lib/rule-findings";
import FindingsList from "@/components/FindingsList";
import { dismissBodyHygiene } from "./actions";

// Body-metric data-hygiene findings (issue #45, domain 5) for the Trends → Body tab:
// a day-over-day weight reading that jumped too much to be real (a scale glitch or a
// kg/lb entry mix-up) — caught before it skews every downstream trend, chart, and
// goal projection. Each links to the Body metrics history to fix/delete and can be
// dismissed through the shared findings-bus suppression store; nothing renders when
// none are firing.
export default async function BodyHygieneFindings() {
  const { login, profile } = await requireSession();
  const now = today(profile.id);
  const wu = getUnitPrefs(login.id).weightUnit;
  const findings = activeByKey(
    buildBodyHygieneFindings(profile.id, now, wu),
    (f) => f.dedupeKey,
    getFindingSuppressions(profile.id),
    now
  );
  return (
    <FindingsList
      findings={findings}
      dismissAction={async (fd) => {
        "use server";
        await dismissBodyHygiene(fd);
      }}
      heading="Data check"
      subtitle="Readings that look like an entry slip, worth a quick fix."
      icon={
        <IconAlertTriangle
          className="h-4 w-4 shrink-0 text-amber-500"
          stroke={2}
        />
      }
      testid="body-hygiene-findings"
    />
  );
}
