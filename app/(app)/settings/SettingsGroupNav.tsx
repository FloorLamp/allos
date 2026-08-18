"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  isSettingsGroupActive,
  type SettingsGroup,
} from "@/lib/settings-groups";

// The persistent group nav shown beside a settings group page (#1462). It is a
// SECOND rendering of the same registry the /settings index renders — never a
// hand-kept copy of it — so a new group appears in both or neither
// (lib/__tests__/settings-groups.test.ts pins that both renderings read the
// registry).
//
// Viewport story: this column is desktop-only, and deliberately carries no entry
// that isn't already on the /settings index — on a phone the index IS the nav (one
// tap away via the breadcrumb above every group page), which is what made the admin
// groups structurally discoverable on mobile and retired #1451.C's clipped tab
// strip. So this is not a `hidden md:*` content fork: nothing is authored here that
// a phone can't reach. Group SUB-pages (Logs & audit) are likewise not repeated
// here — they render in one strip inside the group page on every viewport.
export default function SettingsGroupNav({
  groups,
}: {
  groups: SettingsGroup[];
}) {
  const pathname = usePathname();
  return (
    <nav
      className="hidden lg:block"
      aria-label="Settings groups"
      data-testid="settings-group-nav"
    >
      <ul className="space-y-0.5">
        {groups.map((g) => {
          const active = isSettingsGroupActive(g, pathname);
          return (
            <li key={g.id}>
              <Link
                href={g.route}
                aria-current={active ? "page" : undefined}
                data-testid={`settings-nav-${g.id}`}
                className={`block rounded-lg px-3 py-1.5 text-sm font-medium ${
                  active
                    ? "bg-(--accent-soft) text-brand-800 dark:text-brand-400"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
                }`}
              >
                {g.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
