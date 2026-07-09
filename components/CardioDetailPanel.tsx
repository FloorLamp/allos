"use client";

import type { ReactNode } from "react";
import type { UnitPrefs } from "@/lib/settings";
import type { CardioStat } from "@/lib/queries";
import { fmtDistance, fmtKmh, kmTo, round } from "@/lib/units";
import { formatMinutes } from "@/lib/duration";
import { formatLongDate, formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import LineChartCard from "@/components/LineChartCard";
import { StatBox } from "@/components/StatBox";

// Per-cardio-activity detail: records grid, a distance- (or duration-) over-time
// trend, and the last few sessions linked to their journal entries.
export default function CardioDetailPanel({
  stat,
  units,
  headerRight,
  showTrend = true,
  showRecent = true,
}: {
  stat: CardioStat;
  units: UnitPrefs;
  // Optional control pinned to the right of the header (e.g. a close button).
  headerRight?: ReactNode;
  showTrend?: boolean;
  showRecent?: boolean;
}) {
  const todayStr = dateStrInTz(useTimezone());
  const du = units.distanceUnit;
  const showDistance = stat.hasDistance;
  const chart = stat.trend.map((t) => ({
    date: t.date,
    value: showDistance
      ? round(kmTo(t.distanceKm, du), 2)
      : Math.round(t.durationMin),
  }));
  // Avg speed per session (null when a session has no distance+duration).
  const speedChart = stat.trend.map((t) => ({
    date: t.date,
    value: t.speedKmh != null ? round(kmTo(t.speedKmh, du), 1) : null,
  }));
  // Running total distance over time.
  let cumKm = 0;
  const cumChart = stat.trend.map((t) => {
    cumKm += t.distanceKm;
    return { date: t.date, value: round(kmTo(cumKm, du), 2) };
  });

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        {/* Below lg the panel renders inside MobileDetailPage, whose header
            already shows the name — hide the inline one there. */}
        <h2 className="font-semibold text-slate-800 max-lg:hidden dark:text-slate-100">
          {stat.activity}
        </h2>
        {headerRight}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3">
        {showDistance && (
          <StatBox
            label="Longest"
            value={fmtDistance(stat.longestDistanceKm, du)}
            sub={formatLongDate(stat.longestDistanceDate)}
          />
        )}
        {showDistance && stat.fastestKmh > 0 && (
          <StatBox
            label="Fastest"
            value={fmtKmh(stat.fastestKmh, du)}
            sub={formatLongDate(stat.fastestKmhDate)}
          />
        )}
        <StatBox
          label="Longest time"
          value={formatMinutes(stat.longestDurationMin)}
          sub={formatLongDate(stat.longestDurationDate)}
        />
        <StatBox label="Sessions" value={String(stat.sessions)} />
        {showDistance && (
          <StatBox
            label="Total distance"
            value={fmtDistance(stat.totalDistanceKm, du)}
          />
        )}
        <StatBox
          label="Total time"
          value={formatMinutes(stat.totalDurationMin)}
        />
        <StatBox
          label="Last done"
          value={formatRelativeDate(stat.lastDate, todayStr)}
          sub={formatLongDate(stat.lastDate)}
          href={`/training?tab=log#activity-${stat.lastActivityId}`}
        />
      </dl>

      {showTrend && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {showDistance ? "Distance over time" : "Duration over time"}
          </h3>
          <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
            {showDistance ? `${du} per session` : "Minutes per session"}
          </p>
          <LineChartCard
            data={chart}
            label={showDistance ? "Distance" : "Duration"}
            unit={showDistance ? ` ${du}` : " min"}
            color="#0ea5e9"
            heightClass="h-40"
          />
        </div>
      )}

      {showTrend && showDistance && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Avg speed over time
          </h3>
          <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
            {du}/h per session
          </p>
          <LineChartCard
            data={speedChart}
            label="Avg speed"
            unit={` ${du}/h`}
            color="#16a34a"
            heightClass="h-40"
          />
        </div>
      )}

      {showTrend && showDistance && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Cumulative distance
          </h3>
          <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
            Total {du} logged to date
          </p>
          <LineChartCard
            data={cumChart}
            label="Cumulative"
            unit={` ${du}`}
            color="#a855f7"
            heightClass="h-40"
          />
        </div>
      )}

      {showRecent && stat.recent.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {stat.recent.length === 1
              ? "Last session"
              : `Last ${stat.recent.length} sessions`}
          </h3>
          <ul className="space-y-1 text-sm">
            {stat.recent.map((r, i) => (
              <li
                key={i}
                className="flex items-baseline justify-between gap-3 border-b border-black/5 pb-1 last:border-0 dark:border-white/5"
              >
                <a
                  href={r.href}
                  className="shrink-0 text-slate-400 hover:text-brand-600 hover:underline dark:text-slate-500 dark:hover:text-brand-400"
                >
                  {r.date}
                </a>
                <span className="tabular-nums text-slate-600 dark:text-slate-300">
                  {r.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
