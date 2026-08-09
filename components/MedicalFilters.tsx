"use client";

import { useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { IconChevronDown } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";
import RecordSearch from "./RecordSearch";
import RangeFilterSelect from "./RangeFilterSelect";
import CategoryFilterSelect from "./CategoryFilterSelect";
import PanelFilterSelect from "./PanelFilterSelect";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import { activeFacetCount, filterTriggerLabel } from "@/lib/record-facets";
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
//
// COLLAPSED BELOW `sm` (#2316). Five controls plus the table's sort select wrap into
// roughly a screen-height of chrome at phone width, every visit, whether or not
// anything is filtered — so the first reading starts below the fold on a page whose
// whole job is showing readings. Below `sm` the SEARCH field stays out (it is the
// fastest path to a named analyte, and a filter you can see is not a filter that
// hides); the facets and the sort control sit behind one **Filters** trigger.
//
// ONE DISCLOSURE, NOT A SECOND TREE. There is exactly one authored set of controls,
// in one place in the DOM. Below `sm` the group is `hidden` while closed; at `sm`
// and up `sm:contents` forces it open AND dissolves the wrapper, so the controls
// land in the parent flex exactly as they did before — the desktop layout is
// untouched and no second copy can drift out of sync. Same discipline as
// `.table-cards tr.table-section-row` in app/globals.css: one element, and CSS
// decides what it is at each width.
export default function MedicalFilters({
  category,
  panel,
  panels,
  range,
  q,
  current,
  action,
  sortControl,
}: {
  category?: string;
  panel?: PanelId;
  // The panel options to offer, resolved server-side (#1581 section D) — the
  // taxonomy minus the panels this surface's category scope can never surface.
  panels: readonly PanelId[];
  range?: string;
  q?: string;
  current?: boolean;
  action?: ReactNode;
  // The table's card-mode sort select (#2316), rendered inside the disclosure so a
  // phone has ONE strip of list controls instead of two. Optional: a surface with
  // nothing to order (the empty state) passes none.
  sortControl?: ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // What the trigger has to disclose, and whether it may start closed. A view that
  // arrives filtered opens itself, so a filtered list never LOOKS unfiltered.
  const activeCount = activeFacetCount({ category, panel, range, current });
  const [open, setOpen] = useState(activeCount > 0);
  // A filter can also arrive while this component stays mounted (a facet link, the
  // sessionStorage range restore). Re-open on the way UP only: closing it under a
  // reader who just cleared a facet would yank the control out from under them.
  const [seenCount, setSeenCount] = useState(activeCount);
  if (seenCount !== activeCount) {
    setSeenCount(activeCount);
    if (activeCount > 0) setOpen(true);
  }

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
    <div
      className="mb-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-start sm:justify-between"
      data-testid="medical-filters"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 sm:gap-4">
        <RecordSearch q={q} />

        {/* Phone-only trigger: at `sm` and up the group is always open, so the
            control that opens it has nothing left to do. */}
        <button
          type="button"
          data-testid="medical-filters-toggle"
          aria-expanded={open}
          aria-controls="medical-filters-facets"
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost btn-sm sm:hidden"
        >
          {filterTriggerLabel(activeCount)}
          <IconChevronDown
            className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
            stroke={2}
            aria-hidden="true"
          />
        </button>

        <div
          id="medical-filters-facets"
          data-testid="medical-filters-facets"
          data-open={open ? "true" : "false"}
          className={`${
            open
              ? "flex w-full basis-full flex-wrap items-center gap-x-4 gap-y-2"
              : "hidden"
          } sm:contents`}
        >
          {/* Biomarkers browser: never offer 'prescription' — meds aren't listed
            here (see getMedicalRecords excludeCategories on the page). */}
          <CategoryFilterSelect
            value={category}
            categories={BIOMARKER_CATEGORIES}
          />

          <PanelFilterSelect value={panel} panels={panels} />

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

          {sortControl}
        </div>
      </div>
      {action ? (
        <div className="shrink-0 self-end sm:self-start">{action}</div>
      ) : null}
    </div>
  );
}
