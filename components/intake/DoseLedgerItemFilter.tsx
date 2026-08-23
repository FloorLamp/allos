"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { currentPathHref } from "@/lib/hrefs";

// The dose ledger's ITEM filter (#2417). Writes the choice into the `item` query
// param on the current path (preserving the kind and date-window params), so the
// server component re-reads the ledger narrowed to that item — the same reader, the
// same window, the same rows the item's own dose-history panel shows.
//
// Every item the profile owns is offered, ACTIVE OR NOT: history outlives retirement,
// and a filter that silently dropped a paused item would make its recorded doses
// unreachable from the only surface that lists them all.
export default function DoseLedgerItemFilter({
  items,
  value,
}: {
  items: { id: number; label: string }[];
  value?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setItem(next: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set("item", next);
    else sp.delete("item");
    const s = sp.toString();
    router.push(currentPathHref(s ? `${pathname}?${s}` : pathname));
  }

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">Item</span>
      {/* A `w-auto` select sizes to its WIDEST OPTION, and these options are item
          names nobody chose — a portal import writes "Calcium Carb-Cholecalciferol
          (CALCIUM 500 + D OR)", and the " (inactive)" suffix adds eleven more
          characters. So the control's intrinsic width is unbounded by anything the
          page controls, which is #3478: measured at 390px it rendered 447px wide,
          108px past the viewport, with the app shell clipping it silently — no
          ellipsis, no scroller, no chevron.

          `min-w-0` HERE is the load-bearing class, and it is not the one the issue
          predicted. Measured at 390px against this same fixture (select right edge
          vs a 390px viewport):

            input w-auto                                → 447px wide, 108px over
            + label min-w-0, select max-w-full          → 358px wide,  19px over
            + select min-w-0                            → 323px wide,  16px inside

          A flex item's `min-width: auto` resolves to its CONTENT minimum, and a
          select's content minimum is its widest option — so a `max-width` cap never
          gets to bite until the floor underneath it is released. `truncate` then
          gives the shortened value an ellipsis; without it Chromium hard-clips the
          text mid-character ("… (CALCIUM 50"). The OPEN list is unaffected — it is
          the browser's popup and sizes itself — so nothing about the choice is lost.

          Deliberately width-agnostic rather than PanelFilterSelect's
          `max-w-40 sm:max-w-none`: that control offers a CLOSED vocabulary whose
          longest label is known, and these names are unbounded at every width. */}
      <select
        className="input w-auto min-w-0 truncate"
        value={value ?? ""}
        data-testid="dose-ledger-item-filter"
        onChange={(event) => setItem(event.target.value)}
      >
        <option value="">All items</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
