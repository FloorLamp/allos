import { chartActivityRamp } from "@/lib/chart-colors";
import { trainingLogDayHref } from "@/lib/hrefs";
import type { ActiveDaysStrip as ActiveDaysStripData } from "@/lib/workout-heatmap";
import VisualizationDetails from "@/components/VisualizationDetails";
import { StateCells } from "@/components/StateCells";

// The same blessed activity ramp the full heatmap uses (issue #1445) — the strip
// is the heatmap's compact twin, so a second ladder here is the drift.
const LEVEL_CLASS = [
  chartActivityRamp.emptyClass,
  ...chartActivityRamp.stepClasses,
];

function summary(day: ActiveDaysStripData["days"][number]): string {
  if (day.count === 0) return `${day.date} — no workouts`;
  const sessions = `${day.count} ${day.count === 1 ? "session" : "sessions"}`;
  return `${day.date} — ${sessions}${day.minutes ? ` · ${day.minutes} min` : ""}`;
}

export default function ActiveDaysStrip({
  data,
}: {
  data: ActiveDaysStripData;
}) {
  const compactDays = data.days.slice(-14);
  const compactActiveDays = compactDays.filter((day) => day.count > 0).length;
  const compactStart = Math.max(0, data.days.length - compactDays.length);

  return (
    <div
      data-testid="training-log-active-days"
      className="lg:ml-auto lg:flex lg:shrink-0 lg:items-center lg:gap-3"
    >
      <div className="mb-1.5 flex items-baseline lg:mb-0">
        <h2 className="text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase dark:text-slate-400">
          <span data-testid="active-days-label-compact" className="xl:hidden">
            {compactActiveDays}/14 days active
          </span>
          <span
            data-testid="active-days-label-expanded"
            className="hidden xl:inline"
          >
            {data.activeDays}/{data.days.length} days active
          </span>
        </h2>
      </div>
      <StateCells
        label="Recent activity days"
        cells={data.days.map((day, index) => ({
          key: day.date,
          tone: LEVEL_CLASS[day.level],
          state: String(day.level),
          label: summary(day),
          className: index < compactStart ? "hidden xl:block" : "block",
          ...(day.count > 0
            ? { href: trainingLogDayHref(day.date), testId: "active-day" }
            : {}),
        }))}
      />
      <VisualizationDetails
        label="Daily details"
        items={data.days.map(summary)}
      />
    </div>
  );
}
