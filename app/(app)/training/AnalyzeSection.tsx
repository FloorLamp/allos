import Link from "next/link";
import {
  getCardioByActivity,
  getCyclingOverviewData,
  getExerciseComparison,
  getExerciseLoadContexts,
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
import {
  exerciseHistoryKey,
  loadContextLabel,
  regionForExercise,
} from "@/lib/lifts";
import { getFormDeloadContext } from "@/lib/routines";
import { getInjuryConstraints } from "@/lib/injuries";
import { exerciseInjuryVerdict } from "@/lib/injury-model";
import type { NextSetContext } from "@/lib/coaching";
import { chartSeries } from "@/lib/chart-colors";
import {
  getUnitPrefs,
  getDisplayFormatPrefs,
  getUserSex,
} from "@/lib/settings";
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
  analyzeQuickLinks,
  type BenchmarkState,
  buildAnalyzeOptions,
  cardioMetricValue,
  coerceCardioMetric,
  coerceKind,
  coerceLoadContext,
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
  type CardioMetric,
  type AnalyzeView,
  type RangeId,
} from "@/lib/analyze-view";
import { cardMetaEntries } from "@/lib/card-row";
import { EmptyState } from "@/components/ui";
import ActivityIcon from "@/components/ActivityIcon";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import CardioDetailPanel from "@/components/CardioDetailPanel";
import ExerciseDetailPanel from "@/components/ExerciseDetailPanel";
import LineChartCard from "@/components/LineChartCard";
import SportDetailPanel from "@/components/SportDetailPanel";
import AnalyzePicker from "./AnalyzePicker";
import CyclingOverviewDetails from "./CyclingOverviewDetails";
import { cyclingRideHref, type AppRoute, type CyclingLens } from "@/lib/hrefs";
import {
  CYCLING_METRICS,
  cyclingHistoryMetricOrder,
} from "@/lib/cycling-metrics";
import { journalActivityHref } from "@/lib/timeline-format";
import { isCyclingActivityName } from "@/lib/cycling-activity";

export default async function AnalyzeSection({
  kind,
  item,
  exercise,
  metric,
  range,
  lane,
}: {
  kind?: string;
  item?: string;
  exercise?: string;
  metric?: string;
  range?: string;
  lane?: string;
}) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const wu = units.weightUnit;
  const du = units.distanceUnit;
  const strength = getStrengthByExercise(profile.id);
  const cardio = getCardioByActivity(profile.id, du, formatPrefs);
  const sports = getSportByActivity(profile.id, formatPrefs);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");
  const recentByExercise = getRecentByExercise(profile.id, wu, formatPrefs);
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
  // The resolved strength item, pulled out of the view builders so its LOAD CONTEXTS
  // (#1610) can be read before hrefFor closes over the active lane — every control
  // link then keeps the reader on the implement they chose.
  const strengthStat =
    activeKind === "strength"
      ? (strength.find((s) => s.exercise === selectedName) ?? strength[0])
      : undefined;
  // Empty for cardio and sport. A lift logged in exactly ONE context has nothing to
  // choose between, so no chooser renders and the view stays the plain history.
  const loadContexts = strengthStat
    ? getExerciseLoadContexts(profile.id, strengthStat.exercise)
    : [];
  const activeContext = coerceLoadContext(loadContexts, lane);
  const activeLane = loadContexts.length > 1 ? activeContext?.lane : undefined;
  const hrefFor = (patch: {
    kind?: AnalyzeKind;
    item?: string;
    metric?: string;
    range?: RangeId;
    // The load context to keep (#1610). Omitted, the CURRENT lane rides along so a
    // metric or range change stays on the machine the reader is looking at; `null`
    // drops it so a different item resolves to its own most-recent context.
    lane?: string | null;
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
    const nextLane = patch.lane === undefined ? activeLane : patch.lane;
    if (nextLane) params.set("lane", nextLane);
    return `/training?${params.toString()}`;
  };
  const analyzeOptions = buildAnalyzeOptions({
    strength,
    cardio,
    sports,
    activeRange,
    metric,
  });
  const cardioStat =
    activeKind === "cardio"
      ? (cardio.find((c) => c.activity === selectedName) ?? cardio[0])
      : undefined;
  const cyclingOverview =
    cardioStat && isCyclingActivityName(cardioStat.activity)
      ? getCyclingOverviewData(profile.id, cardioStat.activity)
      : null;

  const view =
    activeKind === "cardio"
      ? cardioView({
          stat: cardioStat!,
          metric,
          fromDate,
          units,
          formatPrefs,
          overview: cyclingOverview,
        })
      : activeKind === "sport"
        ? sportView({
            stat: sports.find((s) => s.sport === selectedName) ?? sports[0],
            fromDate,
          })
        : strengthView({
            stat: strengthStat ?? strength[0],
            profileId: profile.id,
            metric,
            loadContexts,
            activeContext: activeLane ? activeContext : undefined,
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
  const isCyclingOverview = cyclingOverview != null;
  const cyclingLens: CyclingLens | null = isCyclingOverview
    ? {
        metric: view.metric as CardioMetric,
        range: activeRange,
        activity: currentItem,
      }
    : null;
  const cyclingNoun = cyclingOverview?.indoorOnly ? "session" : "ride";
  const cyclingPlural = cyclingOverview?.indoorOnly ? "sessions" : "rides";
  const quickLinks = analyzeQuickLinks(analyzeOptions);
  const analysisControls = (
    <div className="flex flex-wrap items-center gap-2">
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
  );

  return (
    // The section marker (#1496) is the lazy-tab proof: /training builds ONLY the
    // active tab, so an Overview response must not contain this testid.
    <section
      data-testid="analyze-section"
      className={
        isCyclingOverview
          ? "space-y-6"
          : "grid gap-6 xl:grid-cols-[minmax(0,1fr)_28rem]"
      }
    >
      <div className="space-y-6">
        <div
          className="card relative z-20 focus-within:z-50"
          data-testid={isCyclingOverview ? "cycling-overview" : undefined}
        >
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div
              className="flex min-w-0 items-center gap-2.5"
              data-testid="analyze-activity-title"
            >
              <ActivityIcon
                type={activeKind}
                sportNames={[currentItem]}
                className="h-7 w-7 shrink-0 text-brand-600 dark:text-brand-400"
              />
              <div className="min-w-0" role="heading" aria-level={2}>
                <AnalyzePicker
                  options={analyzeOptions}
                  value={currentPickerLabel}
                  appearance="title"
                />
              </div>
            </div>
            <Link
              href={
                cyclingLens && view.latestActivityId != null
                  ? cyclingRideHref(view.latestActivityId, cyclingLens)
                  : view.latestHref
              }
              className="btn-ghost h-10 justify-center"
            >
              {isCyclingOverview ? `Latest ${cyclingNoun}` : "Latest session"}
            </Link>
          </div>

          {quickLinks.length > 0 && (
            <nav
              aria-label="Relevant activities"
              className="mt-3 flex flex-wrap items-center gap-2"
              data-testid="analyze-quick-links"
            >
              <span className="mr-1 section-label">Quick access</span>
              {quickLinks.map((option) => {
                const current =
                  option.kind === activeKind &&
                  option.item.trim().toLowerCase() ===
                    currentItem.trim().toLowerCase();
                return (
                  <Link
                    key={`${option.kind}:${option.item}`}
                    href={option.href}
                    aria-current={current ? "page" : undefined}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                      current
                        ? "border-brand-600 bg-brand-600 text-white dark:border-brand-500 dark:bg-brand-500 dark:text-white"
                        : "border-black/10 bg-white text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:border-brand-700 dark:hover:bg-brand-950 dark:hover:text-brand-300"
                    }`}
                  >
                    <ActivityIcon
                      type={option.kind}
                      sportNames={[option.item]}
                      className="h-4 w-4 shrink-0"
                    />
                    {option.label}
                  </Link>
                );
              })}
            </nav>
          )}

          {!isCyclingOverview ? (
            <div className="mt-4">{analysisControls}</div>
          ) : null}

          {/* Load contexts (#1610). ONE top-level movement stays in the picker
              above; its implements are labeled CHILDREN here, defaulting to the
              most recently used. The label is the implement (or "Unassigned"),
              never the exercise name repeated — two machines share the name, so
              repeating it would render exactly the duplicate unlabeled rows #1610
              forbids. Renders only when there is genuinely a choice. */}
          {view.loadContexts && view.loadContexts.length > 1 && (
            <div className="mt-4" data-testid="analyze-load-contexts">
              <span className="mb-1 block section-label">Equipment</span>
              <div className="flex flex-wrap gap-1.5">
                {view.loadContexts.map((c) => (
                  <Link
                    key={c.lane}
                    href={hrefFor({ item: currentItem, lane: c.lane })}
                    data-testid={`analyze-load-context-${c.lane}`}
                    aria-current={
                      c.lane === view.activeLane ? "true" : undefined
                    }
                    className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                      c.lane === view.activeLane
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
                    }`}
                  >
                    {c.label}
                    <span className="ml-1.5 opacity-70 tabular-nums">
                      {c.sessions}
                    </span>
                  </Link>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                Loads aren&rsquo;t comparable across machines, so each is its
                own progression.
              </p>
            </div>
          )}
        </div>

        <div
          className="card"
          data-testid={isCyclingOverview ? "cycling-progression" : undefined}
        >
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                {isCyclingOverview
                  ? `${cyclingNoun === "ride" ? "Ride" : "Session"} progression`
                  : (view.displayName ?? view.name)}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {view.chartLabel} across logged{" "}
                {isCyclingOverview ? cyclingPlural : "sessions"}
              </p>
            </div>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {view.sessions.length}{" "}
              {isCyclingOverview
                ? view.sessions.length === 1
                  ? cyclingNoun
                  : cyclingPlural
                : view.sessions.length === 1
                  ? "session"
                  : "sessions"}
            </span>
          </div>
          {isCyclingOverview ? (
            <div className="mb-4">{analysisControls}</div>
          ) : null}
          <LineChartCard
            // gap-exempt: a per-SESSION progression (the analyze view's own x is
            // the session, not the calendar).
            data={view.chart}
            label={view.chartLabel}
            unit={view.chartUnit}
            color={view.color}
          />
        </div>

        {isCyclingOverview && cyclingOverview && cyclingLens ? (
          <>
            <div
              className="grid gap-6 lg:grid-cols-2"
              data-testid="cycling-summary"
            >
              <CyclingOverviewDetails
                data={cyclingOverview}
                distanceUnit={units.distanceUnit}
                formatPrefs={formatPrefs}
                section="summary"
                lens={cyclingLens}
              />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <CyclingOverviewDetails
                data={cyclingOverview}
                distanceUnit={units.distanceUnit}
                formatPrefs={formatPrefs}
                section="patterns"
                lens={cyclingLens}
              />
            </div>
            <div
              className="grid gap-6 lg:grid-cols-2"
              data-testid="cycling-performance"
            >
              <CyclingOverviewDetails
                data={cyclingOverview}
                distanceUnit={units.distanceUnit}
                formatPrefs={formatPrefs}
                section="power"
                lens={cyclingLens}
              />
              <CyclingOverviewDetails
                data={cyclingOverview}
                distanceUnit={units.distanceUnit}
                formatPrefs={formatPrefs}
                section="heart-rate"
                lens={cyclingLens}
              />
            </div>
          </>
        ) : null}

        <div
          className="card"
          data-testid={isCyclingOverview ? "cycling-ride-history" : undefined}
        >
          <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            {isCyclingOverview
              ? `${cyclingNoun === "ride" ? "Ride" : "Session"} history`
              : "Sessions"}
          </h3>
          {view.sessions.length === 0 ? (
            <EmptyState
              message={
                isCyclingOverview
                  ? `No ${cyclingPlural} in this range. Widen the range or log one.`
                  : "No sessions in this range. Widen the range or log one."
              }
            />
          ) : (
            /* Below `sm` these sessions stack as flat rows (#1426): the date is the
               row title, the view's LEADING metric — the one the chart above plots,
               so the column the user chose — is the headline value, and the rest
               become a compact meta line. `cardMetaEntries` decides which of those
               survive: a placeholder cell, or one that just repeats the date, buys
               no screen on a phone (#531–#534). The wide-table scroller stays for
               `sm` and up. */
            <div className="overflow-x-auto">
              <ResponsiveTable
                className="w-full sm:whitespace-nowrap"
                data-testid="analyze-sessions"
              >
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
                  {view.sessions.map((s, i) => {
                    const dateText = formatLongDate(s.date, formatPrefs);
                    // Which columns survive onto the card, by the shared rule —
                    // computed once per row and matched back by INDEX (two metrics
                    // may share a label; positions never collide). Column 0 is the
                    // headline value, so it's exempt from the meta filtering, but it
                    // still participates: a later column repeating it is dropped as a
                    // duplicate rather than said twice.
                    const keep = new Set(
                      cardMetaEntries(view.columns, s.cells, {
                        title: dateText,
                      }).map((e) => e.index)
                    );
                    return (
                      <tr
                        key={`${s.activityId}-${i}`}
                        className="border-b border-black/5 dark:border-white/10"
                      >
                        <Td slot="title">
                          <Link
                            href={
                              cyclingLens
                                ? cyclingRideHref(s.activityId, cyclingLens)
                                : s.href
                            }
                            className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                          >
                            {dateText}
                          </Link>
                        </Td>
                        {s.cells.map((cell, ci) => (
                          <Td
                            key={ci}
                            slot={ci === 0 ? "value" : "meta"}
                            label={view.columns[ci]}
                            empty={!keep.has(ci)}
                            className="text-slate-600 dark:text-slate-300"
                          >
                            {cell}
                          </Td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </ResponsiveTable>
            </div>
          )}
        </div>

        {isCyclingOverview && cyclingOverview && cyclingLens ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <CyclingOverviewDetails
              data={cyclingOverview}
              distanceUnit={units.distanceUnit}
              formatPrefs={formatPrefs}
              section="coverage"
              lens={cyclingLens}
            />
          </div>
        ) : null}
      </div>

      {!isCyclingOverview ? (
        <aside className="space-y-6">{view.detail}</aside>
      ) : null}
    </section>
  );
}

function strengthView({
  stat,
  profileId,
  metric,
  loadContexts,
  activeContext,
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
  // Every load context this lift has been logged in, newest-first, and the one the
  // view is narrowed to — undefined when there is only one context, in which case
  // the comparison stays movement-wide exactly as before #1610.
  loadContexts: ReturnType<typeof getExerciseLoadContexts>;
  activeContext: ReturnType<typeof getExerciseLoadContexts>[number] | undefined;
  fromDate: string | null;
  units: ReturnType<typeof getUnitPrefs>;
  bodyweightKg: number | null;
  recentByExercise: ReturnType<typeof getRecentByExercise>;
  goals: ReturnType<typeof getGoals>;
  goalProgress: Record<number, GoalProgress>;
  sex: Sex | null;
}): AnalyzeView {
  const activeMetric = coerceStrengthMetric(metric);
  // Routine context for the next-set target (#1115 Fix B): the Analyze panel is exactly
  // where the "Today's workout" nudge's "How to" button deep-links, so it must seed the
  // SAME shaved/tempered load the nudge frames — not the full progression. Deload when
  // the routine places today in its deload week AND this lift resolves to a routine
  // slot (mirroring the live form, #923); recovering when a RECOVERING injury covers the
  // lift's region (#838). Both flow through the shared contextualNextSet in the panel.
  const deloadCtx = getFormDeloadContext(profileId, today(profileId));
  // #2024: the SHARED per-exercise verdict, so an exercise- or movement-scoped
  // constraint tempers exactly this lift (rather than its whole coarse region) and the
  // user's own declared load preference beats the app's fallback fraction.
  const injuryVerdict = exerciseInjuryVerdict(
    getInjuryConstraints(profileId),
    stat.exercise
  );
  const nextSetContext: NextSetContext = {
    deloadWeek:
      deloadCtx.isDeloadWeek &&
      deloadCtx.routineKeys.includes(exerciseHistoryKey(stat.exercise)),
    recoveringRegion: injuryVerdict.kind === "tempered",
    recoveringFactor: injuryVerdict.factor,
  };
  // ONE load context per comparison (#1610): two registry machines both serialize as
  // the same exact logged name, so charting them together would plot a hotel
  // machine's 50 kg and a home machine's 80 kg as one progression and read the two
  // histories as one session table.
  const sessions = rangeFilter(
    getExerciseComparison(profileId, stat.exercise, units.weightUnit, {
      equipmentLane: activeContext?.lane,
    }),
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
    displayName: loadContextLabel(
      stat.exercise,
      activeContext?.equipment ?? null
    ),
    metric: activeMetric,
    metrics: STRENGTH_METRICS,
    loadContexts: activeContext
      ? loadContexts.map((c) => ({
          lane: c.lane,
          label: c.label,
          sessions: c.sessions,
        }))
      : undefined,
    activeLane: activeContext?.lane,
    chartLabel: chartMetric.chartLabel,
    chartUnit: activeMetric === "reps" ? "" : ` ${units.weightUnit}`,
    color: chartSeries.violet,
    latestHref: journalActivityHref(
      newest[0]?.activityId ?? stat.lastActivityId
    ),
    chart: sessions.map((s) => ({
      date: s.date,
      value: strengthMetricValue(s, activeMetric, units.weightUnit),
    })),
    columns: ["Sets", "Best", "Est. 1RM", "Volume"],
    sessions: newest.map((s) => ({
      activityId: s.activityId,
      href: journalActivityHref(s.activityId),
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
            nextSetContext={nextSetContext}
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

function cyclingHistoryCell(
  session: CardioStat["trend"][number],
  metric: CardioMetric,
  distanceUnit: "km" | "mi"
): string {
  if (metric === "distance") {
    return session.distanceKm > 0
      ? fmtDistance(session.distanceKm, distanceUnit)
      : "—";
  }
  if (metric === "duration") return formatMinutes(session.durationMin || null);
  if (metric === "speed") {
    return session.speedKmh == null
      ? "—"
      : fmtKmh(session.speedKmh, distanceUnit);
  }
  if (metric === "heart_rate") {
    return session.avgHr == null ? "—" : `${Math.round(session.avgHr)} bpm`;
  }
  if (metric === "power") {
    return session.avgPowerW == null
      ? "—"
      : `${Math.round(session.avgPowerW)} W`;
  }
  if (metric === "weighted_power") {
    return session.weightedAvgPowerW == null
      ? "—"
      : `${Math.round(session.weightedAvgPowerW)} W`;
  }
  if (metric === "cadence") {
    return session.avgCadence == null
      ? "—"
      : `${Math.round(session.avgCadence)} rpm`;
  }
  if (metric === "elevation") {
    if (session.elevationM == null) return "—";
    return distanceUnit === "mi"
      ? `${Math.round(session.elevationM * 3.28084)} ft`
      : `${Math.round(session.elevationM)} m`;
  }
  return session.relativeEffort == null ? "—" : String(session.relativeEffort);
}

function cardioView({
  stat,
  metric,
  fromDate,
  units,
  formatPrefs,
  overview,
}: {
  stat: CardioStat;
  metric?: string;
  fromDate: string | null;
  units: ReturnType<typeof getUnitPrefs>;
  formatPrefs: ReturnType<typeof getDisplayFormatPrefs>;
  overview: ReturnType<typeof getCyclingOverviewData> | null;
}): AnalyzeView {
  let activeMetric = coerceCardioMetric(metric, stat);
  const metrics = CARDIO_METRICS.filter((m) => {
    if (m.id === "duration") return true;
    if (m.id === "elevation" && overview?.indoorOnly) return false;
    if (m.id === "distance" || m.id === "speed") return stat.hasDistance;
    if (m.id === "heart_rate") return stat.hasHeartRate;
    if (m.id === "elevation") return stat.hasElevation;
    if (m.id === "power") return stat.hasPower;
    if (m.id === "weighted_power") return stat.hasWeightedPower;
    if (m.id === "cadence") return stat.hasCadence;
    return stat.hasRelativeEffort;
  });
  if (!metrics.some((item) => item.id === activeMetric)) {
    activeMetric = metrics[0]?.id ?? "duration";
  }
  const sessions = rangeFilter(stat.trend, fromDate);
  const newest = [...sessions].sort(newestFirst);
  const chartMetric = metrics.find((m) => m.id === activeMetric)!;
  const historyMetrics = overview
    ? cyclingHistoryMetricOrder(
        activeMetric,
        metrics.map((item) => item.id)
      )
    : null;
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
          : activeMetric === "duration"
            ? " min"
            : activeMetric === "elevation"
              ? units.distanceUnit === "mi"
                ? " ft"
                : " m"
              : activeMetric === "heart_rate"
                ? " bpm"
                : activeMetric === "power" || activeMetric === "weighted_power"
                  ? " W"
                  : activeMetric === "cadence"
                    ? " rpm"
                    : "",
    color: overview
      ? CYCLING_METRICS[activeMetric].color
      : activeMetric === "speed"
        ? chartSeries.brand
        : activeMetric === "heart_rate"
          ? chartSeries.rose
          : activeMetric === "power" || activeMetric === "weighted_power"
            ? chartSeries.amber
            : activeMetric === "elevation"
              ? chartSeries.violet
              : chartSeries.sky,
    latestHref: newest[0]?.href ?? stat.lastHref,
    latestActivityId: stat.lastActivityId,
    chart: sessions.map((s) => ({
      date: s.date,
      value: cardioMetricValue(s, activeMetric, units.distanceUnit),
    })),
    columns: historyMetrics
      ? historyMetrics.map((metric) => CYCLING_METRICS[metric].historyLabel)
      : ["Distance", "Duration", "Avg speed"],
    sessions: newest.map((s) => ({
      activityId: s.activityId,
      href: s.href,
      date: s.date,
      cells: historyMetrics
        ? historyMetrics.map((metric) =>
            cyclingHistoryCell(s, metric, units.distanceUnit)
          )
        : [
            s.distanceKm > 0
              ? fmtDistance(s.distanceKm, units.distanceUnit)
              : "—",
            formatMinutes(s.durationMin || null),
            s.speedKmh == null ? "—" : fmtKmh(s.speedKmh, units.distanceUnit),
          ],
    })),
    // Cycling composes its summary, patterns, performance, history, and
    // coverage explicitly in AnalyzeSection so page order cannot drift back
    // into one opaque detail fragment.
    detail: overview ? null : (
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
    latestHref: newest[0]?.href ?? stat.lastHref,
    chart: sessions.map((s) => ({
      date: s.date,
      value: Math.round(s.durationMin),
    })),
    columns: ["Duration", "Intensity"],
    sessions: newest.map((s) => ({
      activityId: s.activityId,
      href: s.href,
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
                  className={`rounded-full border-2 border-white shadow-xs dark:border-ink-800 ${
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
