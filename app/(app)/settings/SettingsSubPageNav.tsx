"use client";

import { usePathname } from "next/navigation";
import type { SettingsGroupPage } from "@/lib/settings-groups";
import Chip from "@/components/Chip";

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
      className="section-seam mb-6 flex flex-wrap gap-2"
      data-testid="settings-subpage-nav"
      aria-label="Group sections"
    >
      {pages.map((p) => {
        const active = pathname === p.href;
        return (
          // Selected-state registry keep (#2730): these are destinations,
          // so they stay links in the registered chip-nav role, not segments.
          <Chip
            key={p.href}
            role="nav"
            href={p.href}
            current={active}
            // Settings' sub-pages are destinations, so this strip is the chip
            // primitive's nav role (#3475) — one shape and one selected shade
            // with the Records pane strip, instead of a fourth pairing of
            // accent-soft and slate.
          >
            {p.label}
          </Chip>
        );
      })}
    </div>
  );
}
