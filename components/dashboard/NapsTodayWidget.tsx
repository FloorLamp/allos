import { IconZzz } from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import type { TimeFormat } from "@/lib/format-date";
import { formatHm, formatSleepWindow } from "@/lib/sleep-summary";
import type { NapHistoryRow } from "@/lib/queries/sleep";

export default function NapsTodayWidget({
  naps,
  timeFormat,
}: {
  naps: NapHistoryRow[];
  timeFormat: TimeFormat;
}) {
  const total = naps.reduce((sum, nap) => sum + nap.durationMin, 0);
  return (
    <div className="card" data-testid="naps-today-widget">
      <WidgetHeader title="Today's naps" href="/sleep#naps" />
      <div className="flex items-start gap-3">
        <IconZzz
          className="mt-1 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
          stroke={1.75}
          aria-hidden
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
              data-testid="naps-today-duration"
            >
              {formatHm(total)}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {naps.length} {naps.length === 1 ? "nap" : "naps"}
            </span>
          </div>
          <div className="mt-0.5 space-y-0.5 text-sm tabular-nums text-slate-600 dark:text-slate-300">
            {naps.map((nap) => (
              <p
                key={`${nap.date}:${nap.startMinutes}:${nap.endMinutes}`}
                data-testid="naps-today-row"
              >
                {formatSleepWindow(
                  timeFormat,
                  nap.startMinutes,
                  nap.endMinutes
                )}
                {naps.length > 1 ? ` · ${formatHm(nap.durationMin)}` : ""}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
