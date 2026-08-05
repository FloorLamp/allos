"use client";

import { useState, type ReactNode } from "react";
import { EmptyState } from "@/components/ui";
import MobileDetailPage from "@/components/MobileDetailPage";
import { openDetailOnMobile } from "@/components/mobileDetail";
import ScrollFade from "@/components/ScrollFade";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import type { AppRoute } from "@/lib/hrefs";

// One column of an explorer's summary table. The first column is the row's
// identity (and the card title below `sm`); later columns become labeled meta
// lines there, so the phone card carries the same facts as the desktop grid.
export interface ExplorerColumn<T> {
  header: string;
  cellClassName?: string;
  cell: (item: T) => ReactNode;
}

// The shared master–detail explorer surface (#1491 item 3, audit drift D2).
//
// Cardio, Sport and Strength each carried a byte-near-identical copy of this
// shell: a 3/2 grid with a select-a-row summary table on the left, the detail
// panel beside it on desktop, and the same panel in a bottom sheet on mobile
// (AnalyzeSection is the fourth sibling, already on ResponsiveTable via #1482).
// The shell now lives once: selection state, the mobile-detail handoff, the
// active/hover row treatment, the empty state, and the ResponsiveTable/ScrollFade
// presentation. Each explorer supplies its columns and its detail panel.
export default function ExplorerShell<T>({
  heading,
  hint,
  emptyMessage,
  emptyAction,
  items,
  itemKey,
  columns,
  renderDetail,
}: {
  heading: string;
  hint: string;
  emptyMessage: string;
  emptyAction: { href: AppRoute; label: string };
  items: T[];
  // The row's stable identity — also the mobile detail sheet's title.
  itemKey: (item: T) => string;
  columns: ExplorerColumn<T>[];
  renderDetail: (item: T) => ReactNode;
}) {
  const [selected, setSelected] = useState(
    items[0] != null ? itemKey(items[0]) : null
  );
  const [detailOpen, setDetailOpen] = useState(false);

  if (items.length === 0) {
    return <EmptyState message={emptyMessage} action={emptyAction} />;
  }

  const current = items.find((i) => itemKey(i) === selected) ?? items[0];

  function selectItem(item: T) {
    setSelected(itemKey(item));
    openDetailOnMobile(() => setDetailOpen(true));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="card min-w-0 lg:col-span-3">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          {heading}
        </h2>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
        <ScrollFade>
          <ResponsiveTable className="w-full whitespace-nowrap">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/10">
                {columns.map((col) => (
                  <th key={col.header} className="th">
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const active = itemKey(item) === itemKey(current);
                return (
                  <tr
                    key={itemKey(item)}
                    onClick={() => selectItem(item)}
                    className={`cursor-pointer border-b border-black/5 transition dark:border-white/10 ${
                      active
                        ? "bg-brand-50 dark:bg-brand-950"
                        : "hover:bg-brand-50/60 dark:hover:bg-brand-950/50"
                    }`}
                  >
                    {columns.map((col, i) => (
                      <Td
                        key={col.header}
                        slot={i === 0 ? "title" : "meta"}
                        label={i > 0 ? col.header : undefined}
                        className={col.cellClassName ?? ""}
                      >
                        {col.cell(item)}
                      </Td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </ResponsiveTable>
        </ScrollFade>
      </div>

      {/* Details — beside the list on desktop, in a bottom sheet on mobile. */}
      <div className="card hidden lg:col-span-2 lg:block">
        {renderDetail(current)}
      </div>

      <MobileDetailPage
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={itemKey(current)}
      >
        {renderDetail(current)}
      </MobileDetailPage>
    </div>
  );
}
