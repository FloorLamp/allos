"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import LineChartCard from "@/components/LineChartCard";
import StackedBarCard from "@/components/StackedBarCard";
import SegmentedControl from "@/components/SegmentedControl";
import { chartSeries } from "@/lib/chart-colors";
import { formatHm, sleepTrendRangeWindows } from "@/lib/sleep-summary";
import {
  SLEEP_DURATION_SERIES_KEY,
  SLEEP_STAGES_SERIES_KEY,
  type DayFillSpec,
} from "@/lib/trend-sparkline";

type Range = 14 | 30 | 90;
const RANGES = [14, 30, 90] as const;

interface TrendCard {
  key: string;
  orderClass: "order-1" | "order-2" | "order-3" | "order-4";
  content: ReactNode;
}

export default function SleepTrendsSection({
  duration,
  stages,
  endDate,
  regularityCard,
  consistencyCard,
}: {
  duration: { date: string; value: number }[];
  stages: {
    date: string;
    deep: number;
    rem: number;
    light: number;
    awake: number;
  }[];
  endDate: string;
  regularityCard?: ReactNode;
  consistencyCard?: ReactNode;
}) {
  const windows = sleepTrendRangeWindows(duration, stages, endDate, RANGES).map(
    (window) => ({ ...window, value: window.days as Range })
  );
  const hasAvailableData = windows.some((window) => window.hasAdditionalData);
  const firstAvailableRange =
    windows.find((window) => window.hasAdditionalData)?.value ?? 14;
  const [range, setRange] = useState<Range>(firstAvailableRange);
  const selectedWindow =
    windows.find((window) => window.value === range) ?? windows[0];
  const durationData = selectedWindow.duration;
  const stageData = selectedWindow.stages;
  // The selector's window IS the fill window (#2258): `sleepTrendWindow` keeps the
  // rows in [endDate - days + 1, endDate], so the chart densifies to exactly the
  // nights the pill promises. A run of nulls at the right edge is the outage —
  // "the last four nights did not sync" — which is precisely what the old
  // compressed axis hid.
  const fillWindow = { from: selectedWindow.from, to: selectedWindow.to };
  const durationFill: DayFillSpec = {
    seriesKey: SLEEP_DURATION_SERIES_KEY,
    ...fillWindow,
  };
  const stagesFill: DayFillSpec = {
    seriesKey: SLEEP_STAGES_SERIES_KEY,
    ...fillWindow,
  };
  const average = useMemo(() => {
    if (durationData.length === 0) return null;
    return (
      durationData.reduce((sum, point) => sum + point.value, 0) /
      durationData.length
    );
  }, [durationData]);
  if (!hasAvailableData && !regularityCard && !consistencyCard) return null;

  const cards: TrendCard[] = [];
  if (durationData.length > 0) {
    cards.push({
      key: "duration",
      orderClass: "order-1",
      content: (
        <div className="card min-w-0" data-testid="sleep-duration-trend">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">
              Sleep duration
            </h3>
            {average != null && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {formatHm(Math.round(average * 60))} average
              </span>
            )}
          </div>
          <LineChartCard
            data={durationData}
            label="Main sleep"
            color={chartSeries.violet}
            unit=" h"
            decimals={1}
            heightClass="h-56"
            gapFill={durationFill}
            referenceValue={
              average == null
                ? null
                : {
                    value: average,
                    label: "Average",
                    color: chartSeries.sky,
                  }
            }
          />
        </div>
      ),
    });
  }
  if (stageData.length > 0) {
    cards.push({
      key: "stages",
      orderClass: "order-2",
      content: (
        <div className="card min-w-0" data-testid="sleep-stages">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Sleep stages
          </h3>
          <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
            Wake-day totals from your source; a recorded nap can contribute.
          </p>
          <StackedBarCard
            data={stageData}
            unit=" h"
            decimals={1}
            gapFill={stagesFill}
            series={[
              { key: "deep", label: "Deep", color: chartSeries.violet },
              { key: "rem", label: "REM", color: chartSeries.rose },
              { key: "light", label: "Light", color: chartSeries.sky },
              { key: "awake", label: "Awake", color: chartSeries.amber },
            ]}
          />
        </div>
      ),
    });
  }
  if (regularityCard) {
    cards.push({
      key: "regularity",
      orderClass: "order-3",
      content: regularityCard,
    });
  }
  if (consistencyCard) {
    cards.push({
      key: "consistency",
      orderClass: "order-4",
      content: consistencyCard,
    });
  }
  const columns = [
    cards.filter((_, index) => index % 2 === 0),
    cards.filter((_, index) => index % 2 === 1),
  ];

  return (
    <section className="mb-6" data-testid="sleep-trends">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Sleep patterns
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Main overnight sleep; naps stay separate. The range applies to
            duration and stages.
          </p>
        </div>
        {hasAvailableData && (
          <SegmentedControl
            options={windows.map((window) => ({
              value: window.value,
              label: `${window.value} days`,
              disabled: !window.hasAdditionalData,
              testId: `sleep-trend-range-${window.value}`,
              dataAttributes: {
                "data-observation-count":
                  window.duration.length + window.stages.length,
              },
            }))}
            value={range}
            onChange={setRange}
            ariaLabel="Duration and stages range"
          />
        )}
      </div>

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
        {columns.map((column, columnIndex) => (
          <div
            key={columnIndex}
            className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6"
          >
            {column.map((card) => (
              <div key={card.key} className={`${card.orderClass} min-w-0`}>
                {card.content}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
