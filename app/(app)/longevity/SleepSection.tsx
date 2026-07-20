import Link from "next/link";
import { requireSession } from "@/lib/auth";
import {
  getSleepRegularity,
  getSleepRegularityTrend,
  getSleepRegularityInsight,
} from "@/lib/queries";
import { chartSeries } from "@/lib/chart-colors";
import LineChartCard from "@/components/LineChartCard";
import type { LongevitySection } from "@/lib/longevity";
import PillarStat from "./PillarStat";

// Longevity §3 — Sleep regularity (#1042 phase 4): the existing SRI pillar
// computation (lib/sleep-regularity via the lib/queries/sleep seam — the same
// numbers Trends → Body and the weekly recap render), expanded with the timing
// spread, the travel insight, and the rolling trend. The headline stat is the
// SAME Pillar object the dashboard widget renders.
export default async function SleepSection({
  section,
}: {
  section: LongevitySection;
}) {
  const { profile } = await requireSession();
  const sleepReg = getSleepRegularity(profile.id);
  if (!sleepReg) return null; // pillar present ⇒ this exists; belt-and-braces
  const trend = getSleepRegularityTrend(profile.id).map((r) => ({
    date: r.date,
    value: r.sri,
  }));
  const insight = getSleepRegularityInsight(profile.id);

  return (
    <section
      id="sleep"
      data-testid="longevity-sleep"
      className="card mb-6 scroll-mt-20"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {section.title}
        </h2>
        <Link
          href="/trends?tab=body"
          className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Sleep charts
        </Link>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {section.pillars.map((p) => (
          <PillarStat key={p.key} pillar={p} />
        ))}
      </div>

      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        Over the last {sleepReg.nights} nights your bedtime varied ±
        {sleepReg.bedtimeSdMin} min and wake time ±{sleepReg.waketimeSdMin} min
        {sleepReg.socialJetlagMin != null
          ? `, with a ${(sleepReg.socialJetlagMin / 60).toFixed(1)} h weekend shift`
          : ""}
        . Higher SRI (0–100) means steadier sleep–wake timing.
      </p>
      {insight && (
        <p
          className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
          data-testid="longevity-sri-insight"
        >
          {insight}
        </p>
      )}
      {trend.length > 1 && (
        <div className="mt-3">
          <LineChartCard data={trend} label="SRI" color={chartSeries.violet} />
        </div>
      )}
    </section>
  );
}
