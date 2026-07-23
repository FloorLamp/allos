import Link from "next/link";
import { IconFlask2 } from "@tabler/icons-react";
import WidgetHeader from "./WidgetHeader";
import type { ActiveProtocolSummary } from "@/lib/queries/protocols";
import {
  ACTIVE_PROTOCOLS_CAP,
  capDashboardList,
} from "@/lib/dashboard-widgets";
import { practiceCadenceText, PRACTICE_PLENTY_TEXT } from "@/lib/practice";
import LogPracticeButton from "@/app/(app)/protocols/LogPracticeButton";

// Active protocols (issue #660, opt-in via Customize). Each ongoing N-of-1
// experiment as a compact row: days elapsed, this-week practice adherence, and the
// primary outcome's during-window verdict — every value a FORMATTER over the same
// detail-page computations (getActiveProtocolSummaries), never a second engine. The
// widget self-hides when no protocol is ongoing (the page gates `available`).
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
  const { shown, overflow } = capDashboardList(protocols, ACTIVE_PROTOCOLS_CAP);
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
              <div
                className="mt-1 text-sm text-slate-600 dark:text-slate-300"
                data-testid="active-protocol-adherence"
              >
                <span className="font-semibold tabular-nums">
                  {p.adherence.count} /{" "}
                  {practiceCadenceText(
                    p.adherence.perWeek,
                    p.adherence.perWeekMax
                  )}
                </span>{" "}
                {p.adherence.label}
                {p.adherence.atCeiling ? (
                  <span className="badge ml-1.5 bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                    {PRACTICE_PLENTY_TEXT}
                  </span>
                ) : p.adherence.met ? (
                  <span className="badge ml-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    On track
                  </span>
                ) : (
                  <span className="badge ml-1.5 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    Behind
                  </span>
                )}
              </div>
            )}

            {/* One-tap logging for a wellness practice (#1259) — the count is the
                summary's this-week distinct-day tally; the button reports today's own
                running count from its outcome. */}
            {p.adherence?.practiceName && (
              <LogPracticeButton
                practice={p.adherence.practiceName}
                todayCount={0}
                atCeiling={p.adherence.atCeiling}
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
