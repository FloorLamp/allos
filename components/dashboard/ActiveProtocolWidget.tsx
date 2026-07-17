import Link from "next/link";
import { IconFlask2 } from "@tabler/icons-react";
import WidgetHeader from "./WidgetHeader";
import type { ActiveProtocolSummary } from "@/lib/queries/protocols";

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
  return (
    <div className="card" data-testid="active-protocols">
      <WidgetHeader title="Active protocols" href="/protocols" linkLabel="Protocols" />
      <ul className="space-y-3">
        {protocols.map((p) => (
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
                  {p.adherence.count} / {p.adherence.perWeek}
                </span>{" "}
                {p.adherence.label}
                {p.adherence.met ? (
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
    </div>
  );
}
