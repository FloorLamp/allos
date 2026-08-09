"use client";

import { useState } from "react";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  loadSyncHistoryPage,
  loadSyncHistoryRuns,
} from "@/app/(app)/integrations/sync-actions";
import { daysBetweenDateStr } from "@/lib/date";
import { formatMonthDay } from "@/lib/format-date";
import type { IntegrationId } from "@/lib/types";
import type {
  SyncDayEntryView,
  SyncDayView,
  SyncRunView,
} from "@/lib/integrations/sync-history-view";
import StatusBadge, { STATUS_TEXT_TONE, STATUS_TONE } from "./StatusBadge";
import SyncTimestamp from "./SyncTimestamp";
import SyncRowsDrilldown from "@/components/SyncRowsDrilldown";
import RawPayloadDialog from "@/components/RawPayloadDialog";

// The day-grouped sync history (#1991), rendered from PLAIN serializable views the
// server projected — no better-sqlite3 row ever crosses into the client.
//
// A day is one line. Opening it itemizes only what earned it, and the unremarkable
// middle stays behind "Show runs". The newest day opens by default: it is what you
// came to check, and collapsing it would make the common visit two taps.

const LEDGER_GRID =
  "grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[9.5rem_6.5rem_minmax(0,1fr)_auto] sm:items-baseline";

function LatestBadge() {
  return (
    <span
      className="rounded-full bg-brand-100 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-brand-700 ring-1 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-800"
      data-testid="sync-history-latest"
    >
      Latest
    </span>
  );
}

function DayTitle({ day, today }: { day: string; today: string }) {
  const prefs = useFormatPrefs();
  const daysAgo = daysBetweenDateStr(day, today);
  const relative = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : null;
  return (
    <>
      <span
        className="font-semibold text-slate-800 dark:text-slate-100"
        data-testid="sync-day-name"
      >
        {relative ?? formatMonthDay(day, prefs)}
      </span>
      {relative && (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {formatMonthDay(day, prefs)}
        </span>
      )}
    </>
  );
}

function RunLine({
  run,
  isAdmin,
  timeZone,
}: {
  run: SyncRunView;
  isAdmin: boolean;
  timeZone: string;
}) {
  return (
    <li className="px-3 py-3" data-testid={`sync-run-${run.id}`}>
      <div className={LEDGER_GRID}>
        <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          <SyncTimestamp value={run.at} clockOnly timeZone={timeZone} />
          {run.isLatest && <LatestBadge />}
        </div>
        <span
          className={`text-sm font-medium ${STATUS_TEXT_TONE[run.verdict.tone]}`}
        >
          {run.verdict.label}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          {run.change ? (
            <span
              className={
                run.changeMuted
                  ? "text-slate-500 dark:text-slate-400"
                  : "text-slate-700 dark:text-slate-200"
              }
            >
              {run.change}
            </span>
          ) : (
            <span className="text-slate-400 dark:text-slate-500">—</span>
          )}
          {run.skipped > 0 && (
            <span
              className={`badge ${STATUS_TONE.caution}`}
              data-testid={`sync-skipped-${run.id}`}
            >
              {run.skipped} skipped
            </span>
          )}
        </div>
        {isAdmin && run.hasRaw ? (
          <div className="sm:justify-self-end">
            <RawPayloadDialog id={run.id} />
          </div>
        ) : (
          <span className="hidden sm:block" />
        )}
        {(run.error || run.notes.length > 0 || run.itemizable > 0) && (
          <div className="space-y-1 sm:col-span-2 sm:col-start-3">
            {run.error && (
              <p
                className="break-words text-xs text-rose-700 dark:text-rose-300"
                data-testid={`sync-error-${run.id}`}
              >
                {run.error}
              </p>
            )}
            {run.notes.length > 0 && (
              <div
                className="space-y-0.5 text-xs text-amber-700 dark:text-amber-300"
                data-testid={`sync-details-${run.id}`}
              >
                {run.notes.map((diagnostic, index) => (
                  <p key={`${index}-${diagnostic}`}>{diagnostic}</p>
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
          </div>
        )}
      </div>
    </li>
  );
}

function RangeLine({
  entry,
  isAdmin,
  providerId,
  timeZone,
}: {
  entry: Extract<SyncDayEntryView, { kind: "range" }>;
  isAdmin: boolean;
  providerId: IntegrationId;
  timeZone: string;
}) {
  const [runs, setRuns] = useState<SyncRunView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  async function expand() {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    try {
      setRuns(await loadSyncHistoryRuns(providerId, entry.runIds));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  if (runs) {
    return (
      <>
        {runs.map((run) => (
          <RunLine
            key={run.id}
            run={run}
            isAdmin={isAdmin}
            timeZone={timeZone}
          />
        ))}
      </>
    );
  }
  return (
    <li
      className="bg-slate-100/60 px-3 py-2.5 text-slate-500 dark:bg-ink-800/40 dark:text-slate-400"
      data-testid="sync-history-range"
    >
      <div className={LEDGER_GRID}>
        <span className="whitespace-nowrap text-xs tabular-nums">
          <SyncTimestamp value={entry.oldestAt} clockOnly timeZone={timeZone} />{" "}
          –{" "}
          <SyncTimestamp value={entry.newestAt} clockOnly timeZone={timeZone} />
        </span>
        <span className="text-xs font-medium uppercase tracking-wide">
          Routine
        </span>
        <span className="text-sm">{entry.label}</span>
        <button
          type="button"
          onClick={() => void expand()}
          disabled={loading}
          data-testid="sync-history-show-each"
          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 disabled:cursor-wait disabled:opacity-60 dark:text-slate-400 dark:hover:text-slate-100 sm:justify-self-end"
        >
          {loading ? "Loading…" : failed ? "Try again" : "Show runs"}
          <IconChevronDown className="h-3 w-3" stroke={2} />
        </button>
      </div>
    </li>
  );
}

function FailureRunLine({
  entry,
  isAdmin,
  providerId,
  timeZone,
}: {
  entry: Extract<SyncDayEntryView, { kind: "failure-run" }>;
  isAdmin: boolean;
  providerId: IntegrationId;
  timeZone: string;
}) {
  const [runs, setRuns] = useState<SyncRunView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  async function expand() {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    try {
      setRuns(await loadSyncHistoryRuns(providerId, entry.runIds));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  if (runs) {
    return (
      <>
        {runs.map((run) => (
          <RunLine
            key={run.id}
            run={run}
            isAdmin={isAdmin}
            timeZone={timeZone}
          />
        ))}
      </>
    );
  }

  return (
    <li className="px-3 py-3" data-testid="sync-history-failure-run">
      <div className={LEDGER_GRID}>
        <div className="flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
          <span>
            <SyncTimestamp
              value={entry.oldestAt}
              clockOnly
              timeZone={timeZone}
            />{" "}
            –{" "}
            <SyncTimestamp
              value={entry.newestAt}
              clockOnly
              timeZone={timeZone}
            />
          </span>
          {entry.isLatest && <LatestBadge />}
        </div>
        <span className={`text-sm font-medium ${STATUS_TEXT_TONE.bad}`}>
          Failed ×{entry.count}
        </span>
        <p className="break-words text-xs text-rose-700 dark:text-rose-300">
          {entry.reason ?? "No error detail was recorded."}
        </p>
        <button
          type="button"
          onClick={() => void expand()}
          disabled={loading}
          data-testid="sync-history-show-failures"
          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 disabled:cursor-wait disabled:opacity-60 dark:text-slate-400 dark:hover:text-slate-100 sm:justify-self-end"
        >
          {loading ? "Loading…" : failed ? "Try again" : "Show runs"}
          <IconChevronDown className="h-3 w-3" stroke={2} />
        </button>
      </div>
    </li>
  );
}

export default function SyncHistoryDays({
  days,
  today,
  providerId,
  initialCursor,
  timeZone,
  isAdmin = false,
}: {
  days: SyncDayView[];
  today: string;
  providerId: IntegrationId;
  initialCursor: string | null;
  timeZone: string;
  isAdmin?: boolean;
}) {
  const [olderDays, setOlderDays] = useState<SyncDayView[]>([]);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [openDays, setOpenDays] = useState<Set<string>>(
    () => new Set(days[0] ? [days[0].day] : [])
  );
  const visibleDays = [...days, ...olderDays];

  function rememberDayOpen(day: string, open: boolean) {
    setOpenDays((current) => {
      if (current.has(day) === open) return current;
      const next = new Set(current);
      if (open) next.add(day);
      else next.delete(day);
      return next;
    });
  }

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setLoadFailed(false);
    try {
      const page = await loadSyncHistoryPage(providerId, cursor);
      setOlderDays((current) => {
        const seen = new Set(current.map((day) => day.day));
        return [...current, ...page.days.filter((day) => !seen.has(day.day))];
      });
      setCursor(page.nextBefore);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <>
      <ul className="mt-3 space-y-1">
        {visibleDays.map((day) => (
          <li
            key={day.day}
            className="border-t border-black/5 first:border-t-0 dark:border-white/5"
          >
            <details
              open={openDays.has(day.day)}
              onToggle={(event) =>
                rememberDayOpen(day.day, event.currentTarget.open)
              }
              className="group"
              data-testid={`sync-day-${day.day}`}
            >
              <summary
                className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 px-1 py-3"
                data-testid="sync-day-summary"
              >
                <IconChevronRight
                  className="mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90 dark:text-slate-500"
                  stroke={2}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <DayTitle day={day.day} today={today} />
                  </div>
                  <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                    {day.label}
                  </p>
                </div>
                {day.attention && (
                  <StatusBadge
                    label={day.attention.label}
                    tone={day.attention.tone}
                    testid={`sync-day-attention-${day.day}`}
                  />
                )}
              </summary>
              <ul className="mb-3 ml-6 border-t border-black/5 divide-y divide-black/5 dark:border-white/10 dark:divide-white/5">
                <li
                  aria-hidden="true"
                  className={`${LEDGER_GRID} hidden px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500 sm:grid`}
                >
                  <span>Time</span>
                  <span>Result</span>
                  <span>Changes and details</span>
                  <span />
                </li>
                {day.entries.map((entry, i) => {
                  if (entry.kind === "run") {
                    return (
                      <RunLine
                        key={entry.run.id}
                        run={entry.run}
                        isAdmin={isAdmin}
                        timeZone={timeZone}
                      />
                    );
                  }
                  if (entry.kind === "failure-run") {
                    // Consecutive IDENTICAL failures collapse (#1880 item 3) so an
                    // upstream outage retried hourly reads as one pattern, not a zebra.
                    // The pattern remains expandable: each run can carry different
                    // structured diagnostics or an admin raw payload even when its
                    // top-level error string matches.
                    return (
                      <FailureRunLine
                        key={`failures-${entry.runIds[0]}`}
                        entry={entry}
                        isAdmin={isAdmin}
                        providerId={providerId}
                        timeZone={timeZone}
                      />
                    );
                  }
                  return (
                    <RangeLine
                      key={`range-${day.day}-${i}`}
                      entry={entry}
                      isAdmin={isAdmin}
                      providerId={providerId}
                      timeZone={timeZone}
                    />
                  );
                })}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      {cursor && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
            className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:cursor-wait disabled:opacity-60 dark:text-slate-300 dark:hover:text-white"
            data-testid="sync-history-load-older"
          >
            {loadingOlder
              ? "Loading…"
              : loadFailed
                ? "Try loading older days again"
                : "Load older days"}
            <IconChevronDown className="h-4 w-4" stroke={2} />
          </button>
        </div>
      )}
    </>
  );
}
