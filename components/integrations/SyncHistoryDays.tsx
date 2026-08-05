"use client";

import { useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import type { StatusTone } from "@/lib/integrations/provider-state";
import type { SyncRunReason } from "@/lib/integrations/sync-history-days";
import { STATUS_TEXT_TONE } from "./StatusBadge";
import SyncTimestamp from "./SyncTimestamp";
import SyncRowsDrilldown from "@/components/SyncRowsDrilldown";
import RawPayloadDialog from "@/components/RawPayloadDialog";

// The day-grouped sync history (#1991), rendered from PLAIN serializable views the
// server projected — no better-sqlite3 row ever crosses into the client.
//
// A day is one line. Opening it itemizes only what earned it, and the unremarkable
// middle stays behind "Show each". The newest day opens by default: it is what you
// came to check, and collapsing it would make the common visit two taps.

export interface SyncRunView {
  id: number;
  at: string;
  ok: boolean;
  verdict: { label: string; tone: StatusTone };
  // What the run changed, in the provider's vocabulary. Null for a failure.
  change: string | null;
  changeMuted: boolean;
  skipped: number;
  error: string | null;
  // The structured, non-secret diagnostics the run carried.
  notes: string[];
  // Records the drill-in can LIST, and the ones it honestly cannot.
  itemizable: number;
  remainder: number;
  hasRaw: boolean;
}

export type SyncDayEntryView =
  | { kind: "run"; reason: SyncRunReason; run: SyncRunView }
  | {
      kind: "failure-run";
      count: number;
      newestAt: string;
      oldestAt: string;
      reason: string | null;
      runs: SyncRunView[];
    }
  | {
      kind: "range";
      label: string;
      newestAt: string;
      oldestAt: string;
      runs: SyncRunView[];
    };

export interface SyncDayView {
  day: string;
  label: string;
  attention: { label: string; tone: StatusTone } | null;
  newestAt: string;
  entries: SyncDayEntryView[];
}

const REASON_NOTE: Partial<Record<SyncRunReason, string>> = {
  newest: "latest",
};

function RunLine({
  run,
  isAdmin,
  reason,
}: {
  run: SyncRunView;
  isAdmin: boolean;
  reason?: SyncRunReason;
}) {
  const note = reason ? REASON_NOTE[reason] : undefined;
  return (
    <li className="py-2" data-testid={`sync-run-${run.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <SyncTimestamp
          value={run.at}
          relativeOnly
          className="text-xs text-slate-500 dark:text-slate-400"
        />
        <span className={`font-medium ${STATUS_TEXT_TONE[run.verdict.tone]}`}>
          {run.verdict.label}
        </span>
        {run.change && (
          <span
            className={
              run.changeMuted
                ? "text-sm text-slate-500 dark:text-slate-400"
                : "text-sm text-slate-700 dark:text-slate-200"
            }
          >
            {run.change}
          </span>
        )}
        {run.skipped > 0 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            · {run.skipped} skipped
          </span>
        )}
        {note && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            · {note}
          </span>
        )}
        {isAdmin && run.hasRaw && (
          <span className="ml-auto">
            <RawPayloadDialog id={run.id} />
          </span>
        )}
      </div>
      {run.error && (
        <p
          className="mt-0.5 break-words text-xs text-rose-700 dark:text-rose-300"
          data-testid={`sync-error-${run.id}`}
        >
          {run.error}
        </p>
      )}
      {run.notes.length > 0 && (
        <div
          className="mt-0.5 space-y-0.5 text-xs text-amber-700 dark:text-amber-300"
          data-testid={`sync-details-${run.id}`}
        >
          {run.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
      {run.itemizable > 0 && (
        <SyncRowsDrilldown
          eventId={run.id}
          count={run.itemizable}
          remainder={run.remainder}
        />
      )}
    </li>
  );
}

function RangeLine({
  entry,
  isAdmin,
}: {
  entry: Extract<SyncDayEntryView, { kind: "range" }>;
  isAdmin: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <>
        {entry.runs.map((run) => (
          <RunLine key={run.id} run={run} isAdmin={isAdmin} />
        ))}
      </>
    );
  }
  return (
    <li
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 text-slate-500 dark:text-slate-400"
      data-testid="sync-history-range"
    >
      <span className="text-xs">
        <SyncTimestamp value={entry.oldestAt} relativeOnly /> –{" "}
        <SyncTimestamp value={entry.newestAt} relativeOnly />
      </span>
      <span className="text-sm">{entry.label}</span>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        data-testid="sync-history-show-each"
        className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
      >
        Show each →
      </button>
    </li>
  );
}

export default function SyncHistoryDays({
  days,
  isAdmin = false,
}: {
  days: SyncDayView[];
  isAdmin?: boolean;
}) {
  return (
    <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
      {days.map((day, index) => (
        <li key={day.day}>
          <details open={index === 0} data-testid={`sync-day-${day.day}`}>
            <summary
              className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 gap-y-1 py-2"
              data-testid="sync-day-summary"
            >
              <IconChevronRight
                className="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform dark:text-slate-400 [details[open]>summary_&]:rotate-90"
                stroke={2}
              />
              <SyncTimestamp
                value={day.newestAt}
                relativeOnly
                className="text-xs text-slate-500 dark:text-slate-400"
              />
              <span className="text-sm text-slate-700 dark:text-slate-200">
                {day.label}
              </span>
              {day.attention && (
                <span
                  className={`text-xs font-medium ${STATUS_TEXT_TONE[day.attention.tone]}`}
                  data-testid={`sync-day-attention-${day.day}`}
                >
                  · {day.attention.label}
                </span>
              )}
            </summary>
            <ul className="ml-5 divide-y divide-black/5 border-l border-black/5 pl-3 dark:divide-white/5 dark:border-white/5">
              {day.entries.map((entry, i) => {
                if (entry.kind === "run") {
                  return (
                    <RunLine
                      key={entry.run.id}
                      run={entry.run}
                      reason={entry.reason}
                      isAdmin={isAdmin}
                    />
                  );
                }
                if (entry.kind === "failure-run") {
                  // Consecutive IDENTICAL failures collapse (#1880 item 3) so an
                  // upstream outage retried hourly reads as one pattern, not a zebra.
                  return (
                    <li
                      key={`failures-${entry.runs[0].id}`}
                      className="py-2"
                      data-testid="sync-history-failure-run"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          <SyncTimestamp value={entry.oldestAt} relativeOnly />{" "}
                          –{" "}
                          <SyncTimestamp value={entry.newestAt} relativeOnly />
                        </span>
                        <span className={`font-medium ${STATUS_TEXT_TONE.bad}`}>
                          Failed ×{entry.count}
                        </span>
                        {isAdmin && entry.runs[0].hasRaw && (
                          <span className="ml-auto">
                            <RawPayloadDialog id={entry.runs[0].id} />
                          </span>
                        )}
                      </div>
                      {entry.reason && (
                        <p className="mt-0.5 break-words text-xs text-rose-700 dark:text-rose-300">
                          {entry.reason}
                        </p>
                      )}
                    </li>
                  );
                }
                return (
                  <RangeLine
                    key={`range-${day.day}-${i}`}
                    entry={entry}
                    isAdmin={isAdmin}
                  />
                );
              })}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}
