import { shiftDateStr } from "./date";
import { ALL_TIME_RANGE_VALUE, type DateRange } from "./timeline-format";
import { formatMonthDay, type DisplayFormatPrefs } from "./format-date";

export const EVENT_LEDGER_DEFAULT_DAYS = 90;

export function resolveEventLedgerRange(
  parsed: DateRange,
  today: string,
  rangeParam?: string
): DateRange {
  if (rangeParam === ALL_TIME_RANGE_VALUE) return {};
  if (parsed.from || parsed.to) return parsed;
  return {
    from: shiftDateStr(today, -(EVENT_LEDGER_DEFAULT_DAYS - 1)),
    to: today,
  };
}

export function eventLedgerWindowNote(
  range: DateRange,
  noun: string,
  prefs: DisplayFormatPrefs,
  today: string
): string | undefined {
  if (!range.from && !range.to) return undefined;
  const from = range.from && formatMonthDay(range.from, prefs, { today });
  const to = range.to && formatMonthDay(range.to, prefs, { today });
  if (from && to)
    return `Showing ${noun} from ${from} to ${to}. Older entries are still on record.`;
  if (from)
    return `Showing ${noun} from ${from} onward. Older entries are still on record.`;
  return `Showing ${noun} up to ${to}.`;
}

export function eventLedgerEmptyNote(
  range: DateRange,
  noun: string,
  next: string,
  prefs: DisplayFormatPrefs,
  today: string
): string {
  const from = range.from && formatMonthDay(range.from, prefs, { today });
  const to = range.to && formatMonthDay(range.to, prefs, { today });
  const window =
    from && to
      ? ` from ${from} to ${to}`
      : from
        ? ` from ${from} onward`
        : to
          ? ` up to ${to}`
          : "";
  return `No ${noun} were logged${window}. ${next}`;
}
