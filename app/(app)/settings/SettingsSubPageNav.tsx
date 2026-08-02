"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SettingsGroupPage } from "@/lib/settings-groups";

// The ONE sub-page strip inside a settings group that has more than one page (#1462).
// Logs & audit fronts its three diagnostic viewers, Account & security its API-token
// registry (#1734), and Server its AI configuration (#1870). It replaces the old
// standalone AdminSubNav pill row: the entries come from the group registry, and it
// renders on EVERY viewport (the desktop group nav deliberately does not repeat
// them), so a phone can reach every sub-page.
export default function SettingsSubPageNav({
  pages,
}: {
  pages: readonly SettingsGroupPage[];
}) {
  const pathname = usePathname();
  return (
    <div
      className="mb-6 flex flex-wrap gap-2"
      data-testid="settings-subpage-nav"
      aria-label="Group sections"
    >
      {pages.map((p) => {
        const active = pathname === p.href;
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              active
                ? "bg-brand-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-750 dark:text-slate-300 dark:hover:bg-ink-700"
            }`}
          >
            {p.label}
          </Link>
        );
      })}
    </div>
  );
}
