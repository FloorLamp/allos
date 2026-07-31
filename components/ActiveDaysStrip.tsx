import Link from "next/link";
import { chartActivityRamp } from "@/lib/chart-colors";
import type { ActiveDaysStrip as ActiveDaysStripData } from "@/lib/workout-heatmap";

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
      data-testid="journal-active-days"
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
      <div className="flex gap-1" aria-label="Recent activity days">
        {data.days.map((day, index) => {
          const responsive = index < compactStart ? "hidden xl:block" : "block";
          const classes = `h-4 w-4 rounded-[3px] ${responsive} ${LEVEL_CLASS[day.level]}`;
          return day.count > 0 ? (
            <Link
              key={day.date}
              href={`/training?tab=log#day-${day.date}`}
              data-testid="active-day"
              data-date={day.date}
              data-count={day.count}
              title={summary(day)}
              aria-label={summary(day)}
              className={`${classes} ring-brand-400 hover:ring-2 focus:outline-none focus:ring-2`}
            />
          ) : (
            <span
              key={day.date}
              title={summary(day)}
              aria-label={summary(day)}
              className={classes}
            />
          );
        })}
      </div>
    </div>
  );
}
