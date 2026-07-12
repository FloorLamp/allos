"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { currentPathHref } from "@/lib/hrefs";

// Session-storage key remembering the last-chosen range filter, so it carries
// across the records browser and the per-document subpages within a session.
const STORAGE_KEY = "medical:range";

type RangeValue = "" | "nonoptimal" | "oor";

function normalize(v: string | undefined | null): RangeValue {
  return v === "oor" ? "oor" : v === "nonoptimal" ? "nonoptimal" : "";
}

// Three-way "show" filter for a medical records table: All / Non-optimal / Out
// of range only. Writes the choice into the `range` query param on the current
// path (preserving other params), so server components read it back. Path-
// agnostic, and persists to sessionStorage like the old checkbox did.
export default function RangeFilterSelect({ value }: { value?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = normalize(value);

  // On first mount, if the URL doesn't specify `range` but a previous choice in
  // this session is remembered, restore it. An explicit param in the URL wins.
  useEffect(() => {
    if (searchParams.has("range")) return;
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved === "oor" || saved === "nonoptimal") {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("range", saved);
      router.replace(currentPathHref(`${pathname}?${sp.toString()}`));
    }
    // Mount-only: restore once, not on every param change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setRange(next: RangeValue) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next) {
      sp.set("range", next);
      sessionStorage.setItem(STORAGE_KEY, next);
    } else {
      sp.delete("range");
      sessionStorage.removeItem(STORAGE_KEY);
    }
    const s = sp.toString();
    router.push(currentPathHref(s ? `${pathname}?${s}` : pathname));
  }

  return (
    <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">Show</span>
      <select
        className="input w-auto"
        value={current}
        onChange={(e) => setRange(e.target.value as RangeValue)}
      >
        <option value="">All</option>
        <option value="nonoptimal">Non-optimal</option>
        <option value="oor">Out of range only</option>
      </select>
    </label>
  );
}
