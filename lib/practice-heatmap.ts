import { shiftDateStr, startOfWeekStr } from "./date";
import {
  buildProtocolHeatmap,
  type ProtocolDayUsage,
  type ProtocolHeatmap,
} from "./protocol-heatmap";

export const WELLNESS_PRACTICE_HEATMAP_WEEKS = 13;

// Wellness uses one stable trailing-quarter window so every practice card has the
// same visual scale. The protocol surface uses its own experiment dates while
// sharing the renderer.
export function buildPracticeHeatmap(
  days: readonly ProtocolDayUsage[],
  end: string,
  weekStart = 0
): ProtocolHeatmap {
  const currentWeekStart = startOfWeekStr(end, weekStart);
  const start = shiftDateStr(
    currentWeekStart,
    -(WELLNESS_PRACTICE_HEATMAP_WEEKS - 1) * 7
  );
  return buildProtocolHeatmap(days, start, end, weekStart);
}
