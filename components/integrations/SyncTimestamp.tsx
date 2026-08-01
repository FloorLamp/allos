"use client";

import { useEffect, useState } from "react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatRelativeTime, formatTimestamp } from "@/lib/format-date";

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
}: {
  value: string;
  className?: string;
  // Dense rows (the grid card's one-line hint) take the relative half alone, with the
  // absolute time still on the tooltip — never the raw stored string.
  relativeOnly?: boolean;
}) {
  const prefs = useFormatPrefs();
  const [relative, setRelative] = useState(() => formatRelativeTime(value));

  useEffect(() => {
    const tick = () => setRelative(formatRelativeTime(value));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [value]);

  const absolute = formatTimestamp(value, prefs);
  // Parse the SQLite "YYYY-MM-DD HH:MM:SS" form explicitly as UTC for the machine
  // dateTime attribute; anything else is already zone-marked.
  const isUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const parsed = new Date(isUtc ? `${value.replace(" ", "T")}Z` : value);
  const machine = Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString();

  return (
    <time
      dateTime={machine}
      title={relativeOnly ? absolute : undefined}
      className={className}
      suppressHydrationWarning
    >
      {relativeOnly ? (
        relative
      ) : (
        <>
          {absolute}
          <span className="text-slate-500 dark:text-slate-400">
            {" · "}
            {relative}
          </span>
        </>
      )}
    </time>
  );
}
