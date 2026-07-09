"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Debounced free-text search box that filters medical records by name or panel.
// Writes the query into the `q` param on the current path (preserving the other
// params), so server components can read it back. Path-agnostic, so it works on
// both the medical history table and a per-document subpage.
export default function RecordSearch({ q }: { q?: string }) {
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
      router.replace(s ? `${pathname}?${s}` : pathname);
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
      className="input w-auto"
    />
  );
}
