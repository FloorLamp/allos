import Link from "next/link";
import { Children, isValidElement, type ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

type TestId = { "data-testid"?: string };

interface DelegatedCardProps extends TestId {
  children: ReactNode;
  /** A labelled card is a section; an unlabelled repeated tile stays a div. */
  labelledBy?: string;
}

type HeaderProps = TestId & {
  children: ReactNode;
} & (
    | {
        /** A destination header is the card's full primary target. */
        href: AppRoute;
        subdued?: never;
      }
    | {
        href?: never;
        /** Summary headers use the one subdued, divided treatment. */
        subdued?: boolean;
      }
  );

interface CellProps extends TestId {
  children: ReactNode;
  density?: "standard" | "compact";
}

interface ActionProps extends TestId {
  children: ReactNode;
}

interface GridProps extends TestId {
  children: ReactNode;
  /** Restack the summary beside a wide desktop chart. */
  desktopStack?: boolean;
}

interface GridPlacement {
  index: number;
  columns: number;
  desktopStack: boolean;
}

const plainHeader = "card-gutter-standard pt-2.5 pb-1 sm:pt-4 sm:pb-3";
const subduedHeader =
  "card-gutter-standard border-b border-black/10 bg-slate-50/55 py-3.5 dark:border-white/10 dark:bg-ink-900/35";
const destinationHeader =
  "card-gutter-standard group flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-0.5 py-2.5 transition-colors hover:bg-brand-50/80 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-brand-950/40";

function Header({
  children,
  href,
  subdued = false,
  "data-testid": testId,
}: HeaderProps) {
  if (href !== undefined && !href.startsWith("/")) {
    throw new Error("DelegatedCard.Header requires an internal app route");
  }
  if (href !== undefined && subdued) {
    throw new Error("DelegatedCard.Header cannot be subdued and a destination");
  }
  if (href !== undefined) {
    return (
      <Link
        href={href}
        className={destinationHeader}
        data-delegated-card-part="header"
        data-testid={testId}
      >
        {children}
      </Link>
    );
  }

  return (
    <div
      className={subdued ? subduedHeader : plainHeader}
      data-delegated-card-part="header"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function gridColumns(count: number, desktopStack: boolean): string {
  const responsive = [
    "sm:grid-cols-1",
    "sm:grid-cols-2",
    "sm:grid-cols-3",
    "sm:grid-cols-2",
  ][count - 1];
  return desktopStack ? `xl:grid-cols-1 ${responsive}` : responsive;
}

function gridBorders({ index, columns, desktopStack }: GridPlacement): string {
  if (index === 0) return "";
  const startsRow = index % columns === 0;
  if (startsRow) return "border-black/10 dark:border-white/10 border-t";
  if (index < columns) {
    return desktopStack
      ? "border-black/10 dark:border-white/10 border-t sm:border-l sm:border-t-0 xl:border-l-0 xl:border-t"
      : "border-black/10 dark:border-white/10 border-t sm:border-l sm:border-t-0";
  }
  return desktopStack
    ? "border-black/10 dark:border-white/10 border-t sm:border-l xl:border-l-0"
    : "border-black/10 dark:border-white/10 border-t sm:border-l";
}

function cellGutter(density: NonNullable<CellProps["density"]>): string {
  return density === "compact"
    ? "card-gutter-compact pb-2 sm:pb-5"
    : "card-gutter-standard py-4";
}

function Cell({
  children,
  density = "standard",
  "data-testid": testId,
}: CellProps) {
  return (
    <div
      className={cellGutter(density)}
      data-delegated-card-gutter={density}
      data-delegated-card-part="cell"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function GridCell({
  children,
  density = "standard",
  placement,
  "data-testid": testId,
}: CellProps & { placement: GridPlacement }) {
  return (
    <article
      className={`min-w-0 ${gridBorders(placement)}`.trim()}
      data-delegated-card-part="cell"
      data-testid={testId}
    >
      <div className={cellGutter(density)} data-delegated-card-gutter={density}>
        {children}
      </div>
    </article>
  );
}

function Action({ children, "data-testid": testId }: ActionProps) {
  return (
    <div
      className="card-gutter-action flex shrink-0 items-center"
      data-delegated-card-part="action"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function Grid({
  children,
  desktopStack = false,
  "data-testid": testId,
}: GridProps) {
  const cells = Children.toArray(children);
  if (cells.length < 1 || cells.length > 4) {
    throw new Error("DelegatedCard.Grid requires one to four Cell children");
  }
  const columns = cells.length === 4 ? 2 : cells.length;

  return (
    <div
      className={`grid grid-cols-1 ${gridColumns(cells.length, desktopStack)}`}
      data-delegated-card-part="grid"
      data-testid={testId}
    >
      {cells.map((child, index) => {
        if (!isValidElement<CellProps>(child) || child.type !== Cell) {
          throw new Error(
            "DelegatedCard.Grid accepts direct Cell children only"
          );
        }
        if (child.props.density === "compact") {
          throw new Error(
            "DelegatedCard.Grid cells use the standard gutter only"
          );
        }
        return (
          <GridCell
            key={child.key ?? index}
            data-testid={child.props["data-testid"]}
            density={child.props.density}
            placement={{ index, columns, desktopStack }}
          >
            {child.props.children}
          </GridCell>
        );
      })}
    </div>
  );
}

const directParts = new Set<unknown>([Header, Cell, Action, Grid]);

function Root({
  children,
  labelledBy,
  "data-testid": testId,
}: DelegatedCardProps) {
  const parts = Children.toArray(children);
  for (const child of parts) {
    if (!isValidElement(child) || !directParts.has(child.type)) {
      throw new Error(
        "DelegatedCard accepts direct Header, Cell, Action, or Grid children only"
      );
    }
  }
  const className = `card card-delegated${
    parts.some((child) => isValidElement(child) && child.type === Action)
      ? " flex items-stretch"
      : ""
  }`;
  const content = parts;

  if (labelledBy) {
    return (
      <section
        aria-labelledby={labelledBy}
        className={className}
        data-delegated-card=""
        data-testid={testId}
      >
        {content}
      </section>
    );
  }

  return (
    <div className={className} data-delegated-card="" data-testid={testId}>
      {content}
    </div>
  );
}

const DelegatedCard = Object.assign(Root, { Header, Cell, Action, Grid });

export default DelegatedCard;
