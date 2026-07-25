import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getBiomarkerSeries,
  getBodyMetricDailySeries,
  getMetricDailyTotals,
  getDaylightOutdoorMinutesSeries,
  getHrMinutes,
} from "@/lib/queries";
import { getUnitPrefs, getHomeLocation, getTimezone } from "@/lib/settings";
import { lastNDates, daysBetweenDateStr } from "@/lib/date";
import { HRV_METRIC } from "@/lib/vitals-input";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import { chartSeries } from "@/lib/chart-colors";
import { isIntradayRange, type DateRange } from "@/lib/timeline-format";
import { timelineDayHref } from "@/lib/hrefs";
import {
  buildTodayVitalsStrip,
  hrSlotSeries,
  intradayVitalPoints,
  toIntradaySlotSeries,
  type VitalReadingRow,
} from "@/lib/vitals-day";
import type { MedicalRecord } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import VitalsQuickAdd from "./VitalsQuickAdd";
import QuickAddPanel, { type QuickAddItem } from "./QuickAddPanel";
import VitalsTodayStrip from "./VitalsTodayStrip";

// The Trends → Vitals section (#1076). The physiologic vitals were previously
// stranded on the biomarker view — charted on a years-axis with a yearly-retest
// nudge, and (for a fever) leaking into the flagged-biomarker hero. Now that the
// biomarker surfaces scope to `lab` only, this is their home: BP (systolic +
// diastolic), SpO2, respiratory rate, resting HR, and HRV as windowed trend
// charts. Body TEMPERATURE gets ACUTE grammar — a recent-readings view with a
// fever reference line and a link to the illness/fever surface — NEVER a years
// trajectory (a fever is a spike, not a slow trend). Reuses the existing series
// queries + LineChartCard; no new data path.
//
// #1466 adds the tab's TODAY layer, still over those same reads:
//   • a Today strip (latest reading per vital, with its clock time) above the charts,
//   • a 1D window (via the shared control's extra-ranges slot) that swaps the
//     windowed daily charts for INTRADAY ones — the day's HR minute series (the
//     #1068 read) and time-positioned BP/SpO2 points on the day's own clock grid,
//   • that HR chart full-bleed + taller on a phone (charts are the one content
//     class that earns the viewport's full width),
//   • the quick-add wrapped in the #1067 chip collapse, as the Body tab already is.

type Point = { date: string; value: number };

// medical_records vitals (BP/SpO2/respiratory rate/temperature) — one value per
// reading, mapped to the {date,value} the chart takes. Windowed by the shared range.
function vitalSeries(
  rows: MedicalRecord[],
  range: DateRange,
  round = 0
): Point[] {
  const factor = 10 ** round;
  return filterSeriesByRange(
    rows
      .filter((r) => r.value_num != null)
      .map((r) => ({
        date: r.date,
        value: Math.round((r.value_num as number) * factor) / factor,
      })),
    range
  );
}

// A daily aggregate ({date,value}) in the row shape the Today strip reads. These
// series carry no clock time by construction (they ARE the day's number), so their
// strip entry shows a value without a time — which is exactly why the issue keeps
// them in the strip rather than charting them at 1D.
function dailyRows(
  series: { date: string; value: number }[]
): VitalReadingRow[] {
  return series.map((d) => ({ date: d.date, value_num: d.value }));
}

// Fahrenheit fever threshold (100.4 °F / 38 °C) — the reference line on the acute
// temperature view, matching the illness/fever surface (#859).
const FEVER_F = 100.4;
// The acute temperature view shows only the most recent readings (never a years
// trajectory), regardless of the shared window.
const TEMP_RECENT = 30;
// The intraday charts are the tab's densest content and the only place a phone gets
// a full-viewport plot, so they run taller than the standard windowed h-48 cards.
const INTRADAY_HEIGHT = "h-72 sm:h-80";
const INTRADAY_POINT_HEIGHT = "h-56";
// Full-bleed on a phone: cancel the shell's 1rem gutter, drop the card's horizontal
// padding, rounding and side borders, and neutralize `.card`'s own `max-w-full` —
// which would otherwise clamp the widened box back to the container width and merely
// SHIFT the card instead of widening it. From `sm` up it is an ordinary card again.
const FULL_BLEED_CARD =
  "card -mx-4 max-w-none rounded-none border-x-0 px-0 sm:mx-0 sm:max-w-full sm:rounded-xl sm:border-x sm:px-5";

export default async function VitalsSection({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const todayStr = today(profile.id);
  const tz = getTimezone(profile.id);
  // The 1D pill's window (from == to == today). Only this tab offers that pill,
  // because only this tab has intraday content to swap in.
  const intraday = isIntradayRange(range, todayStr);

  // The raw, UNWINDOWED reading rows. The charts window them below; the Today strip
  // and the intraday charts read today out of these same arrays, so a past custom
  // window never hides today's answer — and no extra query is issued either way.
  const systolicRows = getBiomarkerSeries(
    profile.id,
    "Blood Pressure Systolic"
  );
  const diastolicRows = getBiomarkerSeries(
    profile.id,
    "Blood Pressure Diastolic"
  );
  const spo2Rows = getBiomarkerSeries(profile.id, "Oxygen Saturation");
  const respiratoryRows = getBiomarkerSeries(profile.id, "Respiratory Rate");
  const temperatureRows = getBiomarkerSeries(profile.id, "Body Temperature");
  const restingHrDaily = getBodyMetricDailySeries(
    profile.id,
    "resting_hr",
    ALL_ROWS
  ).map((w) => ({ date: w.date, value: Math.round(w.value) }));
  const hrvDaily = getMetricDailyTotals(profile.id, HRV_METRIC, 3650).map(
    (d) => ({ date: d.date, value: Math.round(d.value) })
  );

  const systolic = vitalSeries(systolicRows, range);
  const diastolic = vitalSeries(diastolicRows, range);
  const spo2 = vitalSeries(spo2Rows, range);
  const respiratory = vitalSeries(respiratoryRows, range);
  const restingHr = filterSeriesByRange(restingHrDaily, range);
  const hrv = filterSeriesByRange(hrvDaily, range);

  // A. The Today strip — a formatter over the arrays above (buildTodayVitalsStrip
  // picks the latest reading of each vital on today and resolves its clock time).
  const todayVitals = buildTodayVitalsStrip(
    [
      {
        key: "bp",
        label: "Blood pressure",
        unit: "mmHg",
        rows: systolicRows,
        pairRows: diastolicRows,
      },
      {
        key: "resting-hr",
        label: "Resting HR",
        unit: "bpm",
        rows: dailyRows(restingHrDaily),
      },
      { key: "spo2", label: "Oxygen sat.", unit: "%", rows: spo2Rows },
      {
        key: "respiratory-rate",
        label: "Respiratory rate",
        unit: "/min",
        rows: respiratoryRows,
      },
      {
        key: "temperature",
        label: "Temperature",
        unit: "°F",
        rows: temperatureRows,
        decimals: 1,
      },
      { key: "hrv", label: "HRV", unit: "ms", rows: dailyRows(hrvDaily) },
    ],
    todayStr,
    tz
  );

  // B. The 1D swap. Built ONLY at 1D, so an ordinary window never pays for the
  // day's minute scan. HR comes from the SAME getHrMinutes read + downsampleHr
  // model the #1068 intraday panel draws — one computation, two formatters.
  const intradayHr = intraday
    ? hrSlotSeries(todayStr, getHrMinutes(profile.id, todayStr))
    : [];
  const intradaySystolic = intraday
    ? intradayVitalPoints(systolicRows, todayStr, tz)
    : [];
  const intradayDiastolic = intraday
    ? intradayVitalPoints(diastolicRows, todayStr, tz)
    : [];
  const intradaySpo2 = intraday
    ? intradayVitalPoints(spo2Rows, todayStr, tz)
    : [];
  const hasIntradayBp =
    intradaySystolic.length > 0 || intradayDiastolic.length > 0;
  const hasIntraday =
    intradayHr.length > 0 || hasIntradayBp || intradaySpo2.length > 0;

  // Sun / outdoor time (#1171): a trend over the SAME getDaylightOutdoorMinutes
  // computation the DaylightChip and the coaching average read (#221 — the chart is
  // a formatter, no second engine). Data-gated on a home location: with none, sun
  // features are quietly off (the series query returns []) so the card never renders
  // — mirroring the empty-map behavior of the source. The window is the shared
  // range, defaulting to a trailing 90 days when open and capped so the underlying
  // date IN(...) stays bounded. Skipped at 1D: a single day is not a trend.
  const home = intraday ? null : getHomeLocation(profile.id);
  let sun: Point[] = [];
  if (home) {
    const to = range.to ?? todayStr;
    const MAX_SERIES_DAYS = 366;
    const span = range.from
      ? Math.min((daysBetweenDateStr(range.from, to) ?? 0) + 1, MAX_SERIES_DAYS)
      : 90;
    const dates = lastNDates(to, Math.max(span, 1));
    sun = getDaylightOutdoorMinutesSeries(profile.id, dates);
  }

  // Temperature: acute — the most recent readings only, newest kept, oldest first.
  const tempRows = temperatureRows
    .filter((r) => r.value_num != null)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const temperature: Point[] = tempRows.slice(-TEMP_RECENT).map((r) => ({
    date: r.date,
    value: Math.round((r.value_num as number) * 10) / 10,
  }));

  const hasBp = systolic.length > 0 || diastolic.length > 0;
  const hasAny =
    hasBp ||
    spo2.length > 0 ||
    respiratory.length > 0 ||
    restingHr.length > 0 ||
    hrv.length > 0 ||
    sun.length > 0 ||
    temperature.length > 0;

  // D. The quick-add adopts the #1067 chip collapse: on a phone it is a single
  // "+ Log vitals" chip (the Body tab's pattern, one component, no hand-mirrored
  // branch pair), and its deep links — /trends?tab=vitals&focus=blood-pressure —
  // still land expanded and focused. Desktop keeps the inline form.
  const quickAddItems: QuickAddItem[] = [
    {
      id: "vitals",
      label: "vitals",
      node: (
        <VitalsQuickAdd
          defaultDate={todayStr}
          temperatureUnit={units.temperatureUnit}
        />
      ),
    },
  ];

  return (
    <div data-testid="trends-vitals">
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Your physiologic vitals — blood pressure, oxygen saturation, respiratory
        rate, resting heart rate, HRV, and body temperature. Log a reading with
        the quick-add below.
      </p>

      <div className="mb-6">
        <QuickAddPanel items={quickAddItems} />
      </div>

      <VitalsTodayStrip rows={todayVitals} date={todayStr} />

      {intraday ? (
        !hasIntraday ? (
          <EmptyState message="Nothing intraday recorded today yet. Timed readings and worn heart-rate data show up here; pick a longer window for the daily trends." />
        ) : (
          <div className="space-y-6">
            {intradayHr.length > 0 && (
              <section
                className={FULL_BLEED_CARD}
                data-testid="vitals-intraday-hr"
              >
                <div className="mb-3 px-4 sm:px-0">
                  <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                    Heart rate today
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Per-minute heart rate across the clock, from the same day
                    series the timeline&rsquo;s day view draws. A break in the
                    line is a gap in wear, not a flat heart rate.
                  </p>
                </div>
                {/* The plot spans the viewport on a phone — charts are the one
                    content class that earns full-bleed; forms and text stay at
                    the shell's normal width. */}
                <div data-testid="vitals-intraday-hr-plot" className="w-full">
                  <LineChartCard
                    data={intradayHr}
                    label="Heart rate"
                    unit=" bpm"
                    color={chartSeries.rose}
                    showDots={false}
                    connectNulls={false}
                    heightClass={INTRADAY_HEIGHT}
                  />
                </div>
              </section>
            )}

            {hasIntradayBp && (
              <div className="card" data-testid="vitals-intraday-bp">
                <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                  Blood pressure today
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <LineChartCard
                    data={toIntradaySlotSeries(intradaySystolic)}
                    label="Systolic"
                    unit=" mmHg"
                    color={chartSeries.rose}
                    connectNulls={false}
                    heightClass={INTRADAY_POINT_HEIGHT}
                  />
                  <LineChartCard
                    data={toIntradaySlotSeries(intradayDiastolic)}
                    label="Diastolic"
                    unit=" mmHg"
                    color={chartSeries.violet}
                    connectNulls={false}
                    heightClass={INTRADAY_POINT_HEIGHT}
                  />
                </div>
              </div>
            )}

            {intradaySpo2.length > 0 && (
              <div className="card" data-testid="vitals-intraday-spo2">
                <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                  Oxygen saturation today
                </h3>
                <LineChartCard
                  data={toIntradaySlotSeries(intradaySpo2)}
                  label="SpO₂"
                  unit="%"
                  // Same token as the daily SpO₂ chart below — one metric, one
                  // color. (#1445 renamed this slot `emerald` → `sky`.)
                  color={chartSeries.sky}
                  connectNulls={false}
                  heightClass={INTRADAY_POINT_HEIGHT}
                />
              </div>
            )}

            <p className="text-xs text-slate-500 dark:text-slate-400">
              A reading logged without a clock time stays in the Today strip
              above — it can&rsquo;t be placed on a clock axis honestly.{" "}
              <Link
                href={timelineDayHref(todayStr)}
                className="font-medium text-brand-700 hover:underline dark:text-brand-400"
              >
                See today&rsquo;s timeline
              </Link>
              .
            </p>
          </div>
        )
      ) : !hasAny ? (
        <EmptyState message="No vitals logged yet. Add a reading above to see the trend." />
      ) : (
        <div className="space-y-6">
          {hasBp && (
            <div className="card" data-testid="vitals-blood-pressure">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Blood pressure
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <LineChartCard
                  data={systolic}
                  label="Systolic"
                  unit=" mmHg"
                  color={chartSeries.rose}
                  heightClass="h-48"
                />
                <LineChartCard
                  data={diastolic}
                  label="Diastolic"
                  unit=" mmHg"
                  color={chartSeries.violet}
                  heightClass="h-48"
                />
              </div>
            </div>
          )}

          {spo2.length > 0 && (
            <div className="card" data-testid="vitals-spo2">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Oxygen saturation
              </h3>
              <LineChartCard
                data={spo2}
                label="SpO₂"
                unit="%"
                color={chartSeries.sky}
                heightClass="h-48"
              />
            </div>
          )}

          {respiratory.length > 0 && (
            <div className="card" data-testid="vitals-respiratory-rate">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Respiratory rate
              </h3>
              <LineChartCard
                data={respiratory}
                label="Respiratory rate"
                unit=" /min"
                color={chartSeries.violet}
                heightClass="h-48"
              />
            </div>
          )}

          {restingHr.length > 0 && (
            <div className="card" data-testid="vitals-resting-hr">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Resting heart rate
              </h3>
              <LineChartCard
                data={restingHr}
                label="Resting HR"
                unit=" bpm"
                color={chartSeries.brand}
                heightClass="h-48"
              />
            </div>
          )}

          {hrv.length > 0 && (
            <div className="card" data-testid="vitals-hrv">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Heart rate variability
              </h3>
              <LineChartCard
                data={hrv}
                label="HRV"
                unit=" ms"
                color={chartSeries.amber}
                heightClass="h-48"
              />
            </div>
          )}

          {sun.length > 0 && (
            <div className="card" data-testid="vitals-sun-outdoor">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Sun / outdoor time
              </h3>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Daylight minutes from your outdoor sessions, scoped to the solar
                day at your home location. The same figure the day view&rsquo;s
                sun chip shows.
              </p>
              <LineChartCard
                data={sun}
                label="Outdoor daylight"
                unit=" min"
                color={chartSeries.amber}
                heightClass="h-48"
              />
            </div>
          )}

          {temperature.length > 0 && (
            <div className="card" data-testid="vitals-temperature">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                  Body temperature
                </h3>
                <Link
                  href="/medical/episodes"
                  className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
                >
                  Illness episodes <IconArrowRight size={14} />
                </Link>
              </div>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Recent readings ({temperature.length}). Temperature is an acute
                signal — a fever is tracked on the illness/fever chart, not a
                long-term trajectory.
              </p>
              <LineChartCard
                data={temperature}
                label="Temperature"
                unit=" °F"
                color={chartSeries.rose}
                referenceValue={{ value: FEVER_F, label: "Fever" }}
                heightClass="h-48"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
