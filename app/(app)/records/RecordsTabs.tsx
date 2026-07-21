"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { RecordsGroup } from "./nav";

// The two-level Health-record tab strip (#1079). Primary strip = the four group
// tabs (SettingsTabs #928 underline style); secondary strip = the active group's
// panes as pill sub-tabs, rendered only when the group has >1 pane (Problems is a
// single stacked pane → no secondary strip). Active by `usePathname()`: a group
// lights when the path is under its basePath; a pane lights on exact href match.
// The group set (incl. the data-gated Specialty panes) is computed server-side and
// passed in, so the strip and the routes agree on what's reachable.
export default function RecordsTabs({ groups }: { groups: RecordsGroup[] }) {
  const pathname = usePathname();
  const activeGroup =
    groups.find((g) => pathname.startsWith(g.basePath)) ?? groups[0];
  return (
    <div className="mb-6">
      {/* Primary: group tabs. */}
      <div
        data-testid="records-group-tabs"
        className="flex gap-1 overflow-x-auto border-b border-black/10 dark:border-white/10"
      >
        {groups.map((g) => {
          const active = g.id === activeGroup.id;
          return (
            <Link
              key={g.id}
              href={g.href}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
                active
                  ? "border-brand-600 text-brand-700 dark:text-brand-400"
                  : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {g.label}
            </Link>
          );
        })}
      </div>

      {/* Secondary: the active group's panes (only when >1). Pill sub-tabs. */}
      {activeGroup.panes.length > 1 ? (
        <div
          data-testid="records-sub-tabs"
          className="mt-3 flex flex-wrap gap-2"
        >
          {activeGroup.panes.map((p) => {
            const active = pathname === p.href;
            return (
              <Link
                key={p.id}
                href={p.href}
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
      ) : null}
    </div>
  );
}
