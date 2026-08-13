import Link from "next/link";
import { IconFlask2, IconChevronRight } from "@tabler/icons-react";
import { formatLongDate, type DisplayFormatPrefs } from "@/lib/format-date";
import type { Protocol } from "@/lib/types";
import type { ProtocolHeatmap } from "@/lib/protocol-heatmap";
import PracticeHeatmap from "@/components/practices/PracticeHeatmap";
import { EmptyState } from "@/components/ui";

// The protocol list — ongoing protocols carry a live badge; each row deep-links to
// its before/during detail page. Server-rendered (plain data in).
export default function ProtocolList({
  items,
  heatmaps,
  formatPrefs,
}: {
  items: Protocol[];
  heatmaps: Record<number, ProtocolHeatmap>;
  formatPrefs: DisplayFormatPrefs;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        message="No protocols yet. Start one when you want to test a change."
      />
    );
  }
  return (
    <ul className="space-y-1" data-testid="protocol-list">
      {items.map((p) => {
        const ongoing = p.end_date == null;
        const range = ongoing
          ? `Started ${formatLongDate(p.start_date, formatPrefs)}`
          : `${formatLongDate(p.start_date, formatPrefs)} – ${formatLongDate(
              p.end_date!,
              formatPrefs
            )}`;
        return (
          <li key={p.id}>
            <Link
              href={`/protocols/${p.id}`}
              className="flex items-start gap-3 rounded-lg px-3 py-3 transition hover:bg-white/70 dark:hover:bg-white/5"
              data-testid={`protocol-row-${p.id}`}
            >
              <IconFlask2
                className="mt-0.5 h-5 w-5 shrink-0 text-brand-500"
                stroke={1.75}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="min-w-0 basis-full font-semibold text-slate-800 sm:basis-auto sm:truncate dark:text-slate-100">
                    {p.name}
                  </span>
                  {ongoing && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      Ongoing
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {range}
                  {p.outcomeKeys.length > 0 && (
                    <>
                      {" · "}
                      {p.outcomeKeys.length} outcome
                      {p.outcomeKeys.length === 1 ? "" : "s"}
                    </>
                  )}
                </div>
                <PracticeHeatmap
                  data={heatmaps[p.id]}
                  label="Protocol activity"
                  testId="protocol-heatmap"
                  className="mt-2"
                />
              </div>
              <IconChevronRight
                className="self-center h-4 w-4 shrink-0 text-slate-400"
                stroke={1.75}
                aria-hidden
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
