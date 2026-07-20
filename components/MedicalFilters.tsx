"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { IconX } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";
import RecordSearch from "./RecordSearch";
import RangeFilterSelect from "./RangeFilterSelect";
import CategoryFilterSelect from "./CategoryFilterSelect";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";

// Filter bar for the medical records table: a category dropdown, the All/
// Non-optimal/Out-of-range "show" filter, and (when set) a clearable panel chip.
// Each control navigates via query params, preserving the others (including the
// active sort, which lives in `sort`/`dir`).
export default function MedicalFilters({
  category,
  panel,
  range,
  q,
  current,
}: {
  category?: string;
  panel?: string;
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
    // The browser lives in the #biomarkers section of /results (#1042 phase 5);
    // keep the anchor so a filter change lands back on the section.
    return s ? `/results?${s}#biomarkers` : "/results#biomarkers";
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

      {panel ? (
        <Link
          href={qs({ panel: undefined })}
          className="badge inline-flex items-center gap-1 bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
          title="Clear panel filter"
        >
          Panel: {panel}
          <IconX className="h-4 w-4" />
        </Link>
      ) : null}
    </div>
  );
}
