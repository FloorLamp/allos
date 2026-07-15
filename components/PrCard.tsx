import type { ReactNode } from "react";

export interface PrItem {
  name: string;
  value: ReactNode;
  meta: ReactNode;
}

// A "Recent PRs" card: a titled 2-up grid of `name → value · meta` rows. Shared
// by the strength and cardio Training sections so the row layout stays in sync.
export default function PrCard({
  title,
  items,
}: {
  title: string;
  items: PrItem[];
}) {
  return (
    <div className="card">
      <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((it, i) => (
          <li
            key={i}
            className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-ink-900"
          >
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {it.name}
            </span>
            <span className="flex flex-col items-end text-right">
              <span className="tabular-nums font-semibold text-slate-800 dark:text-slate-100">
                {it.value}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {it.meta}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
