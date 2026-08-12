import Link from "next/link";
import type { Pillar } from "@/lib/longevity-pillars";
import {
  PILLAR_TONE_CLASS,
  PillarToneBadge,
  TrendArrow,
} from "@/components/dashboard/HealthspanPillarsWidget";

// The Longevity page's rendering of ONE pillar's compact facts — the same
// label/value/detail/tone/trend the dashboard widget card shows (#1042 phase 4),
// styled through the SAME exported tone/trend atoms so the two formatters can't
// drift. Not a link: on the page the pillar sits inside the section that expands
// it (the widget's card links here).
//
// `linkLabel` is the exception, and it is the SECTION's call rather than this
// component's (#1921): a pillar whose evidence does NOT live on this page — the
// strength pillar, whose href is the Analyze panel for the lift it names — offers one
// onward link, the same shape SleepSection already puts in its own header. Given, the
// stat renders `pillar.href`; omitted, it stays the plain read-only stat every other
// pillar is. Deliberately not derived from "the href leaves /longevity", which would
// also fire for sleep-regularity and duplicate that section's existing header link.
export default function PillarStat({
  pillar,
  linkLabel,
}: {
  pillar: Pillar;
  linkLabel?: string;
}) {
  return (
    <div
      className="flex flex-col rounded-lg border border-black/10 p-2.5 dark:border-white/10"
      data-testid={`longevity-pillar-${pillar.key}`}
      data-tone={pillar.tone}
    >
      <span className="section-label">{pillar.label}</span>
      <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span
          className={`text-lg font-bold tabular-nums ${PILLAR_TONE_CLASS[pillar.tone]}`}
          data-testid={`longevity-pillar-${pillar.key}-value`}
        >
          {pillar.value}
        </span>
        <PillarToneBadge tone={pillar.tone} />
      </span>
      <span className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {pillar.detail}
      </span>
      <span className="mt-1">
        <TrendArrow pillar={pillar} />
      </span>
      {linkLabel && (
        <Link
          href={pillar.href}
          className="mt-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          data-testid={`longevity-pillar-${pillar.key}-link`}
        >
          {linkLabel}
        </Link>
      )}
    </div>
  );
}
