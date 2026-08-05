"use client";

import type { UnitPrefs } from "@/lib/settings";
import type { CardioStat } from "@/lib/queries";
import { fmtDistance, fmtKmh } from "@/lib/units";
import { formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import CardioDetailPanel from "@/components/CardioDetailPanel";
import ExplorerShell, { type ExplorerColumn } from "@/components/ExplorerShell";

// Cardio master–detail explorer: the shared ExplorerShell (#1491 item 3) with
// cardio's columns and detail panel.
export default function CardioExplorer({
  cardio,
  units,
}: {
  cardio: CardioStat[];
  units: UnitPrefs;
}) {
  const du = units.distanceUnit;
  const todayStr = dateStrInTz(useTimezone());

  const columns: ExplorerColumn<CardioStat>[] = [
    {
      header: "Activity",
      cellClassName: "font-medium",
      cell: (c) => c.activity,
    },
    {
      header: "Sessions",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (c) => c.sessions,
    },
    {
      header: "Best distance",
      cellClassName: "font-semibold",
      cell: (c) =>
        c.hasDistance && c.longestDistanceKm > 0
          ? fmtDistance(c.longestDistanceKm, du)
          : "—",
    },
    {
      header: "Fastest",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (c) =>
        c.hasDistance && c.longestDistanceKm > 0 && c.fastestKmh > 0
          ? fmtKmh(c.fastestKmh, du)
          : "—",
    },
    {
      header: "Last",
      cellClassName: "text-slate-500 dark:text-slate-400",
      cell: (c) => formatRelativeDate(c.lastDate, todayStr),
    },
  ];

  return (
    <ExplorerShell
      heading="Activities"
      hint="Select an activity to see its trend and records."
      emptyMessage="No cardio logged yet. Log a run, ride, or swim to see trends and records."
      emptyAction={{ href: "/training?tab=log", label: "Go to Log" }}
      items={cardio}
      itemKey={(c) => c.activity}
      columns={columns}
      renderDetail={(c) => <CardioDetailPanel stat={c} units={units} />}
    />
  );
}
