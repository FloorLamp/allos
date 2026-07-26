"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { currentPathHref } from "@/lib/hrefs";
import {
  OTHER_PANEL,
  orderedPanelIds,
  PANEL_LABELS,
  type PanelId,
} from "@/lib/biomarker-panels";

// Clinical PANEL dropdown for the biomarkers browser (#1502). Before the panel
// taxonomy existed, `?panel=` held the document's free-text section heading —
// which in practice is the lab VENDOR, so the only facet the browser could offer
// was "show me everything drawn at Quest Diagnostics". This offers the normalized
// taxonomy instead ("Lipids", "Complete blood count", "Thyroid"), writing a stable
// SLUG into the param so a reword never breaks a bookmark.
//
// The full curated set is offered rather than only the panels present in the
// current view — the same decision CategoryFilterSelect made, and it keeps the
// control's contents stable while filters change. The reserved "Other" slug is
// offered LAST and separated, because it is a real, useful view (the readings the
// taxonomy can't place, i.e. analytes no canonical entry covers) but not a
// clinical panel.
export default function PanelFilterSelect({ value }: { value?: PanelId }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setPanel(next: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set("panel", next);
    else sp.delete("panel");
    // Any filter change returns to page 1 — page 3 of the old result set is
    // meaningless (and usually empty) under a new filter.
    sp.delete("p");
    const s = sp.toString();
    router.push(currentPathHref(s ? `${pathname}?${s}` : pathname));
  }

  const clinical = orderedPanelIds().filter((id) => id !== OTHER_PANEL);

  return (
    <label className="flex max-w-full items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">Panel</span>
      {/* A `w-auto` select sizes itself to its WIDEST option, and the longest panel
          label ("Immunoglobulins & autoantibodies") pushes it past a 390px phone —
          the clipped-content guard catches exactly this. Cap it below `sm` (the
          browser ellipsizes the selected label; the open list is unaffected) and
          leave desktop unconstrained. */}
      <select
        className="input w-auto max-w-[10rem] min-w-0 sm:max-w-none"
        data-testid="panel-filter"
        value={value ?? ""}
        onChange={(e) => setPanel(e.target.value)}
      >
        <option value="">All</option>
        {clinical.map((id) => (
          <option key={id} value={id}>
            {PANEL_LABELS[id].label}
          </option>
        ))}
        <option value={OTHER_PANEL}>{PANEL_LABELS[OTHER_PANEL].label}</option>
      </select>
    </label>
  );
}
