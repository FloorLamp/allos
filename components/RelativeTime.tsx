"use client";

import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatTimestampDisplay } from "@/lib/format-date";
import { useRelativeLabel } from "@/components/useRelativeLabel";

// A live relative label beside the exact timestamp in the login’s format.
export default function RelativeTime({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const prefs = useFormatPrefs();
  const label = useRelativeLabel(value);

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
