import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";
import { chartAdherenceState, type ChartCellTone } from "@/lib/chart-colors";
import { SeriesPoint } from "@/components/SeriesAccess";

// Shared period-strip geometry with tones restricted to the chart palette.
// The group names the strip; a named cell exposes its label on focus and hover.

export type StateCellSize = "dot" | "cell" | "tile";

const SIZE_CLASS: Record<StateCellSize, string> = {
  // A key's swatch; a period in a strip; a period carrying its own text (a day
  // number, a taken/intended count), square by ratio so a tile grid can narrow.
  dot: "h-2.5 w-2.5 rounded-xs",
  cell: "h-4 w-4 rounded-xs",
  tile: "flex aspect-square items-center justify-center rounded-md text-xs font-semibold tabular-nums",
};

/** The one geometry for a state-painted square, at the declared size. */
export function stateCellClass(
  size: StateCellSize,
  tone: ChartCellTone
): string {
  // An unfilled not-due swatch needs an outline away from its calendar grid.
  const outline =
    size === "dot" && tone === chartAdherenceState.na.class
      ? " border border-black/15 dark:border-white/15"
      : "";
  return `${SIZE_CLASS[size]} ${tone}${outline}`;
}

// `tone` is a class from lib/chart-colors; `state` becomes `data-state`; `label` is
// the cell's own name where the group does not name every period; `className` is the
// responsive visibility a caller owns (a strip that unrolls at a breakpoint).
export type StateCellSpec = {
  key: string;
  tone: ChartCellTone;
  state: string;
  label?: string;
  href?: AppRoute;
  className?: string;
  testId?: string;
};

export function StateCells({
  cells,
  label,
  testId,
  className,
}: {
  cells: StateCellSpec[];
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      role="group"
      aria-label={label}
      className={`flex flex-wrap items-center gap-1 ${className ?? ""}`}
    >
      {cells.map((cell) => {
        const shared = {
          "data-testid": cell.testId,
          "data-state": cell.state,
          className: `${stateCellClass("cell", cell.tone)} ${cell.className ?? ""}`,
        };
        return cell.href ? (
          <Link
            key={cell.key}
            {...shared}
            aria-label={cell.label}
            href={cell.href}
            className={`${shared.className} ring-brand-400 hover:ring-2 focus:outline-hidden focus:ring-2`}
          />
        ) : cell.label ? (
          <SeriesPoint
            key={cell.key}
            {...shared}
            label={cell.label}
            className={`relative ${shared.className}`}
          />
        ) : (
          <span key={cell.key} {...shared} />
        );
      })}
    </div>
  );
}

/** `count` is how many periods are in this state, where the key doubles as a tally. */
export type StateLegendItem = {
  key: string;
  tone: ChartCellTone;
  label: string;
  count?: number;
};

export function StateLegend({
  items,
  label,
  testId,
  className,
  itemTestId,
}: {
  items: StateLegendItem[];
  label: string;
  testId?: string;
  className?: string;
  itemTestId?: string;
}) {
  return (
    <ul
      data-testid={testId}
      aria-label={label}
      className={`flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 ${className ?? ""}`}
    >
      {items.map((item) => (
        <li
          key={item.key}
          data-testid={itemTestId}
          data-state={item.key}
          className="flex items-center gap-1.5"
        >
          <span
            aria-hidden="true"
            className={stateCellClass("dot", item.tone)}
          />
          {item.label}
          {item.count != null && (
            <span className="ml-auto tabular-nums">{item.count}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
