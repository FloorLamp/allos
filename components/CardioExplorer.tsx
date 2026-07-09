"use client";

import { useState } from "react";
import type { UnitPrefs } from "@/lib/settings";
import type { CardioStat } from "@/lib/queries";
import { fmtDistance, fmtKmh } from "@/lib/units";
import { formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import { EmptyState } from "@/components/ui";
import MobileDetailPage from "@/components/MobileDetailPage";
import { openDetailOnMobile } from "@/components/mobileDetail";
import CardioDetailPanel from "@/components/CardioDetailPanel";
import ScrollFade from "@/components/ScrollFade";

export default function CardioExplorer({
  cardio,
  units,
}: {
  cardio: CardioStat[];
  units: UnitPrefs;
}) {
  const [selected, setSelected] = useState(cardio[0]?.activity ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const du = units.distanceUnit;
  const todayStr = dateStrInTz(useTimezone());

  function selectActivity(activity: string) {
    setSelected(activity);
    openDetailOnMobile(() => setDetailOpen(true));
  }

  if (cardio.length === 0) {
    return (
      <EmptyState message="No cardio logged yet. Log a run, ride, or swim to see trends and records." />
    );
  }

  const current = cardio.find((c) => c.activity === selected) ?? cardio[0];

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="card min-w-0 lg:col-span-3">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Activities
        </h2>
        <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
          Select an activity to see its trend and records.
        </p>
        <ScrollFade>
          <table className="w-full whitespace-nowrap">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/10">
                <th className="th">Activity</th>
                <th className="th">Sessions</th>
                <th className="th">Best distance</th>
                <th className="th">Fastest</th>
                <th className="th">Last</th>
              </tr>
            </thead>
            <tbody>
              {cardio.map((c) => {
                const active = c.activity === current.activity;
                const hasDist = c.hasDistance && c.longestDistanceKm > 0;
                return (
                  <tr
                    key={c.activity}
                    onClick={() => selectActivity(c.activity)}
                    className={`cursor-pointer border-b border-black/5 transition dark:border-white/10 ${
                      active
                        ? "bg-brand-50 dark:bg-brand-950"
                        : "hover:bg-brand-50/60 dark:hover:bg-brand-950/50"
                    }`}
                  >
                    <td className="td font-medium">{c.activity}</td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {c.sessions}
                    </td>
                    <td className="td font-semibold">
                      {hasDist ? fmtDistance(c.longestDistanceKm, du) : "—"}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {hasDist && c.fastestKmh > 0
                        ? fmtKmh(c.fastestKmh, du)
                        : "—"}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {formatRelativeDate(c.lastDate, todayStr)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>

      <div className="card hidden lg:col-span-2 lg:block">
        <CardioDetailPanel stat={current} units={units} />
      </div>

      <MobileDetailPage
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={current.activity}
      >
        <CardioDetailPanel stat={current} units={units} />
      </MobileDetailPage>
    </div>
  );
}
