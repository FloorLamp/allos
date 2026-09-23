import { daySwitcherLabel, type DisplayFormatPrefs } from "@/lib/format-date";

// THE DAY SWITCHER'S WORD, AS PROSE (#5663 ruling 5 and ruling (a), 2026-09-16). A
// quick-log count line names the day the sheet stands on in the word its tab shows,
// so the two cannot disagree. A tab is titled and a count line is prose, so only the
// case changes: "1 yesterday", and `on` before a weekday date, which keeps its capitals.
export function countDayWord(
  date: string,
  today: string,
  prefs: DisplayFormatPrefs
): string {
  const day = daySwitcherLabel(date, today, prefs);
  return day.kind === "date" ? `on ${day.label}` : day.label.toLowerCase();
}
