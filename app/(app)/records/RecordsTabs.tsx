"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { RecordsGroup } from "./nav";

// The second level of the Health-record tab hierarchy (#1079). The four group tabs
// now use the shared tab-first page shell; this strip sits directly below those
// tabs in normal document flow, then scrolls away with its pane instead of becoming
// a detached second sticky layer. Active by `usePathname()`: a group is selected
// when the path is under its basePath; a pane lights on exact href match. The group
// set (including the data-gated Specialty panes) is computed server-side and passed
// in, so the strip and the routes agree on what's reachable.
export default function RecordsTabs({ groups }: { groups: RecordsGroup[] }) {
  const pathname = usePathname();
  const activeGroup =
    groups.find((g) => pathname.startsWith(g.basePath)) ?? groups[0];

  if (activeGroup.panes.length <= 1) return null;

  return (
    <div className="-mx-4 mb-6 px-4 pb-3 md:mx-0 md:px-0">
      <div
        data-testid="records-sub-tabs"
        className="flex flex-nowrap gap-2 overflow-x-auto pb-1"
      >
        {activeGroup.panes.map((p) => {
          const active = pathname === p.href;
          return (
            <Link
              key={p.id}
              href={p.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-sm font-medium ${
                active
                  ? "border-brand-600 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-300"
                  : "border-black/10 bg-white/80 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-300 dark:hover:bg-ink-750"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
