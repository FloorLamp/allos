import type { ComponentPropsWithoutRef } from "react";

// THE CHART CARRIES ITS OWN DATA ACCESS (#4760, owner ruling 2026-09-02).
//
// `VisualizationDetails` was the #3375-era answer to hover-only chart data: a
// labelled fold beside every custom strip and diagram, restating each mark as a line
// of text — the loudest element on every surface it touched, for a fallback. The
// FUNCTION stays: every datum a chart draws is reachable without hover, by touch,
// keyboard and AT. It moves INTO the chart. `SeriesSummary` is the whole series in
// words for a reader who never sees the picture; `SeriesPoint` is the mark itself as
// a focusable target that names its value and shows it while focused or hovered
// (app/globals.css `series-point`). No fold, no second surface beside the picture.

/** The complete series, visually hidden — the same strings the marks carry. */
export function SeriesSummary({
  label,
  items,
  "data-testid": testId,
}: {
  label: string;
  items: readonly string[];
  "data-testid"?: string;
}) {
  const details = items.filter(Boolean);
  if (details.length === 0) return null;
  return (
    <ul className="sr-only" aria-label={label} data-testid={testId}>
      {details.map((detail, index) => (
        <li key={`${index}:${detail}`}>{detail}</li>
      ))}
    </ul>
  );
}

/**
 * A mark that is its own door to its value. `role` defaults to `img`; a mark that
 * already has list semantics passes its own. Positioning is the caller's (see the
 * utility): an absolute mark needs nothing, a static one adds `relative`.
 */
export function SeriesPoint({
  label,
  className = "",
  ...rest
}: { label: string } & Omit<ComponentPropsWithoutRef<"span">, "aria-label">) {
  return (
    <span
      role="img"
      tabIndex={0}
      {...rest}
      aria-label={label}
      className={`series-point ${className}`}
    />
  );
}
