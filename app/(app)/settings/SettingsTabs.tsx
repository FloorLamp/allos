"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The tabs follow the three settings tiers: Preferences (login), Profile
// (active profile), and Server (global) — plus Family, AI logs, and Audit.
// Server, Family, AI logs, and Audit are admin-only (global config,
// login/profile management, extraction content mixed across profiles, and the
// cross-profile access trail), so they're appended only when isAdmin. The order
// interleaves them where they belong: Server sits after the per-person tabs,
// before Family.
const BASE_TABS = [
  { href: "/settings", label: "Preferences" },
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/equipment", label: "Equipment" },
];
const ADMIN_TABS = [
  { href: "/settings/family", label: "Family" },
  { href: "/settings/server", label: "Server" },
  { href: "/settings/logs", label: "AI logs" },
  { href: "/settings/audit", label: "Audit" },
];

export default function SettingsTabs({
  isAdmin = false,
  // Hide the Equipment tab for age-restricted profiles (see lib/age-gate.ts).
  hideEquipment = false,
}: {
  isAdmin?: boolean;
  hideEquipment?: boolean;
}) {
  const pathname = usePathname();
  const base = hideEquipment
    ? BASE_TABS.filter((t) => t.href !== "/settings/equipment")
    : BASE_TABS;
  const tabs = isAdmin ? [...base, ...ADMIN_TABS] : base;
  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b border-black/10 dark:border-white/10">
      {tabs.map((t) => {
        const active = pathname === t.href;
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
