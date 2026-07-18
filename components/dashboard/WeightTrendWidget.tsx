import LineChartCard from "@/components/LineChartCard";
import { formatLongDate } from "@/lib/format-date";
import type { WeightUnit } from "@/lib/settings";
import WidgetHeader from "./WidgetHeader";

// Weight-trend card (thin wrapper around LineChartCard; markup preserved).
export default function WeightTrendWidget({
  data,
  weightUnit,
}: {
  data: { date: string; value: number }[];
  weightUnit: WeightUnit;
}) {
  if (data.length === 1) {
    const point = data[0];
    return (
      <div className="card" data-testid="weight-starting-point">
        <WidgetHeader title="Weight starting point" href="/trends?tab=body" />
        <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
          Starting point
        </p>
        <p className="mt-1 text-3xl font-semibold text-slate-800 dark:text-slate-100">
          {point.value} {weightUnit}
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Recorded {formatLongDate(point.date)}. Add another observation before
          Allos describes a trend.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <WidgetHeader title="Weight trend" href="/trends?tab=body" />
      <LineChartCard data={data} label="Weight" unit={` ${weightUnit}`} />
    </div>
  );
}
