import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getMetricDailyTotals,
  getFoodHabitTrends,
  getFoodLogEntries,
  getConfirmedIntakeDosesInRange,
} from "@/lib/queries";
import { getDisplayFormatPrefs } from "@/lib/settings";
import type { DateRange } from "@/lib/timeline-format";
import { shiftDateStr } from "@/lib/date";
import { chartSeries } from "@/lib/chart-colors";
import {
  buildMacroFiberSeries,
  aggregateFoodAdherenceByWeek,
  buildIntakeMatrix,
  type AdherenceWeek,
} from "@/lib/nutrition-trends";
import type { FoodGroupTier } from "@/lib/food-groups";
import { EmptyState } from "@/components/ui";
import StackedBarCard from "@/components/StackedBarCard";

// Trends → Nutrition (issue #1166): the OVER-TIME nutrition view. `/nutrition` keeps the
// log + today's adequacy + the raw servings rollup; this tab is the trend layer, re-homing
// the nutrition trends that were scattered (macros on Body) or uncharted (fiber). Three
// parts, each a formatter over an EXISTING gather (#221): the macros+fiber daily chart,
// the food-goal adherence trend, and the intake-history pattern grid.

// The intake grid is bounded so a wide range doesn't render hundreds of cells; the most
// recent MAX_GRID_DAYS of the window read as a scannable routine at a glance.
const MAX_GRID_DAYS = 42;

// Tier tint for the intake-grid food-serving segments (matching FoodWeeklyRollup's tint
// vocabulary): encourage green, limit amber, neutral slate.
const TIER_SEGMENT: Record<FoodGroupTier, string> = {
  encourage: "bg-emerald-500",
  neutral: "bg-slate-300 dark:bg-slate-600",
  limit: "bg-amber-500",
};

// Enumerate the calendar days in [from, to] inclusive, NEWEST first, capped.
function daysDescending(from: string, to: string, cap: number): string[] {
  const out: string[] = [];
  let d = to;
  while (d >= from && out.length < cap) {
    out.push(d);
    d = shiftDateStr(d, -1);
  }
  return out;
}

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
  const from = range.from ?? shiftDateStr(todayStr, -29);
  const to = range.to ?? todayStr;

  // Part 1 — macros + fiber daily series (tracked totals; fiber the uncharted signal).
  const macroFiber = buildMacroFiberSeries({
    protein: getMetricDailyTotals(profile.id, "protein_g"),
    carbs: getMetricDailyTotals(profile.id, "carbs_g"),
    fat: getMetricDailyTotals(profile.id, "fat_g"),
    fiber: getMetricDailyTotals(profile.id, "fiber_g"),
  });

  // Part 2 — food-goal adherence trend: the per-habit #954 consistency cells rolled up
  // into a weekly overall hit-rate (reused gather, no second engine).
  const adherence = aggregateFoodAdherenceByWeek(
    getFoodHabitTrends(profile.id, formatPrefs)
  );

  // Part 3 — intake-history pattern grid: food servings + confirmed doses per day.
  const days = daysDescending(from, to, MAX_GRID_DAYS);
  const gridFrom = days.length > 0 ? days[days.length - 1] : from;
  const foodEntries = getFoodLogEntries(profile.id, gridFrom).filter(
    (e) => e.date <= to
  );
  const doseDates = getConfirmedIntakeDosesInRange(profile.id, gridFrom)
    .filter((d) => d.date <= to)
    .map((d) => d.date);
  const matrix = buildIntakeMatrix(days, foodEntries, doseDates);
  const matrixHasIntake = matrix.some(
    (d) => d.totalServings > 0 || d.doseCount > 0
  );

  return (
    <div className="space-y-6">
      {/* Part 1: macros + fiber over time */}
      <div className="card" data-testid="nutrition-macros-chart">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Macros & fiber
          </h2>
          <Link
            href="/nutrition"
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            Log nutrition →
          </Link>
        </div>
        {macroFiber.length === 0 ? (
          <EmptyState message="No tracked macros or fiber yet. Connect a nutrition source (Health Connect) or log foods to build this chart." />
        ) : (
          <StackedBarCard
            data={macroFiber}
            unit=" g"
            series={[
              { key: "protein", label: "Protein", color: chartSeries.violet },
              { key: "carbs", label: "Carbs", color: chartSeries.amber },
              { key: "fat", label: "Fat", color: chartSeries.rose },
              { key: "fiber", label: "Fiber", color: chartSeries.emerald },
            ]}
          />
        )}
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Tracked protein, carbs, fat, and fiber per day. Informational — the
          intake trend, not a prescription.
        </p>
      </div>

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

      {/* Part 3: intake-history pattern grid (links INTO the Timeline) */}
      <div className="card" data-testid="intake-matrix">
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
          What you actually logged — food-group servings and supplement/med
          doses, day by day. Tap a day for the full timeline.
        </p>
        {!matrixHasIntake ? (
          <EmptyState message="No food or doses logged in this range. Widen the date range or log on the Nutrition page." />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {matrix.map((d) => (
              <Link
                key={d.date}
                href={d.href}
                data-testid="intake-matrix-day"
                data-date={d.date}
                title={`${d.date} · ${d.totalServings} serving${
                  d.totalServings === 1 ? "" : "s"
                }, ${d.doseCount} dose${d.doseCount === 1 ? "" : "s"}`}
                className="flex w-9 flex-col items-center gap-1 rounded-md border border-black/5 p-1 transition hover:border-brand-300 hover:bg-brand-50/40 dark:border-white/10 dark:hover:border-brand-700 dark:hover:bg-brand-950/30"
              >
                {/* Food-serving segments, tier-tinted, stacked for the day. */}
                <span className="flex h-12 w-3 flex-col-reverse overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800">
                  {d.groups.flatMap((gr) =>
                    Array.from({
                      length: Math.min(Math.round(gr.servings), 6),
                    }).map((_, i) => (
                      <span
                        key={`${gr.slug}-${i}`}
                        className={`min-h-[3px] flex-1 ${
                          TIER_SEGMENT[gr.tier] ?? TIER_SEGMENT.neutral
                        } border-t border-white/60 dark:border-black/30`}
                      />
                    ))
                  )}
                </span>
                {/* Dose dots (capped), then the day-of-month. */}
                <span className="flex h-2 items-center gap-0.5">
                  {Array.from({ length: Math.min(d.doseCount, 4) }).map(
                    (_, i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-brand-500"
                      />
                    )
                  )}
                </span>
                <span className="text-xs tabular-nums text-slate-400">
                  {d.date.slice(8)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
