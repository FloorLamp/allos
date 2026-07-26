import {
  isAllTimeRange,
  isQuickRangeActive,
  quickRanges,
  type DateRange,
  type QuickRange,
} from "./timeline-format";
import { rangeSummaryLabel } from "./trends";

// The Trends hub's CONTEXT LABEL (issue #1485 F) — the pure half of the phone
// chrome that replaced the always-open pill row + tab strip.
//
// The pills and the tab strip precede the charts because they ARE the charts'
// interpretation context: a slope reads differently over 7D than over all time.
// But what has to be VISIBLE is the context LABEL, not the context CONTROL — five
// pills plus Custom… plus five tabs are used about once a session and scrolled
// past on every visit, and on a 390px phone they cost ~130px of the first screen
// before a single chart. So the controls collapse behind a one-line bar reading
// "Overview · 90D ▾", and that label is never hidden: no chart is rendered on this
// page without its window named beside it.
//
// This module owns the LABEL, which is the part with a decision in it (which of
// the six range affordances is lit, and what a custom window is called). The bar's
// open/closed state and its ride on the #1416 shell chrome are presentation and
// live in components/TrendsContextBar.tsx.

// The separator between the two halves of the label. A middot, not an en dash: the
// two halves are peers ("which tab" and "which window"), not a range.
export const TRENDS_CONTEXT_SEPARATOR = " · ";

// The name of the window currently in force, as the chip row itself would say it.
//
// One rule, in the order the chip row draws: a quick-range pill whose bounds match
// exactly (including a surface-injected extra like the Body tab's "1D" — #1466)
// names the window by its own short label; the open window is "All time"; anything
// else is a CUSTOM window with no pill to name it, so it falls back to the shared
// summary the range chip shows ("2026-01-01 → 2026-02-01").
//
// Deliberately derived from the SAME predicates the pills light themselves with
// (isQuickRangeActive / isAllTimeRange) rather than a second interpretation of the
// range: the label's whole job is to say what the expanded control would show, and
// a label that could disagree with the lit pill would be worse than no label.
export function activeRangeLabel(
  range: DateRange,
  todayStr: string,
  extraRanges: readonly QuickRange[] = []
): string {
  const match = [...extraRanges, ...quickRanges(todayStr)].find((qr) =>
    isQuickRangeActive(range, qr)
  );
  if (match) return match.label;
  if (isAllTimeRange(range)) return "All time";
  return rangeSummaryLabel(range, todayStr);
}

// The collapsed bar's one line: "<tab> · <window>". Both halves are always present
// — the tab alone would leave a chart unnamed by its window, and the window alone
// would leave the reader unsure which surface they are on once the heading is gone
// below `sm`.
export function trendsContextLabel(
  tabLabel: string,
  rangeLabel: string
): string {
  return `${tabLabel}${TRENDS_CONTEXT_SEPARATOR}${rangeLabel}`;
}
