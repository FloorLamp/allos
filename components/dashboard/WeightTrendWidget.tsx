import LineChartCard from "@/components/LineChartCard";
import { formatLongDate, type DisplayFormatPrefs } from "@/lib/format-date";
import type { WeightUnit } from "@/lib/settings";
import WidgetHeader from "./WidgetHeader";
import WeightQuickAdd from "./WeightQuickAdd";

// Weight-trend card (thin wrapper around LineChartCard) with an inline weight
// quick-add (#1042 phase 2) — the same write core as the Trends → Body quick-add
// promoted to the dashboard (see WeightQuickAdd). The chart stays in Trends →
// Body; the quick-add is promotion, not relocation.
export default function WeightTrendWidget({
  data,
  weightUnit,
  formatPrefs,
  today,
}: {
  data: { date: string; value: number }[];
  weightUnit: WeightUnit;
  formatPrefs: DisplayFormatPrefs;
  // The active profile's current date, threaded to the quick-add.
  today: string;
}) {
  const latest = data.length > 0 ? data[data.length - 1] : null;
  // Server-truth marker: rendered from the SERVER-resolved series (not client
  // state), so it updates only once a quick-add write committed and the refresh
  // round-tripped. The e2e settle hook — the dashboard's background action POSTs
  // make settledClick's any-POST wait ambiguous (see e2e/helpers.ts), so the
  // spec settles on this instead (the wellbeing card's mood-server-logged
  // precedent).
  const footer = (
    <>
      <WeightQuickAdd weightUnit={weightUnit} today={today} />
      {latest ? (
        <span
          hidden
          data-testid="weight-server-latest"
          data-date={latest.date}
          data-value={String(latest.value)}
        />
      ) : null}
    </>
  );

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
          Recorded {formatLongDate(point.date, formatPrefs)}. Add another
          observation before Allos describes a trend.
        </p>
        {footer}
      </div>
    );
  }

  return (
    <div className="card">
      <WidgetHeader title="Weight trend" href="/trends?tab=body" />
      <LineChartCard data={data} label="Weight" unit={` ${weightUnit}`} />
      {footer}
    </div>
  );
}
