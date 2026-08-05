import { IconMoon } from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import {
  sleepWaitingDetail,
  type SleepWaitingState,
} from "@/lib/sleep-waiting";
import { formatClockMinutes, formatRelativeTime } from "@/lib/format-date";
import type { DisplayFormatPrefs } from "@/lib/format-date";

// The dashboard sleep tile while the profile is WAITING for last night (#2097).
//
// It REPLACES the tile's usual figures rather than sitting above them: the state it
// names exists precisely because the only number available is a different night's,
// and nothing on screen should be a value the reader has to discount. The night that
// IS recorded stays one tap away on /sleep, named here at most as a quiet secondary
// line.
export default function SleepWaitingWidget({
  state,
  formatPrefs,
  previousNightLabel,
}: {
  state: SleepWaitingState;
  formatPrefs: DisplayFormatPrefs;
  previousNightLabel: string | null;
}) {
  const detail = sleepWaitingDetail(state, {
    clock: (min) => formatClockMinutes(formatPrefs.timeFormat, min),
    when: (iso) => formatRelativeTime(iso),
  });
  return (
    <div className="card h-full" data-testid="sleep-waiting-widget">
      <WidgetHeader title="Sleep" href="/sleep" />
      <div className="flex items-start gap-3">
        <IconMoon
          className="mt-0.5 h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p
            className="text-sm font-medium text-slate-700 dark:text-slate-200"
            data-testid="sleep-waiting-headline"
            data-kind={state.kind}
          >
            {state.headline}
          </p>
          {detail && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {detail}
            </p>
          )}
          {previousNightLabel && (
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              {previousNightLabel}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
