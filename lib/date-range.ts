// The date-ranged container chassis (issue #943, spun out of #860 Track C). The
// date-ranged container pattern (#856 item 0) is: a stored row carries IDENTITY +
// annotations and a [start, end] window; MEMBERSHIP of a date is DERIVED from that window
// (there are NO member foreign keys, so a boundary edit or retro-create is automatically
// correct with nothing re-parented). Two first-class consumers now share it — illness
// episodes (#856, lib/illness-episode-store.ts) and menstrual cycles (#714, lib/cycle.ts)
// — so per #860's "extract with the second consumer, never before" rule the range-
// membership computation lives here, ONCE, and both domains format over it (#221
// one-question-one-computation). It is pure list/string math (no DB, no network), so the
// pure test tier, the query layer, and client components can all import it.
//
// THE ONE SEMANTIC THIS OWNS — and the one it deliberately does NOT unify — is the
// END-BOUND convention. A range's `end` means two genuinely different things across the
// two live consumers, and the chassis expresses BOTH explicitly rather than picking one
// and silently converting the other:
//   • INCLUSIVE end — `end` is the LAST member day. Menstrual cycles: `period_end` is the
//     last bleeding day, so the period covers `start..end` INCLUSIVE.
//   • EXCLUSIVE end — `end` is the FIRST NON-member day. Illness episodes: `ended_at` is
//     the first inactive day (the situation was active up to the day before), so the
//     episode covers `[start, end)`.
// A null `start` is unbounded-past (a member since before the capped change-log); a null
// `end` is open/ongoing (a member from `start` onward). Callers keep their own iteration
// and containing-range SELECTION (cycles pick the latest-started candidate then test it;
// illness SQL filters to containing rows then picks the latest start — genuinely different
// strategies that agree only for non-overlapping data, so unifying them would be a false
// commonality); every one routes the actual CONTAINMENT test through here.

export type RangeEndBound = "inclusive" | "exclusive";

// The two domains' declared conventions, named so a call site reads its own choice:
//   INCLUSIVE_END — menstrual cycles: `period_end` is the inclusive last bleeding day (#714)
//   EXCLUSIVE_END — illness episodes: `ended_at` is the exclusive first inactive day (#856)
export const INCLUSIVE_END: RangeEndBound = "inclusive";
export const EXCLUSIVE_END: RangeEndBound = "exclusive";

export interface DateRange {
  // Inclusive first day (YYYY-MM-DD). null = unbounded start (active before the log).
  start: string | null;
  // Range end (YYYY-MM-DD). null = open/ongoing. Interpreted per RangeEndBound.
  end: string | null;
}

// Does `date` (YYYY-MM-DD) fall within `range` under `endBound`? Lexicographic string
// compare is correct for zero-padded ISO dates, so this needs no Date parsing. A null
// start covers everything up to the end; a null end covers everything from the start on.
export function rangeContainsDate(
  range: DateRange,
  date: string,
  endBound: RangeEndBound
): boolean {
  if (range.start != null && date < range.start) return false;
  if (range.end != null) {
    if (endBound === "inclusive") {
      if (date > range.end) return false;
    } else {
      if (date >= range.end) return false;
    }
  }
  return true;
}
