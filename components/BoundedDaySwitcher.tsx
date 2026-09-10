"use client";

import Link from "next/link";
import SegmentedControl from "@/components/SegmentedControl";
import { daySwitcherOwnsDay, useDayContext } from "@/components/DayContext";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { shiftDateStr } from "@/lib/date";
import { formatWeekdayDate } from "@/lib/format-date";
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
      label:
        ago === 0
          ? "Today"
          : ago === 1
            ? "Yesterday"
            : formatWeekdayDate(date, prefs),
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
