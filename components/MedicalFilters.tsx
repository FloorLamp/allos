"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { AppRoute } from "@/lib/hrefs";
import RecordSearch from "./RecordSearch";
import RangeFilterSelect from "./RangeFilterSelect";
import CategoryFilterSelect from "./CategoryFilterSelect";
import PanelFilterSelect from "./PanelFilterSelect";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import type { PanelId } from "@/lib/biomarker-panels";

// Filter bar for the medical records table: a category dropdown, the clinical
// PANEL dropdown (#1502), and the All/Non-optimal/Out-of-range "show" filter.
// Each control navigates via query params, preserving the others (including the
// active sort, which lives in `sort`/`dir`).
//
// The panel control was a clearable CHIP that only ever appeared after clicking a
// Panel cell — the right affordance when the value was an unpredictable free-text
// vendor string with no enumerable set. With a closed taxonomy it becomes a
// first-class dropdown beside Category: the facet is now discoverable ("show my
// Lipids") instead of reachable only by finding a row that happens to carry it.
export default function MedicalFilters({
  category,
  panel,
  range,
  q,
  current,
}: {
  category?: string;
  panel?: PanelId;
  range?: string;
  q?: string;
  current?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Merge overrides onto the current query string so unrelated params (e.g.
  // sort/dir) survive; an explicit `undefined` clears that key.
  function qs(overrides: Record<string, string | undefined>): AppRoute {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(overrides)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const s = sp.toString();
    // The browser lives on the /results/biomarkers tab (#1079); a filter change
    // rewrites its searchparams and lands back on the same tab.
    return s ? `/results/biomarkers?${s}` : "/results/biomarkers";
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-4">
      <RecordSearch q={q} />

      {/* Biomarkers browser: never offer 'prescription' — meds aren't listed
          here (see getMedicalRecords excludeCategories on the page). */}
      <CategoryFilterSelect
        value={category}
        categories={BIOMARKER_CATEGORIES}
      />

      <PanelFilterSelect value={panel} />

      <RangeFilterSelect value={range} />

      <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          className="h-4 w-4 accent-brand-600"
          checked={!!current}
          onChange={(e) =>
            router.push(qs({ current: e.target.checked ? "1" : undefined }))
          }
        />
        <span className="font-medium">Current values only</span>
      </label>
    </div>
  );
}
