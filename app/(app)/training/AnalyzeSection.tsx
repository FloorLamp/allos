import Link from "next/link";
import {
  getCardioByActivity,
  getExerciseComparison,
  getGoalProgressMap,
  getGoals,
  getLatestBodyMetric,
  getRecentByExercise,
  getSportByActivity,
  getStrengthByExercise,
  type CardioStat,
  type GoalProgress,
  type SportStat,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { exerciseHistoryKey } from "@/lib/lifts";
import { chartSeries } from "@/lib/chart-colors";
import { getUnitPrefs, getUserSex } from "@/lib/settings";
import type { Sex } from "@/lib/types";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { fmtDistance, fmtKmh, fmtWeight } from "@/lib/units";
import { formatLongDate } from "@/lib/format-date";
import { formatMinutes } from "@/lib/duration";
import {
  RANGES,
  STRENGTH_METRICS,
  CARDIO_METRICS,
  benchmarkState,
  type BenchmarkState,
  buildAnalyzeOptions,
  cardioMetricValue,
  coerceCardioMetric,
  coerceKind,
  coerceRange,
  coerceStrengthMetric,
  defaultMetric,
  e1rmText,
  bestText,
  firstName,
  formatIntensity,
  formatRatio,
  newestFirst,
  rangeFilter,
  strengthMetricValue,
  type AnalyzeKind,
  type AnalyzeView,
  type RangeId,
} from "@/lib/analyze-view";
import { EmptyState } from "@/components/ui";
import CardioDetailPanel from "@/components/CardioDetailPanel";
import ExerciseDetailPanel from "@/components/ExerciseDetailPanel";
import LineChartCard from "@/components/LineChartCard";
import SportDetailPanel from "@/components/SportDetailPanel";
import AnalyzePicker from "./AnalyzePicker";
import type { AppRoute } from "@/lib/hrefs";

export default async function AnalyzeSection({
  kind,
  item,
  exercise,
  metric,
  range,
}: {
  kind?: string;
  item?: string;
  exercise?: string;
  metric?: string;
  range?: string;
}) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const du = units.distanceUnit;
  const strength = getStrengthByExercise(profile.id);
  const cardio = getCardioByActivity(profile.id, du);
  const sports = getSportByActivity(profile.id);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");
  const recentByExercise = getRecentByExercise(profile.id, wu);
  const goals = getGoals(profile.id);
  const goalProgress = Object.fromEntries(
    getGoalProgressMap(profile.id, goals)
  );
  const sex = getUserSex(profile.id);

  if (strength.length === 0 && cardio.length === 0 && sports.length === 0) {
    return (
      <EmptyState
        message="No training data yet. Log an activity to analyze progress over time."
        action={{ href: "/training?tab=log", label: "Go to Log" }}
      />
    );
  }

  const activeKind = coerceKind(kind, {
    strength: strength.length > 0,
    cardio: cardio.length > 0,
    sport: sports.length > 0,
  });
  const selectedName =
    item ??
    exercise ??
    firstName(activeKind, strength, cardio, sports) ??
    strength[0]?.exercise ??
    cardio[0]?.activity ??
    sports[0]?.sport ??
    "";
  const activeRange = coerceRange(range);
  const fromDate = rangeStart(profile.id, activeRange);
  const hrefFor = (patch: {
    kind?: AnalyzeKind;
    item?: string;
    metric?: string;
    range?: RangeId;
  }): AppRoute => {
    const nextKind = patch.kind ?? activeKind;
    const params = new URLSearchParams();
    params.set("tab", "analyze");
    params.set("kind", nextKind);
    params.set("item", patch.item ?? selectedName);
    params.set("range", patch.range ?? activeRange);
    const metricForKind =
      patch.metric ??
      defaultMetric(
        nextKind,
        metric,
        cardio.find((c) => c.activity === selectedName)
      );
    params.set("metric", metricForKind);
    return `/training?${params.toString()}`;
  };
  const analyzeOptions = buildAnalyzeOptions({
    strength,
    cardio,
    sports,
    activeRange,
    metric,
  });

  const view =
    activeKind === "cardio"
      ? cardioView({
          stat: cardio.find((c) => c.activity === selectedName) ?? cardio[0],
          metric,
          fromDate,
          units,
        })
      : activeKind === "sport"
        ? sportView({
            stat: sports.find((s) => s.sport === selectedName) ?? sports[0],
            fromDate,
          })
        : strengthView({
            stat:
              strength.find((s) => s.exercise === selectedName) ?? strength[0],
            profileId: profile.id,
            metric,
            fromDate,
            units,
            bodyweightKg,
            recentByExercise,
            goals,
            goalProgress,
            sex,
          });

  const currentItem = view.name;
  const currentPickerLabel =
    analyzeOptions.find((o) => o.kind === activeKind && o.item === currentItem)
      ?.label ?? currentItem;

  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]">
      <div className="space-y-6">
        <div className="card relative z-20 focus-within:z-50">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <label className="block min-w-0">
              <span className="mb-1 block section-label">
                Exercise or activity
              </span>
              <AnalyzePicker
                options={analyzeOptions}
                value={currentPickerLabel}
              />
            </label>
            <Link
              href={`/training?tab=log#activity-${view.latestActivityId}`}
              className="btn-ghost h-10 justify-center"
            >
              History
            </Link>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-black/10 p-0.5 dark:border-white/10">
              {view.metrics.map((m) => (
                <Link
                  key={m.id}
                  href={hrefFor({ item: currentItem, metric: m.id })}
                  className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                    m.id === view.metric
                      ? "bg-brand-600 text-white"
                      : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                  }`}
                >
                  {m.label}
                </Link>
              ))}
            </div>
            <div className="flex rounded-md border border-black/10 p-0.5 dark:border-white/10">
              {RANGES.map((r) => (
                <Link
                  key={r.id}
                  href={hrefFor({ item: currentItem, range: r.id })}
                  className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                    r.id === activeRange
                      ? "bg-slate-800 text-white dark:bg-slate-100 dark:text-ink-950"
                      : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                  }`}
                >
                  {r.label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                {view.name}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {view.chartLabel} across logged sessions
              </p>
            </div>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {view.sessions.length}{" "}
              {view.sessions.length === 1 ? "session" : "sessions"}
            </span>
          </div>
          <LineChartCard
            data={view.chart}
            label={view.chartLabel}
            unit={view.chartUnit}
            color={view.color}
          />
        </div>

        <div className="card">
          <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Sessions
          </h3>
          {view.sessions.length === 0 ? (
            <EmptyState message="No sessions in this range. Widen the range or log one." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap">
                <thead>
                  <tr className="border-b border-black/5 dark:border-white/10">
                    <th className="th">Date</th>
                    {view.columns.map((c) => (
                      <th key={c} className="th">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.sessions.map((s, i) => (
                    <tr
                      key={`${s.activityId}-${i}`}
                      className="border-b border-black/5 dark:border-white/10"
                    >
                      <td className="td">
                        <Link
                          href={`/training?tab=log#activity-${s.activityId}`}
                          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                        >
                          {formatLongDate(s.date)}
                        </Link>
                      </td>
                      {s.cells.map((cell, i) => (
                        <td
                          key={i}
                          className="td text-slate-600 dark:text-slate-300"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-6">{view.detail}</aside>
    </section>
  );
}

function strengthView({
  stat,
  profileId,
  metric,
  fromDate,
  units,
  bodyweightKg,
  recentByExercise,
  goals,
  goalProgress,
  sex,
}: {
  stat: ReturnType<typeof getStrengthByExercise>[number];
  profileId: number;
  metric?: string;
  fromDate: string | null;
  units: ReturnType<typeof getUnitPrefs>;
  bodyweightKg: number | null;
  recentByExercise: ReturnType<typeof getRecentByExercise>;
  goals: ReturnType<typeof getGoals>;
  goalProgress: Record<number, GoalProgress>;
  sex: Sex | null;
}): AnalyzeView {
  const activeMetric = coerceStrengthMetric(metric);
  const sessions = rangeFilter(
    getExerciseComparison(profileId, stat.exercise, units.weightUnit),
    fromDate
  );
  const newest = [...sessions].sort(newestFirst);
  const chartMetric = STRENGTH_METRICS.find((m) => m.id === activeMetric)!;
  const benchmark = benchmarkState(
    stat.exercise,
    sex,
    stat.e1rmKg,
    bodyweightKg
  );
  return {
    name: stat.exercise,
    metric: activeMetric,
    metrics: STRENGTH_METRICS,
    chartLabel: chartMetric.chartLabel,
    chartUnit: activeMetric === "reps" ? "" : ` ${units.weightUnit}`,
    color: chartSeries.violet,
    latestActivityId: newest[0]?.activityId ?? stat.lastActivityId,
    chart: sessions.map((s) => ({
      date: s.date,
      value: strengthMetricValue(s, activeMetric, units.weightUnit),
    })),
    columns: ["Sets", "Best", "Est. 1RM", "Volume"],
    sessions: newest.map((s) => ({
      activityId: s.activityId,
      date: s.date,
      cells: [
        String(s.setCount),
        bestText(s, units.weightUnit),
        e1rmText(s, units.weightUnit),
        fmtWeight(s.volumeKg, units.weightUnit),
      ],
    })),
    detail: (
      <>
        <div className="card">
          <ExerciseDetailPanel
            stat={stat}
            bodyweightKg={bodyweightKg}
            units={units}
            recent={recentByExercise[exerciseHistoryKey(stat.exercise)]}
            goals={goals}
            goalProgress={goalProgress}
            showTrend={false}
            showRecent={false}
            showLevel={false}
            sex={sex}
          />
        </div>
        {benchmark && (
          <BenchmarkCard
            exercise={stat.exercise}
            state={benchmark}
            weightUnit={units.weightUnit}
          />
        )}
      </>
    ),
  };
}

function cardioView({
  stat,
  metric,
  fromDate,
  units,
}: {
  stat: CardioStat;
  metric?: string;
  fromDate: string | null;
  units: ReturnType<typeof getUnitPrefs>;
}): AnalyzeView {
  const activeMetric = coerceCardioMetric(metric, stat);
  const metrics = CARDIO_METRICS.filter(
    (m) => stat.hasDistance || m.id === "duration"
  );
  const sessions = rangeFilter(stat.trend, fromDate);
  const newest = [...sessions].sort(newestFirst);
  const chartMetric = metrics.find((m) => m.id === activeMetric)!;
  return {
    name: stat.activity,
    metric: activeMetric,
    metrics,
    chartLabel: chartMetric.chartLabel,
    chartUnit:
      activeMetric === "distance"
        ? ` ${units.distanceUnit}`
        : activeMetric === "speed"
          ? ` ${units.distanceUnit}/h`
          : " min",
    color: activeMetric === "speed" ? chartSeries.brand : chartSeries.emerald,
    latestActivityId: newest[0]?.activityId ?? stat.lastActivityId,
    chart: sessions.map((s) => ({
      date: s.date,
      value: cardioMetricValue(s, activeMetric, units.distanceUnit),
    })),
    columns: ["Distance", "Duration", "Avg speed"],
    sessions: newest.map((s) => ({
      activityId: s.activityId,
      date: s.date,
      cells: [
        s.distanceKm > 0 ? fmtDistance(s.distanceKm, units.distanceUnit) : "—",
        formatMinutes(s.durationMin || null),
        s.speedKmh == null ? "—" : fmtKmh(s.speedKmh, units.distanceUnit),
      ],
    })),
    detail: (
      <div className="card">
        <CardioDetailPanel
          stat={stat}
          units={units}
          showTrend={false}
          showRecent={false}
        />
      </div>
    ),
  };
}

function sportView({
  stat,
  fromDate,
}: {
  stat: SportStat;
  fromDate: string | null;
}): AnalyzeView {
  const sessions = rangeFilter(stat.trend, fromDate);
  const newest = [...sessions].sort(newestFirst);
  return {
    name: stat.sport,
    metric: "duration",
    metrics: [{ id: "duration", label: "Duration", chartLabel: "Duration" }],
    chartLabel: "Duration",
    chartUnit: " min",
    color: chartSeries.violet,
    latestActivityId: newest[0]?.activityId ?? stat.lastActivityId,
    chart: sessions.map((s) => ({
      date: s.date,
      value: Math.round(s.durationMin),
    })),
    columns: ["Duration", "Intensity"],
    sessions: newest.map((s) => ({
      activityId: s.activityId,
      date: s.date,
      cells: [
        formatMinutes(s.durationMin || null),
        formatIntensity(s.intensity),
      ],
    })),
    detail: (
      <div className="card">
        <SportDetailPanel stat={stat} showTrend={false} showRecent={false} />
      </div>
    ),
  };
}

function rangeStart(profileId: number, range: RangeId): string | null {
  const def = RANGES.find((r) => r.id === range)!;
  return def.days == null ? null : shiftDateStr(today(profileId), -def.days);
}

function BenchmarkCard({
  exercise,
  state,
  weightUnit,
}: {
  exercise: string;
  state: BenchmarkState;
  weightUnit: "kg" | "lb";
}) {
  const { currentLevel, rankedLevelLabel, rows, currentE1rmKg, bodyweightKg } =
    state;
  const currentRatio = currentE1rmKg / bodyweightKg;

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Benchmarks
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {exercise} estimated 1RM progression · for your bodyweight & sex
          </p>
        </div>
        <div className="text-right">
          <div className={`text-sm font-semibold ${currentLevel.color}`}>
            {currentLevel.label}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {currentRatio.toFixed(2)}× BW
          </div>
        </div>
      </div>

      <div className="relative mt-5">
        <div className="absolute bottom-2 left-2.5 top-2 w-px -translate-x-1/2 rounded-full bg-slate-200 dark:bg-white/10" />

        {rows.map((row, index) => {
          const isCurrent =
            row.type === "current" || row.label === rankedLevelLabel;
          return (
            <div
              key={`${row.type}-${row.label}`}
              className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-3 py-3"
            >
              {index > 0 && (
                <div
                  className="absolute left-0 right-0 top-0 h-px bg-black/10 dark:bg-white/10"
                  style={{
                    maskImage:
                      "linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)",
                    WebkitMaskImage:
                      "linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)",
                  }}
                />
              )}
              <div className="relative z-10 flex h-5 w-5 items-center justify-center">
                <span
                  className={`rounded-full border-2 border-white shadow-sm dark:border-ink-800 ${
                    isCurrent
                      ? "h-4 w-4 bg-slate-950 ring-2 ring-brand-200 dark:bg-white dark:ring-brand-900/70"
                      : "h-3 w-3 bg-slate-300 dark:bg-slate-600"
                  }`}
                />
              </div>
              <div
                className={`min-w-0 ${
                  isCurrent
                    ? "font-bold text-slate-900 dark:text-slate-100"
                    : "font-semibold text-slate-700 dark:text-slate-200"
                }`}
              >
                <div className="text-sm">
                  {isCurrent ? (
                    <span
                      className={`badge ${
                        row.type === "current"
                          ? "bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300"
                          : "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                      }`}
                    >
                      {row.label}
                    </span>
                  ) : (
                    <span className={row.color}>{row.label}</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <span>{fmtWeight(row.valueKg, weightUnit)}</span>
                  <span> · </span>
                  <span>{formatRatio(row.valueKg / bodyweightKg)}× BW</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
