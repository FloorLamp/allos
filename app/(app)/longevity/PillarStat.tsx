import type { Pillar } from "@/lib/healthspan-pillars";
import {
  PILLAR_TONE_CLASS,
  TrendArrow,
} from "@/components/dashboard/HealthspanPillarsWidget";

// The Longevity page's rendering of ONE pillar's compact facts — the same
// label/value/detail/tone/trend the dashboard widget card shows (#1042 phase 4),
// styled through the SAME exported tone/trend atoms so the two formatters can't
// drift. Not a link: on the page the pillar sits inside the section that expands
// it (the widget's card links here).
export default function PillarStat({ pillar }: { pillar: Pillar }) {
  return (
    <div
      className="flex flex-col rounded-lg border border-black/10 p-2.5 dark:border-white/10"
      data-testid={`longevity-pillar-${pillar.key}`}
    >
      <span className="section-label">{pillar.label}</span>
      <span
        className={`mt-1 text-lg font-bold tabular-nums ${PILLAR_TONE_CLASS[pillar.tone]}`}
        data-testid={`longevity-pillar-${pillar.key}-value`}
      >
        {pillar.value}
      </span>
      <span className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {pillar.detail}
      </span>
      <span className="mt-1">
        <TrendArrow pillar={pillar} />
      </span>
    </div>
  );
}
