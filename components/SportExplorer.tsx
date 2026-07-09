"use client";

import { useState } from "react";
import type { SportStat } from "@/lib/queries";
import { formatMinutes } from "@/lib/duration";
import { formatRelativeDate } from "@/lib/format-date";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import { EmptyState } from "@/components/ui";
import MobileDetailPage from "@/components/MobileDetailPage";
import { openDetailOnMobile } from "@/components/mobileDetail";
import SportDetailPanel from "@/components/SportDetailPanel";
import ScrollFade from "@/components/ScrollFade";

export default function SportExplorer({ sports }: { sports: SportStat[] }) {
  const [selected, setSelected] = useState(sports[0]?.sport ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const todayStr = dateStrInTz(useTimezone());

  function selectSport(sport: string) {
    setSelected(sport);
    openDetailOnMobile(() => setDetailOpen(true));
  }

  if (sports.length === 0) {
    return (
      <EmptyState message="No sport logged yet. Log a tennis match, pickup game, or climb to see a summary." />
    );
  }

  const current = sports.find((s) => s.sport === selected) ?? sports[0];

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="card min-w-0 lg:col-span-3">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Sports
        </h2>
        <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
          Select a sport to see its trend and records.
        </p>
        <ScrollFade>
          <table className="w-full whitespace-nowrap">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/10">
                <th className="th">Sport</th>
                <th className="th">Sessions</th>
                <th className="th">Total time</th>
                <th className="th">Longest</th>
                <th className="th">Last</th>
              </tr>
            </thead>
            <tbody>
              {sports.map((s) => {
                const active = s.sport === current.sport;
                return (
                  <tr
                    key={s.sport}
                    onClick={() => selectSport(s.sport)}
                    className={`cursor-pointer border-b border-black/5 transition dark:border-white/10 ${
                      active
                        ? "bg-brand-50 dark:bg-brand-950"
                        : "hover:bg-brand-50/60 dark:hover:bg-brand-950/50"
                    }`}
                  >
                    <td className="td font-medium">{s.sport}</td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {s.sessions}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {formatMinutes(s.totalDurationMin)}
                    </td>
                    <td className="td font-semibold">
                      {s.longestDurationMin > 0
                        ? formatMinutes(s.longestDurationMin)
                        : "—"}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {formatRelativeDate(s.lastDate, todayStr)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>

      <div className="card hidden lg:col-span-2 lg:block">
        <SportDetailPanel stat={current} />
      </div>

      <MobileDetailPage
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={current.sport}
      >
        <SportDetailPanel stat={current} />
      </MobileDetailPage>
    </div>
  );
}
