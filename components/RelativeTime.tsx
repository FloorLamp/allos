"use client";

import { useEffect, useState } from "react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  formatClock,
  formatDateShape,
  formatRelativeTime,
} from "@/lib/format-date";

// Live "N minutes ago" label for a timestamp, refreshing itself every 30s so a
// card left open stays accurate. Accepts an ISO string or a SQLite UTC datetime
// ("YYYY-MM-DD HH:MM:SS"). The exact local time is on the title tooltip, rendered
// in the login's date/time shape (#964/#1020 — formerly an implicit-locale
// toLocaleString).
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

  // Absolute time for the tooltip: parse the SQLite UTC form explicitly, then
  // render the viewer's local wall clock in their chosen date/time shape.
  const isUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const parsed = new Date(isUtc ? `${value.replace(" ", "T")}Z` : value);
  const title = Number.isNaN(parsed.getTime())
    ? undefined
    : `${formatDateShape(
        prefs.dateFormat,
        parsed.getFullYear(),
        parsed.getMonth() + 1,
        parsed.getDate(),
        { monthStyle: "short", year: true }
      )}, ${formatClock(prefs.timeFormat, parsed.getHours(), parsed.getMinutes())}`;

  return (
    <time
      dateTime={
        Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
      }
      title={title}
      className={className}
      suppressHydrationWarning
    >
      {label}
    </time>
  );
}
