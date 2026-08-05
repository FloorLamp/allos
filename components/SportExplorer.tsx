"use client";

import type { SportStat } from "@/lib/queries";
import { formatMinutes } from "@/lib/duration";
import { formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import SportDetailPanel from "@/components/SportDetailPanel";
import ExplorerShell, { type ExplorerColumn } from "@/components/ExplorerShell";

// Sport master–detail explorer: the shared ExplorerShell (#1491 item 3) with
// sport's columns and detail panel.
export default function SportExplorer({ sports }: { sports: SportStat[] }) {
  const todayStr = dateStrInTz(useTimezone());

  const columns: ExplorerColumn<SportStat>[] = [
    { header: "Sport", cellClassName: "font-medium", cell: (s) => s.sport },
    {
      header: "Sessions",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (s) => s.sessions,
    },
    {
      header: "Total time",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (s) => formatMinutes(s.totalDurationMin),
    },
    {
      header: "Longest",
      cellClassName: "font-semibold",
      cell: (s) =>
        s.longestDurationMin > 0 ? formatMinutes(s.longestDurationMin) : "—",
    },
    {
      header: "Last",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (s) => formatRelativeDate(s.lastDate, todayStr),
    },
  ];

  return (
    <ExplorerShell
      heading="Sports"
      hint="Select a sport to see its trend and records."
      emptyMessage="No sport logged yet. Log a tennis match, pickup game, or climb to see a summary."
      emptyAction={{ href: "/training?tab=log", label: "Go to Log" }}
      items={sports}
      itemKey={(s) => s.sport}
      columns={columns}
      renderDetail={(s) => <SportDetailPanel stat={s} />}
    />
  );
}
