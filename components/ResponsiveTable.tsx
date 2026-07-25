import type { ReactNode } from "react";
import { cardCellAttrs, type CardSlot } from "@/lib/card-row";

// The shared responsive-table primitive (issue #1426).
//
// PROBLEM. A dozen surfaces render a wide `<table>` inside an `overflow-x-auto`
// wrapper. On a phone that turns the data into a sideways swipe: the columns that
// matter scroll out of sight, rows are hard to tap, and (before #794's wrap-and-
// scroll rule) some of it clipped outright.
//
// APPROACH. Below `sm` the table stops being a table and becomes a stack of cards
// — WITHOUT a second content tree. This is the responsive-surface rule (AGENTS.md:
// "never author into a single branch of a `hidden md:*` pair") taken to its
// conclusion: there is exactly ONE `<table>` in the DOM, exactly one set of cells,
// and the card layout is pure CSS over that same markup (the `.table-cards` block
// in app/globals.css re-lays `tr`/`td` as a flex card and hides `thead`). A
// `hidden md:table-cell` twin pair can't drift here because there is no twin: a
// cell is authored once and rendered once.
//
// A cell declares its card placement where it is authored, via `Td`'s `slot`:
// title / value / meta / actions / full (see `CardSlot` in lib/card-row.ts). A cell
// with no slot is desktop-only detail and simply doesn't appear on the card; an
// `empty` meta/value cell drops out too, so a card never shows a line of
// em-dashes that distinguish nothing (#531–#534 — label by what DIFFERS).
//
// Because `thead` is hidden below `sm`, a `meta` cell carries its own `label`,
// rendered `sm:hidden` inside the cell. That keeps the column's meaning available
// to sighted and assistive users in card mode, where the `<th>` is gone.
//
// SORTING. Header-click sorting lives in the (hidden) `thead`, so a sortable table
// pairs this with `components/TableSortSelect.tsx` — a compact `sm:hidden` select
// over the SAME `?sort=`/`?dir=` params `SortableHeader` writes.
//
// ADOPTION is incremental (the ProfileScope posture): the two highest-traffic
// tables adopt it here; the remaining `overflow-x-auto` tables convert as they're
// next touched. Nothing renders differently at `sm` and up.
//
// No hooks and no "use client" — this is presentational, so both server components
// (AnalyzeSection) and client components (BiomarkersTable) can render it.
export function ResponsiveTable({
  className = "",
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <table className={`table-cards ${className}`} {...rest}>
      {children}
    </table>
  );
}

// A table cell that also knows what it becomes on a card.
//
// `label` is shown ONLY in card mode (`sm:hidden`), where the column header is
// hidden — it is the same string the `<th>` carries, passed once. It applies to
// `meta` AND `value` cells, and is OPT-IN per cell: a self-describing headline
// (a biomarker's "66 mg/dL" with its flag) passes none, while a bare number that
// means nothing without its column ("3" — sets? reps? sessions?) passes one.
// `empty` is the caller's emptiness verdict (no panel, no notes, a "—"
// placeholder): the cell still renders in the table so the column grid stays
// aligned, but claims no card slot, so the card omits it.
export function Td({
  slot,
  label,
  empty,
  className = "",
  colSpan,
  children,
  ...rest
}: {
  slot?: CardSlot;
  label?: string;
  empty?: boolean;
  className?: string;
  colSpan?: number;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  const attrs = cardCellAttrs({ slot, empty });
  const card = attrs["data-card"];
  const showLabel = !!label && (card === "meta" || card === "value");
  return (
    <td className={`td ${className}`} colSpan={colSpan} {...attrs} {...rest}>
      {showLabel ? (
        <span className="card-cell-label sm:hidden">{label}</span>
      ) : null}
      {children}
    </td>
  );
}
