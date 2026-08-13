import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getFoodHabitTrends,
  getFoodDailyServingTotals,
  getConfirmedIntakeDosesInRange,
  getMacroFiberDays,
} from "@/lib/queries";
import { getDisplayFormatPrefs, getWeekStart } from "@/lib/settings";
import type { DateRange } from "@/lib/timeline-format";
import { dayFillWindow } from "@/lib/day-fill";
import { lensWindow } from "@/lib/trends";
import { MACROS_SERIES_KEY } from "@/lib/trend-sparkline";
import { chartSeries } from "@/lib/chart-colors";
import { doseLedgerHref, DOSE_LEDGER_ALL_KINDS } from "@/lib/hrefs";
import {
  aggregateFoodAdherenceByWeek,
  orderNutritionSections,
  NUTRITION_HISTORY_WEEK_CAPS,
  type AdherenceWeek,
  type NutritionSectionId,
} from "@/lib/nutrition-trends";
import {
  DAY_HISTORY_DOMAINS,
  dayHistoryStart,
  dayHistoryWindow,
} from "@/lib/day-history";
import { FOOD_GROUPS, foodGroupShortName } from "@/lib/food-groups";
import { EmptyState } from "@/components/ui";
import StackedBarCard from "@/components/StackedBarCard";
import ChartCard from "@/components/ChartCard";
import DayHistory from "@/components/DayHistory";

// Trends → Nutrition (issue #1166): the OVER-TIME nutrition view. `/nutrition` keeps the
// log + today's adequacy + the raw servings rollup; this tab is the trend layer, re-homing
// the nutrition trends that were scattered (macros on Body) or uncharted (fiber). Four
// parts: the intake history LEADS (day-history calendar + matrix — what was actually
// logged is the tab's headline), then the dose history (its own chart, not an overlay
// dot on the food calendar), then the macros+fiber daily chart and the food-goal
// adherence trend. Each is a formatter over an EXISTING gather (#221). The two history
// sections are deliberately CARD-LESS — page-level surfaces separated by dividers, so
// their grids can run edge to edge on phones.

// One week's hit-rate → a tint. High adherence green, partial amber, none slate; a
// no-applicable-target week reads as a faint dashed placeholder (never a 0% miss).
function adherenceCellClass(w: AdherenceWeek): string {
  if (w.rate == null)
    return "border border-dashed border-black/15 bg-transparent dark:border-white/20";
  if (w.rate >= 0.999) return "bg-emerald-500";
  if (w.rate > 0) return "bg-amber-400 dark:bg-amber-500";
  return "bg-slate-200 dark:bg-slate-700";
}

const DIVIDER = "border-black/5 dark:border-white/10";

// The sections that render as page-level surfaces rather than cards, so their grids
// can run edge to edge on phones — the ones a divider has to close off.
const CARD_LESS_SECTIONS: ReadonlySet<NutritionSectionId> = new Set([
  "intake-history",
  "dose-history",
]);

export default async function NutritionSection({
  range,
}: {
  range: DateRange;
}) {
  const { login, profile } = await requireSession();
  const todayStr = today(profile.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);

  // Parts 1+2 — the day histories. The window is the hub's shared range clamped
  // to this lens's week caps and aligned to the profile's week start, so the
  // calendar's columns and the matrix's bucket list cover identical days.
  const win = lensWindow(range, todayStr, NUTRITION_HISTORY_WEEK_CAPS);
  const weekStart = getWeekStart(profile.id);
  // A year-scale request outgrows the day cap, so it re-grains to weeks rather
  // than being clamped back to the most recent quarter (#2413). The decision
  // reads the range's UNCLAMPED span; `win.weeks` has already been clamped.
  const history = dayHistoryWindow({ days: win.days, weeks: win.weeks });
  const gridFrom = dayHistoryStart(win.to, history.weeks, weekStart);
  const foodEntries = getFoodDailyServingTotals(profile.id, gridFrom).filter(
    (e) => e.date <= win.to
  );
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
      short: foodGroupShortName(g.slug),
      foodSlug: g.slug,
      tier: g.tier,
    })),
    ...[...presentGroups]
      .filter((k) => !FOOD_GROUPS.some((g) => g.slug === k))
      .map((k) => ({ key: k, label: k })),
  ];

  // Confirmed (taken) supplement/med doses as their OWN history — one row per
  // item, never an unexplained dot on the food calendar. History of what was
  // taken, deliberately not adherence (no expected-vs-taken verdicts here).
  const doseRows = getConfirmedIntakeDosesInRange(profile.id, gridFrom).filter(
    (d) => d.date <= win.to
  );
  const doseValues = doseRows.map((d) => ({
    date: d.date,
    // A displayed name is not an item identity: two separately managed
    // Magnesium entries must remain two rows with two independent filters.
    group: String(d.itemId),
    value: 1,
    // The confirmed amount rides along as hover copy ("2 doses · 1000 mg").
    note: d.amount ?? undefined,
  }));
  const doseItems = new Map(doseRows.map((d) => [d.itemId, d]));
  const doseNameCounts = new Map<string, number>();
  for (const d of doseItems.values()) {
    doseNameCounts.set(d.name, (doseNameCounts.get(d.name) ?? 0) + 1);
  }
  const labelCounts = new Map<string, number>();
  const doseGroups = [...doseItems.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.itemId - b.itemId)
    .map((item) => {
      const duplicateName = (doseNameCounts.get(item.name) ?? 0) > 1;
      const qualifier =
        item.product?.trim() ||
        item.brand?.trim() ||
        (item.kind === "medication" ? "Medication" : "Supplement");
      const base = duplicateName ? `${item.name} · ${qualifier}` : item.name;
      const occurrence = (labelCounts.get(base) ?? 0) + 1;
      labelCounts.set(base, occurrence);
      return {
        key: String(item.itemId),
        label: occurrence > 1 ? `${base} ${occurrence}` : base,
      };
    });

  // Part 3 — macros + fiber daily series (fiber the uncharted signal), already
  // windowed to the shared range by the gather (#2258 §4 — filtering is the
  // precondition of the chart's day-fill). Protein arrives merged from BOTH of its
  // sources (#2414): reading only the tracked metric left this chart blind to the
  // app's own protein logging.
  const macroFiber = getMacroFiberDays(profile.id, range);

  // Part 4 — food-goal adherence trend: the per-habit #954 consistency cells rolled up
  // into a weekly overall hit-rate (reused gather, no second engine).
  const adherence = aggregateFoodAdherenceByWeek(
    getFoodHabitTrends(profile.id, formatPrefs)
  );

  // THE RENDER ORDER (#2399). The reader's own data outranks an invitation: a
  // section with content leads, a setup prompt sinks. Presence is the ONLY input —
  // see the data-present floor in lib/nutrition-trends.
  const order = orderNutritionSections(
    [
      foodValues.length > 0 && "intake-history",
      doseValues.length > 0 && "dose-history",
      macroFiber.length > 0 && "macros",
      adherence.length > 0 && "adherence",
    ].filter((id): id is NutritionSectionId => id !== false)
  );

  const blocks: Record<NutritionSectionId, ReactNode> = {
    // Intake history — day-history calendar (coverage) + group×day matrix
    // (composition), one shared group filter, days linking INTO the Timeline.
    "intake-history": (
      <section data-testid="intake-history">
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
          {DAY_HISTORY_DOMAINS.food.helperText}
        </p>
        {foodValues.length === 0 ? (
          <EmptyState
            compact
            message="No food logged in this range. Widen the date range, or log what you ate."
            action={{ href: "/nutrition?tab=food", label: "Log food" }}
          />
        ) : (
          <DayHistory
            domain="food"
            addHref="/nutrition?tab=food"
            values={foodValues}
            groups={foodGroupsMeta}
            end={win.to}
            weeks={history.weeks}
            weekStart={weekStart}
            grain={history.grain}
            today={todayStr}
            formatPrefs={formatPrefs}
            testId="intake-day-history"
          />
        )}
      </section>
    ),

    // Dose history — confirmed supplement/med doses as their own day-history
    // (one row per item).
    "dose-history": (
      <section id="dose-history" data-testid="dose-history">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Dose history
          </h2>
          {/* The TABULAR counterpart of this chart (#2417): the calendar shows the
              pattern, the ledger shows the rows behind it — and a tapped day in the
              panel below links into that ledger filtered to the day. */}
          <Link
            href={doseLedgerHref("supplement", { kind: DOSE_LEDGER_ALL_KINDS })}
            data-testid="dose-history-ledger-link"
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            Dose ledger →
          </Link>
        </div>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          {DAY_HISTORY_DOMAINS.dose.helperText}
        </p>
        {doseValues.length === 0 ? (
          <EmptyState
            compact
            message="No confirmed doses in this range. Doses you confirm show up here."
            action={{
              href: "/nutrition?tab=supplements",
              label: "Supplements",
            }}
          />
        ) : (
          <DayHistory
            domain="dose"
            addHref="/nutrition?tab=supplements"
            values={doseValues}
            groups={doseGroups}
            end={win.to}
            weeks={history.weeks}
            weekStart={weekStart}
            grain={history.grain}
            today={todayStr}
            formatPrefs={formatPrefs}
            testId="dose-day-history"
          />
        )}
      </section>
    ),

    // Macros + fiber over time. A COMPOSITE series with no single-metric kind of its
    // own, so its full depth is the Nutrition page — where the per-day food entries
    // behind each bar live and are editable.
    macros: (
      <ChartCard
        testid="nutrition-macros-chart"
        title="Macros & fiber"
        detailHref="/nutrition"
        detailTitle="macros"
        note="Protein, carbs, fat, and fiber per day. Informational — the intake trend, not a prescription."
      >
        {macroFiber.length === 0 ? (
          <EmptyState
            testId="nutrition-macros-empty"
            message="No macros or fiber in this range. Connect a nutrition source (Health Connect), or log protein grams on the Nutrition page, to build this chart."
          />
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
    ),

    // Food-goal adherence trend.
    adherence: (
      <div className="card" data-testid="food-adherence-trend">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Food-goal adherence
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          How consistently your food-group serving goals were met, week over
          week.
        </p>
        {adherence.length === 0 ? (
          <EmptyState
            compact
            message="No food-group habits tracked yet. Set one to see your consistency here."
            action={{ href: "/nutrition?tab=food", label: "Weekly habits" }}
          />
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
                  className={`h-8 w-6 rounded-xs ${adherenceCellClass(w)}`}
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
    ),
  };

  return (
    <div className="space-y-6">
      {order.map((id, i) => (
        <Fragment key={id}>
          {blocks[id]}
          {/* The two histories are deliberately CARD-LESS page-level surfaces, so
              each needs a rule to close it off from whatever the order puts next.
              A card carries its own edge, and the last block needs no divider. */}
          {CARD_LESS_SECTIONS.has(id) && i < order.length - 1 && (
            <hr className={DIVIDER} />
          )}
        </Fragment>
      ))}
    </div>
  );
}
