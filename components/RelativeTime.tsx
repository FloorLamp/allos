"use client";

import { useEffect, useState } from "react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatRelativeTime, formatTimestampDisplay } from "@/lib/format-date";

// Live "N minutes ago" label for a timestamp, refreshing itself every 30s so a
// card left open stays accurate. Accepts an ISO string or a SQLite UTC datetime
// ("YYYY-MM-DD HH:MM:SS"). The exact local time stays visible beside it in the
// login's date/time shape (#964/#1020 — formerly an implicit-locale
// toLocaleString), so the timestamp has one reachable home without a row control.
// suppressHydrationWarning because the server and first client render can land a
// second apart (e.g. "just now" vs "1 minute ago"); the effect resyncs on mount.
export default function RelativeTime({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const prefs = useFormatPrefs();
  const [label, setLabel] = useState(() => formatRelativeTime(value));

  useEffect(() => {
    const tick = () => setLabel(formatRelativeTime(value));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [value]);

  const display = formatTimestampDisplay(value, prefs);
  // Parse the SQLite UTC form explicitly for the machine dateTime attribute.
  const isUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const parsed = new Date(isUtc ? `${value.replace(" ", "T")}Z` : value);
  const machine = Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString();

  return (
    <span className={className}>
      <time dateTime={machine} suppressHydrationWarning>
        {display ? `${display.absolute} · ${label}` : label}
      </time>
    </span>
  );
}
