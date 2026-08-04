import Link from "next/link";
import { IconFlask2 } from "@tabler/icons-react";
import WidgetHeader from "./WidgetHeader";
import type { ActiveProtocolSummary } from "@/lib/queries/protocols";
import {
  ACTIVE_PROTOCOLS_CAP,
  capActionableDashboardList,
} from "@/lib/dashboard-widgets";
import PracticeWeeklyProgress from "@/components/practices/PracticeWeeklyProgress";
import ProtocolLogButton from "@/app/(app)/protocols/ProtocolLogButton";

// Active protocols (issue #660, opt-in via Customize). Each ongoing N-of-1
// experiment as a compact row: days elapsed, this-week practice adherence, and the
// primary outcome's during-window verdict — every value a FORMATTER over the same
// detail-page computations (getActiveProtocolSummaries), never a second engine. The
// widget self-hides when no protocol is ongoing (the page gates `available`).
//
// The weekly-adherence line RENDERS <PracticeWeeklyProgress> (#2008). It used to
// hand-roll a met/not-met chip off `met` alone, which is the two-state answer #748
// replaced: with 2 of 3–5 on a Tuesday `met` is false, so the dashboard shouted amber
// "Behind" while the wellness card and the protocol detail page — both rendering the
// three-state `pace` through this same component — read "On pace". One question, one
// computation, and one component owning the words.
const TONE: Record<string, string> = {
  better: "text-emerald-600 dark:text-emerald-400",
  worse: "text-rose-600 dark:text-rose-400",
  unchanged: "text-slate-500 dark:text-slate-400",
  unknown: "text-slate-500 dark:text-slate-400",
};

const VERDICT: Record<string, string> = {
  better: "Improved",
  worse: "Worsened",
  unchanged: "No change",
  unknown: "—",
};

export default function ActiveProtocolWidget({
  protocols,
}: {
  protocols: ActiveProtocolSummary[];
}) {
  // Standard list-widget cap + overflow link (#1219): this was the one list widget
  // mapping ALL its rows; the rest beyond the cap stay one click away on the
  // protocols surface.
  const { shown, overflow } = capActionableDashboardList(
    protocols,
    ACTIVE_PROTOCOLS_CAP,
    (protocol) => protocol.practice != null
  );
  return (
    <div className="card" data-testid="active-protocols">
      <WidgetHeader title="Active protocols" href="/longevity#protocols" />
      <ul className="space-y-3">
        {shown.map((p) => (
          <li
            key={p.id}
            className="rounded-lg border border-black/5 p-3 dark:border-white/10"
            data-testid={`active-protocol-${p.id}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <Link
                href={p.href}
                className="min-w-0 truncate font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                {p.name}
              </Link>
              <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                Day {p.daysElapsed}
              </span>
            </div>

            {p.adherence && (
              <div className="mt-1">
                <PracticeWeeklyProgress
                  count={p.adherence.count}
                  perWeek={p.adherence.perWeek}
                  perWeekMax={p.adherence.perWeekMax}
                  label={p.adherence.label}
                  noun={p.adherence.noun}
                  pace={p.adherence.pace}
                  atCeiling={p.adherence.atCeiling}
                  testId="active-protocol-adherence"
                />
              </div>
            )}

            {p.practice && (
              <ProtocolLogButton
                practice={p.practice}
                ongoing
                todayCount={p.practiceTodayCount}
                atCeiling={p.adherence?.atCeiling ?? false}
              />
            )}

            {p.primaryOutcome && (
              <div className="mt-1 flex items-baseline gap-2 text-sm">
                <IconFlask2
                  className="h-4 w-4 shrink-0 text-slate-400"
                  stroke={1.75}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
                  {p.primaryOutcome.label}
                </span>
                {!p.primaryOutcome.insufficient && (
                  <span
                    className={`shrink-0 font-medium ${TONE[p.primaryOutcome.betterness]}`}
                  >
                    {VERDICT[p.primaryOutcome.betterness]}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {overflow.length > 0 && (
        <Link
          href="/longevity#protocols"
          data-testid="active-protocols-more"
          className="mt-3 inline-block text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
        >
          +{overflow.length} more protocol{overflow.length === 1 ? "" : "s"} →
        </Link>
      )}
    </div>
  );
}
