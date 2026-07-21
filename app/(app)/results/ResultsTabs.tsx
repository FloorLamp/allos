"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AppRoute } from "@/lib/hrefs";

// The Results tab strip (#1079): the three read-heavy result stores — Biomarkers,
// Imaging, Genomics — as route-per-tab (`/results/<tab>`) instead of the #1042
// stacked-section page. Underline style + active-by-`usePathname()`, the
// SettingsTabs (#928) pattern. Route-per-tab (not `?tab=`) keeps the Biomarkers
// searchparams namespace (`?q/?category/?panel/?range/?sort/?dir/?current/?p/
// ?new/?name`) clean and every link #285-typed with no widening helper.
type Tab = { href: AppRoute; label: string };

const TABS: Tab[] = [
  { href: "/results/biomarkers", label: "Biomarkers" },
  { href: "/results/imaging", label: "Imaging" },
  { href: "/results/genomics", label: "Genomics" },
];

export default function ResultsTabs() {
  const pathname = usePathname();
  return (
    <div
      data-testid="results-tabs"
      className="mb-6 flex gap-1 overflow-x-auto border-b border-black/10 dark:border-white/10"
    >
      {TABS.map((t) => {
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
