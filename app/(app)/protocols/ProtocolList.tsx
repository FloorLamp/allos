import Link from "next/link";
import { IconFlask2, IconChevronRight } from "@tabler/icons-react";
import { formatLongDate, type DisplayFormatPrefs } from "@/lib/format-date";
import type { Protocol } from "@/lib/types";

// The protocol list — ongoing protocols carry a live badge; each row deep-links to
// its before/during detail page. Server-rendered (plain data in).
export default function ProtocolList({
  items,
  formatPrefs,
}: {
  items: Protocol[];
  formatPrefs: DisplayFormatPrefs;
}) {
  if (items.length === 0) {
    return (
      <div className="card text-sm text-slate-500 dark:text-slate-400">
        No protocols yet. Start one to compare an intervention against your
        baseline.
      </div>
    );
  }
  return (
    <ul className="space-y-3" data-testid="protocol-list">
      {items.map((p) => {
        const ongoing = p.end_date == null;
        const range = ongoing
          ? `Started ${formatLongDate(p.start_date, formatPrefs)} · ongoing`
          : `${formatLongDate(p.start_date, formatPrefs)} – ${formatLongDate(
              p.end_date!,
              formatPrefs
            )}`;
        return (
          <li key={p.id}>
            <Link
              href={`/protocols/${p.id}`}
              className="card flex items-center gap-3 transition hover:border-brand-300 dark:hover:border-brand-700"
              data-testid={`protocol-row-${p.id}`}
            >
              <IconFlask2
                className="h-5 w-5 shrink-0 text-brand-500"
                stroke={1.75}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-slate-800 dark:text-slate-100">
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
              </div>
              <IconChevronRight
                className="h-4 w-4 shrink-0 text-slate-400"
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
