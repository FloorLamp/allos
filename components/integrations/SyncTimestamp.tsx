"use client";

import { useEffect, useState } from "react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import { formatRelativeTime, formatTimestampDisplay } from "@/lib/format-date";

// The ONE timestamp treatment for a sync (#1772): the absolute local time AND the
// relative one, together. The surfaces disagreed three ways — the setup pages printed
// the raw SQLite value with a " UTC" suffix (`Last sync: 2026-08-01 09:14:22 UTC`),
// which is neither the reader's clock nor their date shape; Review showed a
// relative-only label, so two events five hours apart could both read "5 hours ago"
// with no absolute time anywhere; and the grid card showed a third. Now every surface
// renders this.
//
// Both halves come from the login's chosen date/time shape (#964/#1020). The relative
// half refreshes every 30s so a page left open stays accurate, and
// suppressHydrationWarning covers the server/client second-boundary race exactly as
// <RelativeTime> does.
export default function SyncTimestamp({
  value,
  className,
  relativeOnly = false,
  clockOnly = false,
  timeZone,
}: {
  value: string;
  className?: string;
  // Dense rows show the relative half and disclose the absolute time on demand.
  relativeOnly?: boolean;
  // Day-grouped ledgers already establish the calendar date in their header. Their
  // aligned TIME column shows the reader's clock and discloses the full absolute stamp.
  clockOnly?: boolean;
  // A day-grouped profile ledger passes the same timezone that assigned its day.
  // Other compact status surfaces retain their established reader-local display.
  timeZone?: string;
}) {
  const prefs = useFormatPrefs();
  const [relative, setRelative] = useState(() => formatRelativeTime(value));

  useEffect(() => {
    const tick = () => setRelative(formatRelativeTime(value));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [value]);

  const display = formatTimestampDisplay(
    value,
    prefs,
    timeZone ? { timeZone } : undefined
  );
  const absolute = display?.absolute ?? value;
  // Parse the SQLite "YYYY-MM-DD HH:MM:SS" form explicitly as UTC for the machine
  // dateTime attribute; anything else is already zone-marked.
  const isUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const parsed = new Date(isUtc ? `${value.replace(" ", "T")}Z` : value);
  const machine = Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString();
  const clock = display?.clock ?? value;

  if (clockOnly || relativeOnly) {
    return (
      <span className={className} data-testid="sync-timestamp-compact">
        <time dateTime={machine} suppressHydrationWarning>
          {clockOnly ? clock : relative}
        </time>
        <InfoTooltipIcon label={absolute} />
      </span>
    );
  }

  return (
    <time dateTime={machine} className={className} suppressHydrationWarning>
      {absolute}
      {/* suppressHydrationWarning does NOT cascade: the <time>'s own flag
              cannot cover text inside this child, so the relative half — whose
              value moves with the real clock between server render and
              hydration — needs its own. Without it a minute boundary crossed
              in that gap is an uncaught React #418 that regenerates the whole
              tree client-side (seen in #2839's CI browser logs on the
              integrations surfaces, exactly where this component renders). */}
      <span
        className="text-slate-500 dark:text-slate-400"
        suppressHydrationWarning
      >
        {" · "}
        {relative}
      </span>
    </time>
  );
}
