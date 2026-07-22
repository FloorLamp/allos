import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  getLastNightSummary,
  getSleepDurationTrend,
  getSleepRegularity,
  getSleepRegularityTrend,
  getSleepRegularityInsight,
  getSleepConsistency,
  getSleepStageComposition,
  getSleepMoodData,
  getOuraScores,
} from "@/lib/queries";
import { chartSeries } from "@/lib/chart-colors";
import { sleepRecordPresentation } from "@/lib/sleep-summary";
import { sriPresentation } from "@/lib/sleep-regularity";
import { PageHeader } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import SleepHero from "./SleepHero";
import ConsistencyStrip from "./ConsistencyStrip";
import SleepMoodSection from "./SleepMoodSection";
import SleepLogAction from "./SleepLogAction";
import OuraScores from "./OuraScores";
import SleepTrendsSection from "./SleepTrendsSection";

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
  const { login, profile } = await requireSession();
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const todayStr = today(profile.id);

  const summary = getLastNightSummary(profile.id);
  const summaryPresentation = summary
    ? sleepRecordPresentation(summary.wakeDay, todayStr, formatPrefs)
    : null;
  const duration = getSleepDurationTrend(profile.id, 90).map((r) => ({
    date: r.date,
    value: r.value / 60,
  }));
  const sleepReg = getSleepRegularity(profile.id);
  const sleepRegDisplay = sleepReg ? sriPresentation(sleepReg.sri) : null;
  const sleepRegTrend = getSleepRegularityTrend(profile.id).map((r) => ({
    date: r.date,
    value: r.sri,
  }));
  const sleepRegInsight = getSleepRegularityInsight(profile.id);
  const consistency = getSleepConsistency(profile.id);
  const stages = getSleepStageComposition(profile.id, 90).map((r) => ({
    date: r.date,
    deep: r.deep / 60,
    rem: r.rem / 60,
    light: r.light / 60,
    awake: r.awake / 60,
  }));
  const sleepMood = getSleepMoodData(profile.id);
  const sleepMoodMinDate = shiftDateStr(todayStr, -(sleepMood.windowDays - 1));
  const ouraScores = getOuraScores(profile.id);
  const lastNightBedtimeSupplements = summary
    ? (sleepMood.history.find((row) => row.date === summary.wakeDay)
        ?.bedtimeSupplements ?? null)
    : null;

  const hasAny =
    summary != null ||
    duration.length > 0 ||
    sleepReg != null ||
    consistency.length > 0 ||
    stages.length > 0 ||
    ouraScores.sleep != null ||
    ouraScores.readiness != null;

  return (
    <div className="mx-auto w-full max-w-6xl" data-testid="sleep-page">
      <PageHeader
        title="Sleep"
        subtitle="Duration, timing, stages, and how sleep relates to mood."
        action={
          <SleepLogAction
            history={sleepMood.history}
            today={todayStr}
            minDate={sleepMoodMinDate}
            testId="sleep-add-entry-header"
          />
        }
      />

      {summary &&
        summaryPresentation &&
        summaryPresentation.freshness !== "stale" && (
          <SleepHero
            summary={summary}
            timeFormat={formatPrefs.timeFormat}
            presentation={summaryPresentation}
            bedtimeSupplements={lastNightBedtimeSupplements}
          />
        )}

      {summaryPresentation?.freshness === "stale" && (
        <div className="card mb-6" data-testid="sleep-stale">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            No sleep recorded last night
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Your latest sleep record is too old to present as current. Sync a
            connected source or log the duration manually.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link href="/data" className="btn btn-sm">
              Sync a source
            </Link>
            <SleepLogAction
              history={sleepMood.history}
              today={todayStr}
              minDate={sleepMoodMinDate}
              label="Add entry →"
              className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
              testId="sleep-add-entry-stale"
            />
          </div>
        </div>
      )}

      <SleepTrendsSection
        duration={duration}
        stages={stages}
        endDate={todayStr}
        regularityCard={
          sleepReg != null && sleepRegDisplay != null ? (
            <div className="card" data-testid="sleep-regularity">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                  Sleep regularity
                </h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  SRI · last {sleepReg.nights} nights
                </span>
              </div>
              <div
                className="text-3xl font-bold text-indigo-600 dark:text-indigo-300"
                data-testid="sri-value"
              >
                {sleepRegDisplay.text}
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                SRI ranges from −100 to 100; higher is steadier. Bedtime ±
                {sleepReg.bedtimeSdMin} min, wake ±{sleepReg.waketimeSdMin} min
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
                    decimals={0}
                    yDomain={[
                      Math.min(
                        60,
                        Math.floor(
                          Math.min(
                            ...sleepRegTrend.map((point) => point.value)
                          ) / 10
                        ) * 10
                      ),
                      100,
                    ]}
                  />
                </div>
              )}
            </div>
          ) : null
        }
        consistencyCard={
          consistency.length > 0 ? (
            <ConsistencyStrip
              nights={consistency}
              timeFormat={formatPrefs.timeFormat}
            />
          ) : null
        }
      />

      {!hasAny && (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="sleep-empty"
        >
          No sleep data yet. Log a duration manually or connect Health Connect,
          Oura, or Withings for bed/wake timing and stage detail.{" "}
          <SleepLogAction
            history={sleepMood.history}
            today={todayStr}
            minDate={sleepMoodMinDate}
            label="Add entry"
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
            testId="sleep-add-entry-empty"
          />{" "}
          or{" "}
          <Link
            href="/data"
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            connect a source
          </Link>
          .
        </p>
      )}

      <div className="min-w-0 space-y-6">
        {(ouraScores.sleep || ouraScores.readiness) && (
          <div className="min-w-0">
            <OuraScores scores={ouraScores} />
          </div>
        )}

        <div className="min-w-0">
          <SleepMoodSection
            points={sleepMood.points}
            history={sleepMood.history}
            windowDays={sleepMood.windowDays}
            formatPrefs={formatPrefs}
          />
        </div>
      </div>
    </div>
  );
}
