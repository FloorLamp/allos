// Pure day-grid model for one protocol window (#1588). Cells before the
// protocol start or after its end are explicit `outside` padding, distinct from
// in-window zero-event cells. Intensity reuses the app's blessed activity
// session-count ladder.

import { daysBetweenDateStr, shiftDateStr, startOfWeekStr } from "./date";
import { intensityLevel } from "./workout-heatmap";

export interface ProtocolDayUsage {
  date: string;
  count: number;
}

export interface ProtocolHeatmapCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  outside: boolean;
}

export interface ProtocolHeatmap {
  columns: ProtocolHeatmapCell[][];
  start: string;
  end: string;
  visibleStart: string;
  truncated: boolean;
  totalSessions: number;
  activeDays: number;
}

export const MAX_PROTOCOL_HEATMAP_WEEKS = 53;

export function buildProtocolHeatmap(
  days: readonly ProtocolDayUsage[],
  start: string,
  end: string,
  weekStart = 0
): ProtocolHeatmap {
  const fullGridStart = startOfWeekStr(start, weekStart);
  const endWeekStart = startOfWeekStr(end, weekStart);
  const weekSpan = daysBetweenDateStr(fullGridStart, endWeekStart);
  const fullWeeks = Math.max(1, Math.floor((weekSpan ?? 0) / 7) + 1);
  const weeks = Math.min(fullWeeks, MAX_PROTOCOL_HEATMAP_WEEKS);
  const truncated = fullWeeks > weeks;
  const gridStart = truncated
    ? shiftDateStr(endWeekStart, -(weeks - 1) * 7)
    : fullGridStart;
  const byDate = new Map(days.map((day) => [day.date, day.count]));
  const columns: ProtocolHeatmapCell[][] = [];
  const inWindowDays = days.filter(
    (day) => day.date >= start && day.date <= end && day.count > 0
  );
  const totalSessions = inWindowDays.reduce((sum, day) => sum + day.count, 0);
  const activeDays = inWindowDays.length;

  for (let column = 0; column < weeks; column++) {
    const cells: ProtocolHeatmapCell[] = [];
    for (let row = 0; row < 7; row++) {
      const date = shiftDateStr(gridStart, column * 7 + row);
      const outside = date < start || date > end;
      const count = outside ? 0 : (byDate.get(date) ?? 0);
      cells.push({
        date,
        count,
        level: intensityLevel(count),
        outside,
      });
    }
    columns.push(cells);
  }

  return {
    columns,
    start,
    end,
    visibleStart: gridStart < start ? start : gridStart,
    truncated,
    totalSessions,
    activeDays,
  };
}
