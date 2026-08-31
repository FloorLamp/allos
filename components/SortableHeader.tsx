"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { IconCaretUpFilled, IconCaretDownFilled } from "@tabler/icons-react";
import { nextSortState, parseSortDir } from "@/lib/table-sort";
import { currentPathHref } from "@/lib/hrefs";

// The ONE sortable-header presentation (issue #1491, drift D4): label + caret,
// with the active column tinted brand and the inactive caret ghosted. Both
// sorting mechanisms render through it — the URL-param `SortableHeader` below
// and `RecordTable`'s client-state header — so there is a single visual
// vocabulary for "this column sorts", not two hand-drawn caret sets.
export function SortHeaderLabel({
  label,
  active,
  dir,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
}) {
  return (
    <>
      {label}
      <span
        className={
          active
            ? "text-brand-700 dark:text-brand-400"
            : "text-slate-300 dark:text-slate-600"
        }
      >
        {active && dir === "desc" ? (
          <IconCaretDownFilled className="h-3.5 w-3.5" />
        ) : (
          <IconCaretUpFilled className="h-3.5 w-3.5" />
        )}
      </span>
    </>
  );
}

// A sticky table header whose label is a link that toggles sorting on `column`.
// Clicking cycles asc → desc (and switches column when a different one is
// active), encoding the choice in the `sort`/`dir` query params while
// preserving any other params. Server components read those params back to
// order the rows.
export default function SortableHeader({
  column,
  label,
  defaultSort,
  defaultDir = "asc",
  className = "",
  children,
}: {
  column: string;
  label: string;
  // Column that's sorted when no `sort` param is present, so its header still
  // shows the active arrow on a fresh load.
  defaultSort?: string;
  // Direction the first click on this column applies (before toggling). Date-like
  // columns read better newest-first, so pass "desc" for them.
  defaultDir?: "asc" | "desc";
  // Appended to the base header classes (e.g. responsive visibility) — callers
  // never need to restate the sticky/th defaults.
  className?: string;
  // Rendered inside the `<th>` AFTER the sort link. A column-level explainer lives
  // here (#3970 rule 1: a constant explainer states itself once, at the structural
  // level that owns it) and it cannot live inside the link, which is an `<a>`.
  // Nothing is rendered when a caller passes none, so a header without one is
  // byte-identical to what it was.
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeColumn = searchParams.get("sort") ?? defaultSort ?? "";
  const active = activeColumn === column;
  const dir = parseSortDir(searchParams.get("dir") ?? undefined);
  // Toggle when already sorting this column; otherwise start from its default —
  // the shared rule the other sortable tables use (lib/table-sort).
  const next = nextSortState(activeColumn, dir, column, defaultDir);

  const sp = new URLSearchParams(searchParams.toString());
  sp.set("sort", next.column);
  sp.set("dir", next.dir);

  return (
    <th className={`th sticky top-0 z-10 bg-surface ${className}`}>
      <Link
        href={currentPathHref(`${pathname}?${sp.toString()}`)}
        className="inline-flex items-center gap-1 hover:text-brand-700 dark:hover:text-brand-400"
        aria-sort={
          active ? (dir === "asc" ? "ascending" : "descending") : "none"
        }
      >
        <SortHeaderLabel label={label} active={active} dir={dir} />
      </Link>
      {children}
    </th>
  );
}
