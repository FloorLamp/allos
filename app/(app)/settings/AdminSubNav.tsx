"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AppRoute } from "@/lib/hrefs";

// Second-level nav for the admin "Admin" tab (#928): AI logs | Errors | Audit are
// diagnostic VIEWERS, not settings, so they collapse behind one strip entry with
// this sub-nav. Each page keeps its own requireAdmin() gate — this is presentation
// only. Rendered by each of the three viewer pages right under <SettingsTabs>.
const ADMIN_PAGES: { href: AppRoute; label: string }[] = [
  { href: "/settings/logs", label: "AI logs" },
  { href: "/settings/errors", label: "Errors" },
  { href: "/settings/audit", label: "Audit" },
];

export default function AdminSubNav() {
  const pathname = usePathname();
  return (
    <div
      className="mb-6 flex flex-wrap gap-2"
      data-testid="admin-subnav"
      aria-label="Admin sections"
    >
      {ADMIN_PAGES.map((p) => {
        const active = pathname === p.href;
        return (
          <Link
            key={p.href}
            href={p.href}
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
