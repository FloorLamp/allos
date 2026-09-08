"use client";

import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import { formatTimestampDisplay } from "@/lib/format-date";
import { useRelativeLabel } from "@/components/useRelativeLabel";

// Sync status shows the absolute and live relative timestamp. Dense rows use
// the relative label; day ledgers show the clock with its full stamp disclosed.
export default function SyncTimestamp({
  value,
  className,
  relativeOnly = false,
  clockOnly = false,
  timeZone,
}: {
  value: string;
  className?: string;
  // Dense rows show the relative half and NOTHING else (#4419 rule 1): every caller
  // passing this sits on — or links straight to — the integration's status/detail
  // surface, which is where the absolute stamp lives.
  relativeOnly?: boolean;
  // Day-grouped ledgers already establish the calendar date in their header. Their
  // aligned TIME column shows the reader's clock and discloses the full absolute stamp.
  clockOnly?: boolean;
  // A day-grouped profile ledger passes the same timezone that assigned its day.
  // Other compact status surfaces retain their established reader-local display.
  timeZone?: string;
}) {
  const prefs = useFormatPrefs();
  const relative = useRelativeLabel(value);

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
        {/* A clock-only row owns its full stamp. Relative-only rows link to
            the status/detail surface that already owns it. */}
        {clockOnly ? <InfoTooltipIcon label={absolute} /> : null}
      </span>
    );
  }

  return (
    <time dateTime={machine} className={className} suppressHydrationWarning>
      {absolute}
      {/* Hydration suppression does not cascade from the parent time node. */}
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
