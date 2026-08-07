// The date-ranged container chassis (issue #943, spun out of #860 Track C). The
// date-ranged container pattern (#856 item 0) is: a stored row carries IDENTITY +
// annotations and a [start, end] window; MEMBERSHIP of a date is DERIVED from that window
// (there are NO member foreign keys, so a boundary edit or retro-create is automatically
// correct with nothing re-parented). Two first-class consumers share it — illness
// episodes (#856, lib/illness-episode-store.ts) and menstrual cycles (#714, lib/cycle.ts)
// — so per #860's "extract with the second consumer, never before" rule the range-
// membership computation lives here, ONCE, and both domains format over it (#221
// one-question-one-computation). It is pure list/string math (no DB, no network), so the
// pure test tier, the query layer, and client components can all import it.
//
// THE ONE SEMANTIC THIS OWNS is the END-BOUND convention, and since #2232 there is
// exactly one: `end` is the INCLUSIVE last member day. Menstrual cycles always stored
// it that way (`period_end` is the last bleeding day, #714); illness episodes joined
// with migration 168, which converted the old exclusive `ended_at` (the first
// NON-member day) to the inclusive `end_date`. The chassis used to carry a
// RangeEndBound axis so the two live conventions could each be declared honestly;
// with both consumers inclusive the axis was retired — an exclusive end can no longer
// even be expressed, which is the point.
// A null `start` is unbounded-past (a member since before the capped change-log); a null
// `end` is open/ongoing (a member from `start` onward). Callers keep their own iteration
// and containing-range SELECTION (cycles pick the latest-started candidate then test it;
// illness SQL filters to containing rows then picks the latest start — genuinely different
// strategies that agree only for non-overlapping data, so unifying them would be a false
// commonality); every one routes the actual CONTAINMENT test through here.

export interface DateRange {
  // Inclusive first day (YYYY-MM-DD). null = unbounded start (active before the log).
  start: string | null;
  // Inclusive last day (YYYY-MM-DD). null = open/ongoing.
  end: string | null;
}

// Does `date` (YYYY-MM-DD) fall within `range`, both bounds inclusive? Lexicographic
// string compare is correct for zero-padded ISO dates, so this needs no Date parsing.
// A null start covers everything up to the end; a null end covers everything from the
// start on.
export function rangeContainsDate(range: DateRange, date: string): boolean {
  if (range.start != null && date < range.start) return false;
  if (range.end != null && date > range.end) return false;
  return true;
}
