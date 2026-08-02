import {
  IconWalk,
  IconArrowUpRight,
  IconArrowDownRight,
  IconMinus,
} from "@tabler/icons-react";
import CountUpNumber from "@/components/CountUpNumber";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import type { StepsTodaySummary } from "@/lib/steps-today";

// Dashboard "Steps today" tile (issue #1221): today's step count against the PRIOR
// seven days — a thin FORMATTER over the SAME summarizeStepsToday aggregation the
// gather feeds from getMetricDailyTotals(profileId, "steps") (#221). The arrow carries
// a text equivalent (the #1220 non-color channel), never color alone.
//
// The copy says "prior 7 days", not "7-day average" (#1909): the metric detail page's
// Rolling summary answers a DIFFERENT question over a different window basis, and two
// adjacent surfaces reading "7-day average" with two different numbers is
// indistinguishable from a bug. This card's baseline is the days BEFORE today — the
// thing today is being compared against — and now says so.
export default function StepsTodayWidget({
  summary,
}: {
  summary: StepsTodaySummary;
}) {
  const { today, average7, deltaPct, direction } = summary;
  const Arrow =
    direction === "up"
      ? IconArrowUpRight
      : direction === "down"
        ? IconArrowDownRight
        : IconMinus;
  const arrowClass =
    direction === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : direction === "down"
        ? "text-amber-600 dark:text-amber-400"
        : "text-slate-500 dark:text-slate-400";
  const deltaText =
    deltaPct != null
      ? `${deltaPct > 0 ? "+" : ""}${deltaPct}% vs prior 7 days`
      : null;
  return (
    <div className="card" data-testid="steps-today-widget">
      <WidgetHeader title="Steps today" href="/trends#body" />
      <div className="flex items-start gap-3">
        <IconWalk
          className="mt-1 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {/* The dashboard's one count-up (issue #1445, Part 3c): a step
                count is a magnitude whose ticking-up is the point. 400ms, once,
                skipped under prefers-reduced-motion; the final value is what the
                server renders, so nothing downstream ever reads a partial. */}
            <CountUpNumber
              value={today}
              className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
              testId="steps-today-count"
            />
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {today != null ? "steps" : "No steps logged yet today"}
            </span>
          </div>
          {average7 != null && (
            <div className="text-sm text-slate-600 dark:text-slate-300">
              Prior 7 days · {average7.toLocaleString("en-US")} steps a day
            </div>
          )}
          {deltaText && direction && (
            <div
              className={`mt-0.5 flex items-center gap-1 text-xs font-medium ${arrowClass}`}
              data-testid="steps-today-delta"
            >
              <Arrow className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
              <span>{deltaText}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
