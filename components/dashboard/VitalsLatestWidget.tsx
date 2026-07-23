import {
  IconHeartbeat,
  IconArrowUpRight,
  IconArrowDownRight,
  IconMinus,
} from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import type { TrendDirection } from "@/lib/latest-trend";

// The prepared model the page builds from the SAME series queries behind Trends →
// Vitals (getBiomarkerSeries for BP, getBodyMetricDailySeries for resting HR), each
// reduced to its latest reading + a direction via the shared latestTrend helper (#221).
export interface VitalsLatestModel {
  bp: {
    systolic: number;
    diastolic: number;
    date: string;
    direction: TrendDirection | null;
  } | null;
  restingHr: {
    value: number;
    date: string;
    direction: TrendDirection | null;
  } | null;
}

function DirArrow({
  direction,
  label,
}: {
  direction: TrendDirection | null;
  label: string;
}) {
  if (!direction) return null;
  const Icon =
    direction === "up"
      ? IconArrowUpRight
      : direction === "down"
        ? IconArrowDownRight
        : IconMinus;
  const word =
    direction === "up" ? "up" : direction === "down" ? "down" : "flat";
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-slate-500 dark:text-slate-400">
      <Icon className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
      <span className="sr-only">{`${word} versus previous ${label}. `}</span>
    </span>
  );
}

// Dashboard "Latest vitals" tile (issue #1221): the most recent blood pressure and
// resting heart rate, each with a trend arrow vs the prior reading — a thin FORMATTER
// over the prepared model above. Informational glance; the full trend lives on Trends
// → Vitals.
export default function VitalsLatestWidget({
  model,
}: {
  model: VitalsLatestModel;
}) {
  const { bp, restingHr } = model;
  return (
    <div className="card" data-testid="vitals-latest-widget">
      <WidgetHeader title="Latest vitals" href="/trends?tab=vitals" />
      <div className="flex items-start gap-3">
        <IconHeartbeat
          className="mt-1 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-2">
          {bp && (
            <div data-testid="vitals-latest-bp">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">
                  {bp.systolic}/{bp.diastolic}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  mmHg
                </span>
                <DirArrow direction={bp.direction} label="blood pressure" />
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Blood pressure · {bp.date}
              </div>
            </div>
          )}
          {restingHr && (
            <div data-testid="vitals-latest-resting-hr">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {restingHr.value}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  bpm resting
                </span>
                <DirArrow
                  direction={restingHr.direction}
                  label="resting heart rate"
                />
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Resting heart rate · {restingHr.date}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
