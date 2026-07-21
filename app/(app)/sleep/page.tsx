import Link from "next/link";
import { requireSession } from "@/lib/auth";
import {
  getLastNightSummary,
  getSleepRegularity,
  getSleepRegularityTrend,
  getSleepRegularityInsight,
  getSleepConsistency,
  getSleepStageComposition,
  getSleepMoodPairing,
  getOuraScores,
} from "@/lib/queries";
import { chartSeries } from "@/lib/chart-colors";
import { PageHeader } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import StackedBarCard from "@/components/StackedBarCard";
import SleepHero from "./SleepHero";
import ConsistencyStrip from "./ConsistencyStrip";
import SleepMoodSection from "./SleepMoodSection";
import OuraScores from "./OuraScores";

export const dynamic = "force-dynamic";

// The dedicated Sleep page (issue #1066): the expanded, composed formatter over
// the SAME sleep computations that already exist — the last-night hero + stage
// bar (getLastNightSummary, main-session per #1118), the SRI regularity trend
// (getSleepRegularity — the healthspan-pillar's own number; the pillar card now
// deep-links here), the consistency strip (getSleepConsistency), stage
// composition (getSleepStageComposition), and the #992 sleep↔mood pairing. NO new
// engine — every section is a thin formatter (the #221 rule). Factual and calm:
// no sleep score, no gamification (the pillars-not-a-composite stance).
export default async function SleepPage() {
  const { profile } = await requireSession();

  const summary = getLastNightSummary(profile.id);
  const sleepReg = getSleepRegularity(profile.id);
  const sleepRegTrend = getSleepRegularityTrend(profile.id).map((r) => ({
    date: r.date,
    value: r.sri,
  }));
  const sleepRegInsight = getSleepRegularityInsight(profile.id);
  const consistency = getSleepConsistency(profile.id);
  const stages = getSleepStageComposition(profile.id).map((r) => ({
    date: r.date,
    deep: r.deep / 60,
    rem: r.rem / 60,
    light: r.light / 60,
    awake: r.awake / 60,
  }));
  const moodPairing = getSleepMoodPairing(profile.id);
  const ouraScores = getOuraScores(profile.id);

  const hasAny =
    summary != null ||
    sleepReg != null ||
    consistency.length > 0 ||
    stages.length > 0 ||
    ouraScores.sleep != null ||
    ouraScores.readiness != null;

  return (
    <div>
      <PageHeader
        title="Sleep"
        subtitle="How you slept — last night, your regularity, and how it's trending. Factual signals, never a single score."
      />

      {summary && <SleepHero summary={summary} />}

      <OuraScores scores={ouraScores} />

      {!hasAny && (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="sleep-empty"
        >
          No sleep data yet. Connect a source that syncs sleep (Health Connect,
          Oura, Withings) and your nights will show up here — the hero, your
          regularity trend, and stage composition.{" "}
          <Link
            href="/data"
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Connect a source
          </Link>
          .
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {sleepReg != null && (
          <div className="card" data-testid="sleep-regularity">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                Sleep regularity
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                SRI · last {sleepReg.nights} nights
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-bold text-indigo-600 dark:text-indigo-300"
                data-testid="sri-value"
              >
                {Math.round(sleepReg.sri)}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                / 100
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Consistency of your sleep/wake timing (higher is steadier).
              Bedtime ±{sleepReg.bedtimeSdMin} min, wake ±
              {sleepReg.waketimeSdMin} min
              {sleepReg.socialJetlagMin != null
                ? `, ${(sleepReg.socialJetlagMin / 60).toFixed(1)} h weekend shift`
                : ""}
              .
            </p>
            {sleepRegInsight && (
              <p
                className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                data-testid="sri-insight"
              >
                {sleepRegInsight}
              </p>
            )}
            {sleepRegTrend.length > 1 && (
              <div className="mt-3">
                <LineChartCard
                  data={sleepRegTrend}
                  label="SRI"
                  color={chartSeries.violet}
                />
              </div>
            )}
          </div>
        )}

        {consistency.length > 0 && <ConsistencyStrip nights={consistency} />}

        {stages.length > 0 && (
          <div className="card lg:col-span-2" data-testid="sleep-stages">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Stage composition
            </h2>
            <StackedBarCard
              data={stages}
              unit=" h"
              series={[
                { key: "deep", label: "Deep", color: chartSeries.violet },
                { key: "rem", label: "REM", color: chartSeries.rose },
                { key: "light", label: "Light", color: chartSeries.emerald },
                { key: "awake", label: "Awake", color: chartSeries.amber },
              ]}
            />
          </div>
        )}

        {moodPairing.length >= 2 && (
          <div className="lg:col-span-2">
            <SleepMoodSection points={moodPairing} />
          </div>
        )}
      </div>
    </div>
  );
}
