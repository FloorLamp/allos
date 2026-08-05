// The "By domain" summary strip — ONE shared component rendered on BOTH the Training
// fitness grid's summary strip AND Longevity §2 "Fitness" (#1132 / #1042). Both read the
// SAME buildFitnessCheckModel.domains, so extracting the bars into one place keeps the
// color/label language from drifting between the two surfaces (the #221 formatter-parity
// discipline, one level down at presentation). The bars color by FAVORABILITY on the
// green→red ramp.
//
// #2025 — the bar is the domain's BEST norms-backed result, and now SAYS so. It was
// carried as an undifferentiated `percentile` and labelled "72nd pct", which reads as a
// summary of the domain when it is the summary of its strongest test; a domain with one
// excellent and one weak result was represented by the excellent one alone. The model
// renamed the field `bestPercentile` and added the lowest result plus the norms-test
// count, so this strip shows the SPREAD and captions what the bar is. Because this is the
// only formatter both consuming surfaces use, saying it once says it on both.

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

// The right-hand read-out for one domain. With a norms-backed result it names the BEST
// one, and adds the lowest when a second norms test disagrees — the two together are an
// honest range where the single number was a claim about the whole domain. With no norms
// result it falls back to the measured/total coverage it always showed.
function domainReadout(d: FitnessDomainSummary): string {
  if (d.bestPercentile == null) return `${d.measuredCount}/${d.totalCount}`;
  const best = `best ${d.bestPercentile}th pct`;
  if (
    d.normsCount > 1 &&
    d.lowestPercentile != null &&
    d.lowestPercentile !== d.bestPercentile
  )
    return `${best} · low ${d.lowestPercentile}th`;
  return best;
}

export default function FitnessDomainBars({
  domains,
  testIdPrefix = "fitness-domain",
}: {
  domains: FitnessDomainSummary[];
  testIdPrefix?: string;
}) {
  const anyNorms = domains.some((d) => d.bestPercentile != null);
  const staleTotal = domains.reduce((n, d) => n + d.coverage.stale, 0);
  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-bars`}>
      {domains.map((d) => {
        const tone = heatTone(d.bestPercentile);
        return (
          <div key={d.domain} data-testid={`${testIdPrefix}-${d.domain}`}>
            <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
              <span className="inline-flex items-center gap-1">
                {/* Decorative domain glyph (#1253) — the text label stays. */}
                <FitnessDomainGlyph domain={d.domain} />
                {DOMAIN_LABEL[d.domain] ?? d.domain}
              </span>
              <span>{domainReadout(d)}</span>
            </div>
            <div className="mt-0.5 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={`h-2 rounded-full ${TONE_BAR[tone]}`}
                style={{ width: `${d.bestPercentile ?? 0}%` }}
              />
            </div>
          </div>
        );
      })}
      {anyNorms && (
        <p
          data-testid={`${testIdPrefix}-caption`}
          className="pt-1 text-xs text-slate-500 dark:text-slate-400"
        >
          Each bar is the domain&apos;s best result against published norms —
          not an average, and not a score for the whole domain.
          {staleTotal > 0
            ? ` ${staleTotal} measured test${
                staleTotal === 1 ? "" : "s"
              } past a re-check window.`
            : ""}
        </p>
      )}
    </div>
  );
}
