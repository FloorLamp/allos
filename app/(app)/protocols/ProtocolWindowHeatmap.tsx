import { chartActivityRamp } from "@/lib/chart-colors";
import type { ProtocolHeatmap } from "@/lib/protocol-heatmap";

const LEVEL_CLASS = [
  chartActivityRamp.emptyClass,
  ...chartActivityRamp.stepClasses,
];

function densityClasses(weeks: number): {
  cell: string;
  gap: string;
} {
  if (weeks <= 18) return { cell: "h-3 w-3", gap: "gap-0.5" };
  if (weeks <= 36) return { cell: "h-2 w-2", gap: "gap-px" };
  return { cell: "h-[5px] w-[5px]", gap: "gap-px" };
}

// Compact, non-interactive protocol-window pattern (#1588). It lives inside the
// card's detail link, so cells expose hover titles while the link remains the one
// focus target. Long windows retain every day and scroll only after the one-year
// density has compressed to fit a 390px viewport.
export default function ProtocolWindowHeatmap({
  data,
}: {
  data: ProtocolHeatmap;
}) {
  const density = densityClasses(data.columns.length);
  const summary = `${data.totalSessions} ${
    data.totalSessions === 1 ? "session" : "sessions"
  } across ${data.activeDays} ${
    data.activeDays === 1 ? "active day" : "active days"
  }`;

  return (
    <div
      className="mt-2 min-w-0"
      data-testid="protocol-heatmap"
      data-start={data.start}
      data-end={data.end}
      role="img"
      aria-label={`Protocol activity from ${data.start} to ${data.end}: ${summary}`}
    >
      <div className="max-w-full overflow-x-auto pb-0.5">
        <div className={`flex w-max ${density.gap}`}>
          {data.columns.map((column, columnIndex) => (
            <div key={columnIndex} className={`flex flex-col ${density.gap}`}>
              {column.map((cell) => (
                <span
                  key={cell.date}
                  title={
                    cell.outside
                      ? undefined
                      : `${cell.date} — ${cell.count} ${
                          cell.count === 1 ? "session" : "sessions"
                        }`
                  }
                  data-date={cell.date}
                  data-count={cell.outside ? undefined : cell.count}
                  data-level={cell.outside ? undefined : cell.level}
                  data-outside={cell.outside ? "true" : undefined}
                  aria-hidden="true"
                  className={`${density.cell} shrink-0 rounded-[1px] ${
                    cell.outside ? "bg-transparent" : LEVEL_CLASS[cell.level]
                  }`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
        {summary}
      </span>
    </div>
  );
}
