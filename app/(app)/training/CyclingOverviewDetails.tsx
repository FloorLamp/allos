import Link from "next/link";
import CardFootnote from "@/components/CardFootnote";
import CardGroup, { CardGroupSection } from "@/components/CardGroup";
import LineChartCard from "@/components/LineChartCard";
import { StatBox } from "@/components/StatBox";
import { chartSeries } from "@/lib/chart-colors";
import {
  formatLongDate,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { cyclingRideHref, type CyclingLens } from "@/lib/hrefs";
import type { CyclingOverviewData } from "@/lib/queries";
import { rideZoneRows } from "@/lib/ride-detail";
import type { DistanceUnit } from "@/lib/settings";
import { ZONE_COLORS } from "@/lib/training-zones";
import { fmtDistance, fmtKmh } from "@/lib/units";
import { formatMinutes } from "@/lib/duration";

function elevation(valueM: number, unit: DistanceUnit): string {
  return unit === "mi"
    ? `${Math.round(valueM * 3.28084).toLocaleString("en-US")} ft`
    : `${Math.round(valueM).toLocaleString("en-US")} m`;
}

function elapsed(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function deltaText(value: number | null): string {
  if (value == null) return "No prior-period baseline";
  if (value === 0) return "Same as the prior period";
  return `${value > 0 ? "+" : ""}${value}% vs prior period`;
}

function recordValue(
  key: CyclingOverviewData["rollup"]["records"][number]["key"],
  value: number,
  unit: DistanceUnit
): string {
  if (key === "distance") return fmtDistance(value, unit);
  if (key === "speed") return fmtKmh(value, unit);
  if (key === "duration") return formatMinutes(value);
  if (key === "elevation") return elevation(value, unit);
  return `${Math.round(value)} W`;
}

const RECORD_LABELS = {
  distance: "Longest distance",
  speed: "Fastest average",
  duration: "Longest time",
  elevation: "Biggest climb",
  power: "Highest average power",
} as const;

const CONDITION_COLORS = {
  clear: chartSeries.amber,
  cloudy: chartSeries.sky,
  wet: chartSeries.brand,
  wintry: chartSeries.violet,
} as const;

function monthName(key: string, data: CyclingOverviewData): string {
  const month = data.distribution.months[Number(key.slice(5, 7)) - 1];
  return `${month?.label ?? key.slice(5, 7)} ${key.slice(0, 4)}`;
}

export type CyclingOverviewSection =
  "summary" | "patterns" | "power" | "heart-rate" | "coverage";

export default function CyclingOverviewDetails({
  data,
  distanceUnit,
  formatPrefs,
  section,
  lens,
}: {
  data: CyclingOverviewData;
  distanceUnit: DistanceUnit;
  formatPrefs: DisplayFormatPrefs;
  section: CyclingOverviewSection;
  lens: CyclingLens;
}) {
  const { rollup } = data;
  const zones = data.zoneMinutes ? rideZoneRows(data.zoneMinutes) : [];
  const zoneTotal = zones.reduce((sum, zone) => sum + zone.minutes, 0);
  const totalLoad = data.loadPoints.reduce(
    (sum, point) => sum + point.trainingLoad,
    0
  );
  const noun = data.indoorOnly ? "session" : "ride";
  const plural = data.indoorOnly ? "sessions" : "rides";
  const records = data.indoorOnly
    ? rollup.records.filter((record) => record.key !== "elevation")
    : rollup.records;

  return (
    <>
      {section === "summary" ? (
        <>
          <CardGroup
            title="Totals & records"
            description={`All ${plural}, independent of the selected chart range.`}
            data-testid="cycling-totals"
          >
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <StatBox
                label={data.indoorOnly ? "Sessions" : "Rides"}
                value={String(rollup.totals.rides)}
              />
              <StatBox
                label="Distance"
                value={fmtDistance(rollup.totals.distanceKm, distanceUnit)}
              />
              <StatBox
                label={data.indoorOnly ? "Training time" : "Ride time"}
                value={formatMinutes(rollup.totals.durationMin)}
              />
              <StatBox
                label="Average speed"
                value={
                  rollup.totals.averageSpeedKmh == null
                    ? "—"
                    : fmtKmh(rollup.totals.averageSpeedKmh, distanceUnit)
                }
              />
              {!data.indoorOnly ? (
                <StatBox
                  label="Elevation"
                  value={elevation(rollup.totals.elevationM, distanceUnit)}
                />
              ) : null}
              <StatBox
                label="Mechanical work"
                value={
                  rollup.totals.kilojoules > 0
                    ? `${Math.round(rollup.totals.kilojoules).toLocaleString("en-US")} kJ`
                    : "—"
                }
              />
            </dl>

            {records.length > 0 ? (
              <CardGroupSection>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Personal records
                </h3>
                <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
                  {records.map((record) => (
                    <li
                      key={record.key}
                      className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                          {RECORD_LABELS[record.key]}
                        </span>
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                          {record.title} ·{" "}
                          {formatLongDate(record.date, formatPrefs)}
                        </span>
                      </span>
                      <Link
                        href={cyclingRideHref(record.rideId, lens)}
                        className="shrink-0 text-sm font-semibold tabular-nums text-brand-700 hover:underline dark:text-brand-300"
                      >
                        {recordValue(record.key, record.value, distanceUnit)}
                      </Link>
                    </li>
                  ))}
                  {!data.indoorOnly && data.segmentPersonalBestCount > 0 ? (
                    <li className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                          Segment personal bests
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          Across recorded segment efforts
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                        {data.segmentPersonalBestCount}
                      </span>
                    </li>
                  ) : null}
                </ul>
              </CardGroupSection>
            ) : null}
          </CardGroup>

          <CardGroup
            title={`Last ${rollup.recentDays} days`}
            description={`Recent ${data.indoorOnly ? "training" : "riding"} volume compared with the preceding period.`}
            data-testid="cycling-recent-form"
          >
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <StatBox
                label={data.indoorOnly ? "Sessions" : "Rides"}
                value={String(rollup.recent.rides)}
              />
              <StatBox
                label="Distance"
                value={fmtDistance(rollup.recent.distanceKm, distanceUnit)}
                sub={deltaText(rollup.distanceChangePercent)}
              />
              <StatBox
                label={data.indoorOnly ? "Training time" : "Ride time"}
                value={formatMinutes(rollup.recent.durationMin)}
                sub={deltaText(rollup.durationChangePercent)}
              />
              {!data.indoorOnly ? (
                <StatBox
                  label="Elevation"
                  value={elevation(rollup.recent.elevationM, distanceUnit)}
                />
              ) : null}
            </dl>
          </CardGroup>
        </>
      ) : null}

      {section === "patterns" ? (
        <CardGroup
          title={data.indoorOnly ? "When you train" : "When you ride"}
          description={
            data.indoorOnly
              ? `Seasonality across your ${data.activityName} history.`
              : `Seasonality and weather patterns across your ${data.activityName} history.`
          }
          className="lg:col-span-2"
          data-testid="cycling-distribution"
        >
          {data.distribution.highlights.length > 0 ||
          data.distribution.weather.insight ? (
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {[
                ...data.distribution.highlights,
                data.distribution.weather.insight,
              ]
                .filter((text): text is string => text != null)
                .map((text) => (
                  <li
                    key={text}
                    className="rounded-xl bg-brand-50 px-3 py-2 text-sm font-medium text-brand-900 dark:bg-brand-950/40 dark:text-brand-100"
                  >
                    {text}
                  </li>
                ))}
            </ul>
          ) : null}

          <CardGroupSection className="first:mt-4 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                {data.indoorOnly ? "Sessions" : "Rides"} by calendar month
              </h3>
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {data.distribution.observedCalendarMonths} months in history
              </span>
            </div>
            <div
              className="mt-4 grid h-36 grid-cols-12 items-end gap-1 sm:gap-2"
              aria-label={`Average ${plural} by calendar month`}
            >
              {data.distribution.months.map((month) => {
                const maxRate = Math.max(
                  ...data.distribution.months.map(
                    (candidate) => candidate.ridesPerObservedMonth
                  ),
                  1
                );
                const height =
                  month.observedMonths === 0
                    ? 0
                    : month.ridesPerObservedMonth === 0
                      ? 2
                      : Math.max(
                          8,
                          (month.ridesPerObservedMonth / maxRate) * 100
                        );
                const description =
                  month.observedMonths === 0
                    ? `${month.label}: outside recorded history`
                    : `${month.label}: ${month.rides} ${month.rides === 1 ? noun : plural} across ${month.observedMonths} observed ${month.label}s`;
                return (
                  <div
                    key={month.month}
                    className="flex h-full min-w-0 flex-col items-center justify-end gap-1"
                    title={description}
                    aria-label={description}
                  >
                    <span className="text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">
                      {month.observedMonths > 0 ? month.rides : ""}
                    </span>
                    <span className="flex h-24 w-full items-end justify-center rounded-xs bg-slate-100 dark:bg-ink-800">
                      {month.observedMonths > 0 ? (
                        <span
                          className="block w-full rounded-xs"
                          style={{
                            height: `${height}%`,
                            backgroundColor: chartSeries.brand,
                          }}
                          aria-hidden
                        />
                      ) : (
                        <span
                          className="mb-1 block w-1 rounded-full bg-slate-300 dark:bg-slate-600"
                          style={{ height: 2 }}
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                      {month.shortLabel}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Bar height is {plural} per observed occurrence of that month. A
              dot means the month falls outside your recorded history; a flat
              bar is an observed month with no {plural}.
            </p>
          </CardGroupSection>

          <CardGroupSection>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Seasons
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {data.distribution.seasons.map((season) => (
                <StatBox
                  key={season.key}
                  label={season.label}
                  value={String(season.rides)}
                  sub={
                    season.observedMonths > 0
                      ? `${season.ridesPerObservedMonth}/month · ${season.percent}% of ${plural}`
                      : "Not observed yet"
                  }
                />
              ))}
            </dl>
            {data.distribution.longestQuietPeriod ? (
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                <span className="font-semibold">Longest quiet stretch:</span>{" "}
                {data.distribution.longestQuietPeriod.months} completed month
                {data.distribution.longestQuietPeriod.months === 1 ? "" : "s"}
                {" · "}
                {monthName(
                  data.distribution.longestQuietPeriod.startMonth,
                  data
                )}
                {data.distribution.longestQuietPeriod.startMonth ===
                data.distribution.longestQuietPeriod.endMonth
                  ? ""
                  : `–${monthName(data.distribution.longestQuietPeriod.endMonth, data)}`}
              </p>
            ) : null}
          </CardGroupSection>

          {!data.indoorOnly ? (
            <CardGroupSection>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Conditions
                </h3>
                {data.distribution.weather.coverageDays > 0 ? (
                  <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {data.distribution.weather.coverageDays} weather days ·{" "}
                    {data.distribution.weather.coveredRideDays} covered ride
                    days
                  </span>
                ) : null}
              </div>
              {data.distribution.weather.coverageDays > 0 ? (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {data.distribution.weather.conditions.map((condition) => (
                      <div
                        key={condition.key}
                        className="rounded-xl bg-slate-50 p-3 dark:bg-ink-900"
                      >
                        <dt className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{
                              backgroundColor: CONDITION_COLORS[condition.key],
                            }}
                            aria-hidden
                          />
                          {condition.label}
                        </dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-white">
                          {condition.rideDayRate}%
                        </dd>
                        <dd className="mt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                          {condition.rideDays} ride days /{" "}
                          {condition.availableDays} available
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {data.distribution.weather.temperatureBands.some(
                    (band) => band.rideDays > 0
                  ) ? (
                    <div className="mt-4">
                      <h4 className="section-label">
                        Daily high on covered ride days
                      </h4>
                      <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                        {data.distribution.weather.temperatureBands.map(
                          (band) => (
                            <li
                              key={band.key}
                              className="flex items-baseline justify-between gap-2"
                            >
                              <span className="text-slate-600 dark:text-slate-300">
                                {band.label}
                              </span>
                              <span className="font-semibold tabular-nums text-slate-900 dark:text-white">
                                {band.rideDays} · {band.percent}%
                              </span>
                            </li>
                          )
                        )}
                      </ul>
                    </div>
                  ) : null}
                  <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                    Ride rate is the share of cached days under each condition
                    on which you rode. Weather is for your saved home area, not
                    every point along the route.
                  </p>
                </>
              ) : (
                <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-ink-900 dark:text-slate-300">
                  Weather comparisons appear once Weather &amp; UV has cached
                  daily conditions for your saved home area.
                </p>
              )}
            </CardGroupSection>
          ) : null}
        </CardGroup>
      ) : null}

      {section === "heart-rate" && data.zoneWindow && zoneTotal > 0 ? (
        <CardGroup
          title="Heart-rate distribution"
          // This card is windowed where the totals above are all-time, so it names
          // the days it counted rather than letting the section imply every ride.
          description={`${zoneTotal.toLocaleString("en-US")} recorded minutes inside ${noun} windows, over the ${data.zoneWindow.weeks} weeks through ${formatMonthDay(data.zoneWindow.through, formatPrefs)}.`}
          className="lg:col-span-2"
          data-testid="cycling-heart-rate-zones"
        >
          <div
            className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800"
            aria-label={`${data.activityName} time in heart-rate zones`}
          >
            {zones.map((zone, index) =>
              zone.minutes > 0 ? (
                <span
                  key={zone.id}
                  style={{
                    width: `${zone.percent}%`,
                    backgroundColor: ZONE_COLORS[index],
                  }}
                  title={`${zone.name}: ${zone.percent}%`}
                />
              ) : null
            )}
          </div>
          <ul className="mt-3 space-y-2">
            {zones.map((zone, index) => (
              <li
                key={zone.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: ZONE_COLORS[index] }}
                    aria-hidden
                  />
                  {zone.name}
                </span>
                <span className="tabular-nums text-slate-500 dark:text-slate-400">
                  {zone.minutes} min · {zone.percent}%
                </span>
              </li>
            ))}
          </ul>
          {data.zoneModel ? (
            <CardFootnote>{data.zoneModel.formula}</CardFootnote>
          ) : null}
        </CardGroup>
      ) : null}

      {section === "power" &&
      (data.powerBests.length > 0 || data.loadPoints.length > 0) ? (
        <CardGroup
          title="Power profile"
          description="Personal best rolling efforts and FTP-relative training load."
          className="lg:col-span-2"
          data-testid="cycling-power-profile"
        >
          {data.powerBests.length > 0 ? (
            <dl className="mt-4 grid grid-cols-2 gap-3">
              {data.powerBests.map((best) => (
                <StatBox
                  key={best.seconds}
                  label={`${best.label} best`}
                  value={`${best.watts} W`}
                  sub={formatLongDate(best.date, formatPrefs)}
                  href={cyclingRideHref(best.activityId, lens)}
                />
              ))}
            </dl>
          ) : null}

          {data.loadPoints.length > 0 ? (
            <CardGroupSection>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Training load
                </h3>
                <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {Math.round(totalLoad).toLocaleString("en-US")} total
                </span>
              </div>
              <div className="mt-3">
                <LineChartCard
                  // gap-exempt: per-RIDE training load, an event axis.
                  data={data.loadPoints.map((point) => ({
                    date: point.date,
                    value: point.trainingLoad,
                  }))}
                  label="Training load"
                  color={chartSeries.amber}
                  heightClass="h-40"
                  decimals={0}
                />
              </div>
              {data.latestFtpW ? (
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  Latest FTP snapshot: {data.latestFtpW} W
                </p>
              ) : null}
            </CardGroupSection>
          ) : null}

          {data.powerZoneTimes.length > 0 ? (
            <CardGroupSection>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Time in power zones
              </h3>
              <div
                className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800"
                aria-label="Cycling time in power zones"
              >
                {data.powerZoneTimes.map((zone, index) =>
                  zone.seconds > 0 ? (
                    <span
                      key={zone.zone}
                      style={{
                        width: `${zone.percent}%`,
                        backgroundColor:
                          ZONE_COLORS[index % ZONE_COLORS.length],
                      }}
                      title={`Zone ${zone.zone}: ${zone.percent}%`}
                    />
                  ) : null
                )}
              </div>
              <ol className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500 dark:text-slate-400">
                {data.powerZoneTimes.map((zone) => (
                  <li key={zone.zone} className="flex justify-between gap-2">
                    <span>Zone {zone.zone}</span>
                    <span className="tabular-nums">
                      {elapsed(zone.seconds)} · {zone.percent}%
                    </span>
                  </li>
                ))}
              </ol>
            </CardGroupSection>
          ) : null}
        </CardGroup>
      ) : null}

      {section === "coverage" &&
        ((!data.indoorOnly &&
          (data.routeCount > 0 || data.segmentRideCount > 0)) ||
          data.telemetryRideCount > 0) && (
          <CardGroup
            title="Data coverage"
            description={
              data.indoorOnly
                ? "Recorded sensor depth across your history."
                : "Recorded course and sensor depth across your history."
            }
            className="lg:col-span-2"
            data-testid="cycling-data-coverage"
          >
            <dl className="mt-4 grid grid-cols-2 gap-3">
              {!data.indoorOnly ? (
                <StatBox
                  label="Mapped rides"
                  value={String(data.routeCount)}
                  sub={`${data.uniqueRouteCount} distinct route${data.uniqueRouteCount === 1 ? "" : "s"}`}
                />
              ) : null}
              <StatBox
                label="Sensor traces"
                value={String(data.telemetryRideCount)}
                sub={`${data.indoorOnly ? "Sessions" : "Rides"} with detailed telemetry`}
                className={data.indoorOnly ? "col-span-2" : undefined}
              />
              {!data.indoorOnly ? (
                <StatBox
                  label="Segment data"
                  value={String(data.segmentRideCount)}
                  sub={`Ride${data.segmentRideCount === 1 ? "" : "s"} with recorded segment efforts`}
                  className="col-span-2"
                />
              ) : null}
            </dl>
          </CardGroup>
        )}
    </>
  );
}
