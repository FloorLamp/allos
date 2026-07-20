import { IconChecklist } from "@tabler/icons-react";
import type { Finding } from "@/lib/findings";
import FindingsList from "@/components/FindingsList";
import { dismissCoachingObservation } from "@/app/(app)/actions";

// Dashboard "Data quality" widget (issue #1045). The structural gaps that silently
// degrade engines — a missing birthdate, unset sex, unconfirmed RxCUIs, a failed
// document — surfaced as a leverage-ranked top-3 with a fix-it CTA each. NO score, NO
// percentage ring (the pillars-not-a-composite stance): a count and a list. Renders
// the SAME findings the coaching rollup + tab do (one computation, collectCoachingFindings)
// with their SAME `data-quality:` dedupeKeys, so a dismiss here silences the gap on the
// coaching rollup too, through the shared findings bus. Returns nothing when there are no
// gaps (absent-pillar rule) — a structurally-complete profile sees this widget disappear.
export default function DataQualityWidget({
  findings,
}: {
  findings: Finding[];
}) {
  const n = findings.length;
  const shown = findings.slice(0, 3);
  return (
    <FindingsList
      findings={shown}
      dismissAction={dismissCoachingObservation}
      heading="Data quality"
      subtitle={
        n > shown.length
          ? `${shown.length} of ${n} structural gaps holding engines back — highest-leverage first.`
          : `${n} structural gap${n === 1 ? "" : "s"} holding engines back.`
      }
      icon={
        <IconChecklist className="h-4 w-4 shrink-0 text-slate-400" stroke={2} />
      }
      testid="data-quality"
    />
  );
}
