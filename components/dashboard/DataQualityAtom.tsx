import { IconChecklist } from "@tabler/icons-react";
import type { Finding } from "@/lib/findings";
import FindingsList from "@/components/FindingsList";
import { dismissDataQualityGap } from "@/app/(app)/actions";

// One structural gap as one dashboard statement. The finding is the same shared-bus
// object rendered on its origin surface, so dismissing it silences the same fact there.
export default function DataQualityAtom({ finding }: { finding: Finding }) {
  return (
    <FindingsList
      findings={[finding]}
      dismissAction={dismissDataQualityGap}
      heading="Data quality"
      subtitle="1 structural gap holding engines back."
      icon={
        <IconChecklist className="h-4 w-4 shrink-0 text-slate-400" stroke={2} />
      }
      testid="data-quality"
    />
  );
}
