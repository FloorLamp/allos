import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";

// ONE PERIOD STRIP, ONE KEY (#4543). "N consecutive periods painted by state, with a
// key" had five renderers and four hand-rolled legends between them — four cell
// sizes, three radii, and one palette escape. This module owns the GEOMETRY, one
// class per size token; `lib/chart-colors` owns the COLOR, so a `tone` is a class
// from there and from nowhere else — the half lib/__tests__/chart-colors-scan.test.ts
// guards. A strip is a labelled group: it carries the summary, and any cell with its
// own name keeps it, so a strip whose cells name themselves and one named only as a
// whole read the same way.

export type StateCellSize = "dot" | "cell" | "tile";

const SIZE_CLASS: Record<StateCellSize, string> = {
  // A key's swatch; a period in a strip; a period carrying its own text (a day
  // number, a taken/intended count), square by ratio so a tile grid can narrow.
  dot: "h-2.5 w-2.5 rounded-xs",
  cell: "h-4 w-4 rounded-xs",
  tile: "flex aspect-square items-center justify-center rounded-md text-xs font-semibold tabular-nums",
};

/** The one geometry for a state-painted square, at the declared size. */
export function stateCellClass(size: StateCellSize, tone: string): string {
  return `${SIZE_CLASS[size]} ${tone}`;
}

// `tone` is a class from lib/chart-colors; `state` becomes `data-state`; `label` is
// the cell's own name where the group does not name every period; `className` is the
// responsive visibility a caller owns (a strip that unrolls at a breakpoint).
export type StateCellSpec = {
  key: string;
  tone: string;
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
          "aria-label": cell.label,
          className: `${stateCellClass("cell", cell.tone)} ${cell.className ?? ""}`,
        };
        return cell.href ? (
          <Link
            key={cell.key}
            {...shared}
            href={cell.href}
            className={`${shared.className} ring-brand-400 hover:ring-2 focus:outline-hidden focus:ring-2`}
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
  tone: string;
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
