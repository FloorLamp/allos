import Link from "next/link";
import {
  IconArrowUpRight,
  IconArrowDownRight,
  IconMinus,
} from "@tabler/icons-react";
import type { Pillar, PillarTone } from "@/lib/healthspan-pillars";
import WidgetHeader from "./WidgetHeader";

// Dashboard healthspan-pillars widget (issue #161): a row of evidence-backed
// longevity pillars — VO₂ Max percentile, sleep regularity, biological age, and
// the share of tracked biomarkers in their optimal range — each a thin formatter
// over its source computation (never re-derived here) and deep-linking to its
// detail surface. Deliberately PILLARS, not a composite score. Only the pillars
// whose data exists are passed in, so absent pillars simply don't render.

const TONE_VALUE: Record<PillarTone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-rose-600 dark:text-rose-400",
  neutral: "text-slate-700 dark:text-slate-200",
};

function TrendArrow({ pillar }: { pillar: Pillar }) {
  if (!pillar.trend) return null;
  const Icon =
    pillar.trend.direction === "up"
      ? IconArrowUpRight
      : pillar.trend.direction === "down"
        ? IconArrowDownRight
        : IconMinus;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-slate-400 dark:text-slate-500">
      <Icon className="h-3.5 w-3.5" stroke={1.75} aria-hidden />
      {pillar.trend.label}
    </span>
  );
}

export default function HealthspanPillarsWidget({
  pillars,
}: {
  pillars: Pillar[];
}) {
  return (
    <div className="card" data-testid="healthspan-pillars-widget">
      <WidgetHeader
        title="Healthspan pillars"
        href="/trends"
        linkLabel="Trends"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        {pillars.map((p) => (
          <Link
            key={p.key}
            href={p.href}
            className="flex flex-col rounded-lg border border-slate-200 p-2.5 transition hover:border-brand-300 dark:border-ink-700 dark:hover:border-brand-700"
            data-testid={`pillar-${p.key}`}
          >
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {p.label}
            </span>
            <span
              className={`mt-1 text-lg font-bold tabular-nums ${TONE_VALUE[p.tone]}`}
              data-testid={`pillar-${p.key}-value`}
            >
              {p.value}
            </span>
            <span className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {p.detail}
            </span>
            <span className="mt-1">
              <TrendArrow pillar={p} />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
