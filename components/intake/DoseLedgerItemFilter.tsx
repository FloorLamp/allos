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
    <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">Item</span>
      <select
        className="input w-auto"
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
