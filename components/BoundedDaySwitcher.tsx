"use client";

import Link from "next/link";
import SegmentedControl from "@/components/SegmentedControl";
import { daySwitcherOwnsDay, useDayContext } from "@/components/DayContext";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { shiftDateStr } from "@/lib/date";
import { daySwitcherLabel } from "@/lib/format-date";
import { historyDayHref } from "@/lib/hrefs";

export default function BoundedDaySwitcher() {
  const day = useDayContext();
  const prefs = useFormatPrefs();
  if (!daySwitcherOwnsDay(day)) {
    throw new Error(
      "BoundedDaySwitcher requires a state-backed bounded DayContext"
    );
  }
  const options = Array.from({ length: day.parts.reach.back + 1 }, (_, ago) => {
    const date = shiftDateStr(day.today, -ago);
    return {
      value: date,
      // The tab's word, from the vocabulary the surfaces BENEATH this switcher now
      // share (#5663 ruling 5) — a count line that says "today" under a tab reading
      // "Yesterday" is the sheet disagreeing with itself. Asked for by day rather than
      // by `ago` so one function answers both callers; this loop is the only place
      // `ago` exists.
      label: daySwitcherLabel(date, day.today, prefs).label,
      testId: `day-context-${ago}`,
      dataAttributes: { "data-days-ago": ago },
    };
  });
  const firstEarlierDay = shiftDateStr(day.today, -day.parts.reach.back - 1);
  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      <SegmentedControl
        options={options}
        value={day.parts.day}
        onChange={day.select}
        ariaLabel="Day to log"
        testId="bounded-day-switcher"
      />
      <Link
        href={historyDayHref(firstEarlierDay)}
        className="control-box inline-flex shrink-0 items-center px-2 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
      >
        Earlier…
      </Link>
    </div>
  );
}
