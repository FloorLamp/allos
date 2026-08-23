"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { currentPathHref } from "@/lib/hrefs";

// Debounced free-text search box that filters clinical observations by name or panel.
// Writes the query into the `q` param on the current path (preserving the other
// params), so server components can read it back. Path-agnostic, so it works on
// both the medical history table and a per-document subpage.
export default function ObservationSearch({
  q,
  shareRow = false,
}: {
  q?: string;
  // See the className below: opt in where this field shares a toolbar row.
  shareRow?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(q ?? "");

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (searchParams.get("q") ?? "")) return;
    const t = setTimeout(() => {
      const sp = new URLSearchParams(searchParams.toString());
      if (trimmed) sp.set("q", trimmed);
      else sp.delete("q");
      const s = sp.toString();
      router.replace(currentPathHref(s ? `${pathname}?${s}` : pathname));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <input
      type="search"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      placeholder="Search name or panel…"
      aria-label="Search records by name or panel"
      className={`input ${
        // OPT-IN, so the other host is untouched. In a toolbar that also carries the
        // Filters trigger and a create action (#3496 item 2), the field takes the
        // leftover width below `sm` instead of claiming its intrinsic size and
        // pushing its neighbours onto rows of their own. From `sm` up, and anywhere
        // that does not ask, it is the auto-width control it has always been.
        shareRow ? "min-w-0 flex-1 sm:w-auto sm:flex-none" : "w-auto"
      }`}
    />
  );
}
