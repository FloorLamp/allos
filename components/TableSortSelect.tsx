"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  parseSortChoiceValue,
  parseSortDir,
  sortChoiceOptions,
  sortChoiceValue,
  type SortChoice,
} from "@/lib/table-sort";
import { currentPathHref } from "@/lib/hrefs";

// The card-mode sort control (issue #1426).
//
// A `.table-cards` table hides its `thead` below `sm` — the row is a card there, so
// the SortableHeader links that carry sorting are unreachable. This select stands in
// for the whole header strip on a phone: ONE control encoding both axes
// (`column:dir`), writing the SAME `?sort=`/`?dir=` params SortableHeader writes and
// preserving every other param. So there is one sort model, one server-side ordering,
// and two affordances over it — not a second sorting implementation.
//
// Rendered `sm:hidden` by default: above `sm` the real headers are back.
export default function TableSortSelect({
  choices,
  defaultSort,
  defaultDir = "asc",
  label = "Sort",
  className = "sm:hidden",
}: {
  choices: readonly SortChoice[];
  // Column that's sorted when no `sort` param is present — mirrors SortableHeader's
  // prop of the same name, so the select opens showing the active sort.
  defaultSort: string;
  defaultDir?: "asc" | "desc";
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const active = parseSortChoiceValue(
    sortChoiceValue(
      searchParams.get("sort") ?? defaultSort,
      parseSortDir(searchParams.get("dir") ?? undefined, defaultDir)
    ),
    choices,
    { column: defaultSort, dir: defaultDir }
  );

  return (
    <label className={`flex items-center gap-2 text-xs ${className}`}>
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <select
        data-testid="table-sort-select"
        className="input h-9 w-auto flex-1 py-1 text-sm"
        value={sortChoiceValue(active.column, active.dir)}
        onChange={(e) => {
          const next = parseSortChoiceValue(e.target.value, choices, active);
          const sp = new URLSearchParams(searchParams.toString());
          sp.set("sort", next.column);
          sp.set("dir", next.dir);
          router.push(currentPathHref(`${pathname}?${sp.toString()}`));
        }}
      >
        {sortChoiceOptions(choices).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
