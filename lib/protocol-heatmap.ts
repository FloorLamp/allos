// Pure day-grid model for one protocol window (#1588). Cells before the
// protocol start or after its end are explicit `outside` padding, distinct from
// in-window zero-event cells. Intensity reuses the app's blessed activity
// session-count ladder.

import { dayGrid } from "./day-grid";
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

// An ADAPTER over the shared `dayGrid` (#2042): `outside` is the grid's
// `before`/`after` padding under this domain's older name — a protocol window is
// bounded on BOTH sides, which is why it has padding the workout heatmap doesn't.
export function buildProtocolHeatmap(
  days: readonly ProtocolDayUsage[],
  start: string,
  end: string,
  weekStart = 0
): ProtocolHeatmap {
  const grid = dayGrid({
    start,
    end,
    weekStart,
    orientation: "week-columns",
    maxWeeks: MAX_PROTOCOL_HEATMAP_WEEKS,
  });
  const byDate = new Map(days.map((day) => [day.date, day.count]));
  const inWindowDays = days.filter(
    (day) => day.date >= start && day.date <= end && day.count > 0
  );

  const columns: ProtocolHeatmapCell[][] = grid.weeks.map((cells) =>
    cells.map((cell) => {
      const outside = cell.position !== "in-window";
      const count = outside ? 0 : (byDate.get(cell.date) ?? 0);
      return {
        date: cell.date,
        count,
        level: intensityLevel(count),
        outside,
      } satisfies ProtocolHeatmapCell;
    })
  );

  return {
    columns,
    start,
    end,
    visibleStart: grid.visibleStart,
    truncated: grid.truncated,
    totalSessions: inWindowDays.reduce((sum, day) => sum + day.count, 0),
    activeDays: inWindowDays.length,
  };
}
