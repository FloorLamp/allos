"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AppRoute } from "@/lib/hrefs";

// The settings tab strip (#928). Every top-level entry is CONFIGURATION except the
// admin-only "Admin" drawer, which is explicitly the observability surface:
//
//   Preferences | Profile | Notifications          (everyone)
//   + Family | Server | Admin                       (admins only)
//
// - Preferences (login tier): units, password, 2FA, sessions.
// - Profile (profile tier): identity/localization, training zones, cadence.
// - Notifications (composes all three tiers): the one place to manage where
//   reminders arrive, plus the kind × channel matrix.
// - Family / Server: admin config (login/profile management; instance-wide config).
// - Admin: one strip entry, a second-level nav for AI logs | Errors | Audit. It's
//   active for ANY of those routes; each page still calls requireAdmin().
//
// Server, Family, and Admin are admin-only (global config, login/profile management,
// and the diagnostic viewers whose content is PHI-adjacent), so they're appended only
// when isAdmin. Members never see them, and each admin page re-gates server-side.
type Tab = {
  href: AppRoute;
  label: string;
  // Extra pathnames that should light this tab (beyond an exact href match) — used
  // by the Admin entry, which fronts three sub-pages.
  alsoActiveOn?: readonly AppRoute[];
};

const BASE_TABS: Tab[] = [
  { href: "/settings", label: "Preferences" },
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/notifications", label: "Notifications" },
];
const ADMIN_TABS: Tab[] = [
  { href: "/settings/family", label: "Family" },
  { href: "/settings/server", label: "Server" },
  {
    href: "/settings/logs",
    label: "Admin",
    alsoActiveOn: ["/settings/errors", "/settings/audit"],
  },
];

export default function SettingsTabs({
  isAdmin = false,
}: {
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const tabs = isAdmin ? [...BASE_TABS, ...ADMIN_TABS] : BASE_TABS;
  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b border-black/10 dark:border-white/10">
      {tabs.map((t) => {
        const active =
          pathname === t.href ||
          (t.alsoActiveOn?.some((p) => pathname === p) ?? false);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              active
                ? "border-brand-600 text-brand-700 dark:text-brand-400"
                : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
