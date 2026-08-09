import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getMetricDailyTotals,
  getFoodHabitTrends,
  getFoodLogEntries,
  getConfirmedIntakeDosesInRange,
} from "@/lib/queries";
import { getDisplayFormatPrefs, getWeekStart } from "@/lib/settings";
import type { DateRange } from "@/lib/timeline-format";
import { dayFillWindow } from "@/lib/day-fill";
import { filterSeriesByRange, lensWindow } from "@/lib/trends";
import { MACROS_SERIES_KEY } from "@/lib/trend-sparkline";
import { chartSeries } from "@/lib/chart-colors";
import {
  buildMacroFiberSeries,
  aggregateFoodAdherenceByWeek,
  NUTRITION_HISTORY_WEEK_CAPS,
  type AdherenceWeek,
} from "@/lib/nutrition-trends";
import { dayHistoryStart } from "@/lib/day-history";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { EmptyState } from "@/components/ui";
import StackedBarCard from "@/components/StackedBarCard";
import ChartCard from "@/components/ChartCard";
import DayHistory from "@/components/DayHistory";

// Trends → Nutrition (issue #1166): the OVER-TIME nutrition view. `/nutrition` keeps the
// log + today's adequacy + the raw servings rollup; this tab is the trend layer, re-homing
// the nutrition trends that were scattered (macros on Body) or uncharted (fiber). Three
// parts, each a formatter over an EXISTING gather (#221): the macros+fiber daily chart,
// the food-goal adherence trend, and the intake history (day-history calendar + matrix).

// One week's hit-rate → a tint. High adherence green, partial amber, none slate; a
// no-applicable-target week reads as a faint dashed placeholder (never a 0% miss).
function adherenceCellClass(w: AdherenceWeek): string {
  if (w.rate == null)
    return "border border-dashed border-black/15 bg-transparent dark:border-white/20";
  if (w.rate >= 0.999) return "bg-emerald-500";
  if (w.rate > 0) return "bg-amber-400 dark:bg-amber-500";
  return "bg-slate-200 dark:bg-slate-700";
}

export default async function NutritionSection({
  range,
}: {
  range: DateRange;
}) {
  const { login, profile } = await requireSession();
  const todayStr = today(profile.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);

  // Part 1 — macros + fiber daily series (tracked totals; fiber the uncharted signal).
  // WINDOWED like every sibling chart (#2258 §4): this was the one Trends chart that
  // ignored the selected range outright, which also left it with no window to
  // densify against. Filtering is the precondition of the fill, not a separate fix.
  const macroFiber = filterSeriesByRange(
    buildMacroFiberSeries({
      protein: getMetricDailyTotals(profile.id, "protein_g"),
      carbs: getMetricDailyTotals(profile.id, "carbs_g"),
      fat: getMetricDailyTotals(profile.id, "fat_g"),
      fiber: getMetricDailyTotals(profile.id, "fiber_g"),
    }),
    range
  );

  // Part 2 — food-goal adherence trend: the per-habit #954 consistency cells rolled up
  // into a weekly overall hit-rate (reused gather, no second engine).
  const adherence = aggregateFoodAdherenceByWeek(
    getFoodHabitTrends(profile.id, formatPrefs)
  );

  // Part 3 — intake history: the generalized day-history (calendar + matrix)
  // over food servings + confirmed doses. The window is the hub's shared range
  // clamped to this lens's week caps and aligned to the profile's week start,
  // so the calendar's columns and the matrix's day list cover identical days.
  const win = lensWindow(range, todayStr, NUTRITION_HISTORY_WEEK_CAPS);
  const weekStart = getWeekStart(profile.id);
  const gridFrom = dayHistoryStart(win.to, win.weeks, weekStart);
  const foodEntries = getFoodLogEntries(profile.id, gridFrom).filter(
    (e) => e.date <= win.to
  );
  const doseDates = getConfirmedIntakeDosesInRange(profile.id, gridFrom)
    .filter((d) => d.date <= win.to)
    .map((d) => d.date);
  const foodValues = foodEntries.map((e) => ({
    date: e.date,
    group: e.group_key,
    value: e.servings,
  }));
  // Group vocabulary in catalog order (encourage-first), any retired/unknown
  // slug appended so history still renders — the rollupServings discipline.
  const presentGroups = new Set(foodEntries.map((e) => e.group_key));
  const foodGroupsMeta = [
    ...FOOD_GROUPS.filter((g) => presentGroups.has(g.slug)).map((g) => ({
      key: g.slug,
      label: g.name,
      foodSlug: g.slug,
      tier: g.tier,
    })),
    ...[...presentGroups]
      .filter((k) => !FOOD_GROUPS.some((g) => g.slug === k))
      .map((k) => ({ key: k, label: k })),
  ];
  const historyHasIntake = foodValues.length > 0 || doseDates.length > 0;

  return (
    <div className="space-y-6">
      {/* Part 1: macros + fiber over time */}
      {/* Macros are a COMPOSITE series with no single-metric kind of its own, so its
          full depth is the Nutrition page — where the per-day food entries behind
          each bar live and are editable. */}
      <ChartCard
        testid="nutrition-macros-chart"
        title="Macros & fiber"
        detailHref="/nutrition"
        detailTitle="macros"
        note="Tracked protein, carbs, fat, and fiber per day. Informational — the intake trend, not a prescription."
      >
        {macroFiber.length === 0 ? (
          <EmptyState message="No tracked macros or fiber yet. Connect a nutrition source (Health Connect) or log foods to build this chart." />
        ) : (
          <StackedBarCard
            data={macroFiber}
            unit=" g"
            // A day with no food logs means "didn't log" — the missing days become
            // empty slots at their own calendar position, never a zero-gram row
            // asserting a fast nobody recorded (#2258). The within-row zero-fill
            // (a day with only protein logged) is untouched: that day HAS a row.
            gapFill={{ seriesKey: MACROS_SERIES_KEY, ...dayFillWindow(range) }}
            series={[
              { key: "protein", label: "Protein", color: chartSeries.violet },
              { key: "carbs", label: "Carbs", color: chartSeries.amber },
              { key: "fat", label: "Fat", color: chartSeries.rose },
              { key: "fiber", label: "Fiber", color: chartSeries.sky },
            ]}
          />
        )}
      </ChartCard>

      {/* Part 2: food-goal adherence trend */}
      <div className="card" data-testid="food-adherence-trend">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Food-goal adherence
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          How consistently your food-group serving goals were met, week over
          week.
        </p>
        {adherence.length === 0 ? (
          <EmptyState message="No food-group habits tracked yet. Set one on Nutrition → Weekly habits to see your consistency here." />
        ) : (
          <div className="flex flex-wrap items-end gap-1.5">
            {adherence.map((w) => (
              <div
                key={w.weekStart}
                data-testid="adherence-week"
                data-rate={w.rate == null ? "" : w.rate.toFixed(2)}
                className="flex flex-col items-center gap-1"
                title={`${w.label} · ${
                  w.rate == null
                    ? "no goal tracked"
                    : `${w.met} of ${w.applicable} goals met`
                }`}
              >
                <span
                  className={`h-8 w-6 rounded-sm ${adherenceCellClass(w)}`}
                  role="img"
                  aria-label={`${w.label}: ${
                    w.rate == null
                      ? "no goal tracked"
                      : `${w.met} of ${w.applicable} goals met`
                  }`}
                />
                <span className="text-xs tabular-nums text-slate-400">
                  {w.label.split(" – ")[0].replace(/^[A-Za-z]+ /, "")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Part 3: intake history — day-history calendar (coverage) + group×day
          matrix (composition), one shared group filter, days linking INTO the
          Timeline. */}
      <div className="card" data-testid="intake-history">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Intake history
          </h2>
          <Link
            href="/timeline"
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            Full timeline →
          </Link>
        </div>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          What you actually logged — food-group servings and confirmed doses,
          day by day. Filter by group; tap a day for its timeline.
        </p>
        {!historyHasIntake ? (
          <EmptyState message="No food or doses logged in this range. Widen the date range or log on the Nutrition page." />
        ) : (
          <DayHistory
            domain="food"
            values={foodValues}
            groups={foodGroupsMeta}
            end={win.to}
            weeks={win.weeks}
            weekStart={weekStart}
            today={todayStr}
            extraDates={doseDates}
            testId="intake-day-history"
          />
        )}
      </div>
    </div>
  );
}
