import {
  isAllTimeRange,
  isQuickRangeActive,
  quickRanges,
  type DateRange,
  type QuickRange,
} from "./timeline-format";
import { rangeSummaryLabel } from "./trends";

// The Trends hub's range label — the pure half of the phone chrome's fixed range
// trigger.
//
// A chart slope reads differently over 7D than over all time, so the window name
// stays visible even while the full pill row is collapsed. Primary navigation is
// separate and always visible; this module only answers which range label the
// fixed trigger should show.
//
// The open/closed state and its ride on the #1416 shell chrome are presentation
// and live in components/TrendsContextBar.tsx.

// The name of the window currently in force, as the chip row itself would say it.
//
// One rule, in the order the chip row draws: a quick-range pill whose bounds match
// exactly (including a surface-injected extra like the body census "1D" — #1466)
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
