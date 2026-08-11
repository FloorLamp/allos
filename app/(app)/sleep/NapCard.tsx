import { IconZzz } from "@tabler/icons-react";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { formatHm, formatSleepWindow } from "@/lib/sleep-summary";
import type { NapHistory } from "@/lib/queries/sleep";

function napCountLabel(count: number): string {
  return `${count} ${count === 1 ? "nap" : "naps"}`;
}

export default function NapCard({
  naps,
  formatPrefs,
}: {
  naps: NapHistory;
  formatPrefs: DisplayFormatPrefs;
}) {
  const todayTotal = naps.today.reduce((sum, nap) => sum + nap.durationMin, 0);
  const singleNap = naps.today.length === 1 ? naps.today[0] : null;

  return (
    <section id="naps" className="mb-6" data-testid="nap-section">
      <div className="card" data-testid="nap-card">
        <div className="flex items-center gap-2">
          <IconZzz
            className="h-5 w-5 text-brand-600 dark:text-brand-400"
            stroke={1.75}
            aria-hidden
          />
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Today&apos;s naps
            </h2>
          </div>
        </div>

        {singleNap ? (
          <div className="mt-4" data-testid="nap-today-list">
            <p
              className="text-3xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
              data-testid="nap-today-summary"
            >
              {formatHm(singleNap.durationMin)}
            </p>
            <p
              className="mt-1 text-xl font-semibold tabular-nums text-slate-600 dark:text-slate-300"
              data-testid="nap-today-row"
            >
              {formatSleepWindow(
                formatPrefs.timeFormat,
                singleNap.startMinutes,
                singleNap.endMinutes
              )}
            </p>
          </div>
        ) : (
          <>
            <div className="mt-4" data-testid="nap-today-summary">
              <p className="text-3xl font-bold tabular-nums text-slate-800 dark:text-slate-100">
                {formatHm(todayTotal)}
              </p>
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {napCountLabel(naps.today.length)}
              </p>
            </div>

            <div
              className="mt-4 divide-y divide-black/10 border-t border-black/10 dark:divide-white/10 dark:border-white/10"
              data-testid="nap-today-list"
            >
              {naps.today.map((nap) => (
                <div
                  key={`${nap.date}:${nap.startMinutes}:${nap.endMinutes}`}
                  className="py-3 last:pb-0"
                  data-testid="nap-today-row"
                >
                  <span className="text-xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                    {formatSleepWindow(
                      formatPrefs.timeFormat,
                      nap.startMinutes,
                      nap.endMinutes
                    )}
                  </span>
                  <span className="ml-3 text-lg font-semibold tabular-nums text-indigo-700 dark:text-indigo-300">
                    · {formatHm(nap.durationMin)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
