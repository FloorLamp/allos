// The "By domain" summary strip — ONE shared component rendered on BOTH the Training
// fitness grid's summary strip AND Longevity §2 "Fitness" (#1132 / #1042). Both read the
// SAME buildFitnessCheckModel.domains, so extracting the bars into one place keeps the
// color/label language from drifting between the two surfaces (the #221 formatter-parity
// discipline, one level down at presentation). The bars now color by FAVORABILITY (the
// domain's best measured percentile on the green→red ramp) instead of a flat single color.

import type { FitnessDomainSummary } from "@/lib/fitness-check-model";
import { heatTone } from "@/lib/fitness-tile";
import { TONE_BAR } from "./fitness-heat";
import { FitnessDomainGlyph } from "./fitness-pictograms";

const DOMAIN_LABEL: Record<string, string> = {
  endurance: "Endurance",
  strength: "Strength",
  balance: "Balance",
  flexibility: "Flexibility",
  mobility: "Mobility",
  body: "Body composition",
};

export default function FitnessDomainBars({
  domains,
  testIdPrefix = "fitness-domain",
}: {
  domains: FitnessDomainSummary[];
  testIdPrefix?: string;
}) {
  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-bars`}>
      {domains.map((d) => {
        const tone = heatTone(d.percentile);
        return (
          <div key={d.domain} data-testid={`${testIdPrefix}-${d.domain}`}>
            <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
              <span className="inline-flex items-center gap-1">
                {/* Decorative domain glyph (#1253) — the text label stays. */}
                <FitnessDomainGlyph domain={d.domain} />
                {DOMAIN_LABEL[d.domain] ?? d.domain}
              </span>
              <span>
                {d.percentile != null
                  ? `${d.percentile}th pct`
                  : `${d.measuredCount}/${d.totalCount}`}
              </span>
            </div>
            <div className="mt-0.5 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={`h-2 rounded-full ${TONE_BAR[tone]}`}
                style={{ width: `${d.percentile ?? 0}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
