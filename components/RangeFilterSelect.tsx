"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { currentPathHref } from "@/lib/hrefs";
import QueryParamSelect from "./QueryParamSelect";

// Session-storage key remembering the last-chosen range filter, so it carries
// across the results browser and the per-document subpages within a session.
const STORAGE_KEY = "medical:range";

const OPTIONS = [
  { value: "nonoptimal", label: "Non-optimal" },
  { value: "oor", label: "Out of range only" },
] as const;

function normalize(v: string | undefined | null): string {
  return v === "oor" || v === "nonoptimal" ? v : "";
}

// Three-way "show" filter for a clinical readings table: All / Non-optimal / Out
// of range only. The URL write is QueryParamSelect's; what stays HERE is the
// PERSISTENCE POLICY (#3748 keeps it out of the primitive) — this filter, alone
// among the three, remembers its choice for the session like the old checkbox did.
export default function RangeFilterSelect({ value }: { value?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // On first mount, if the URL doesn't specify `range` but a previous choice in
  // this session is remembered, restore it. An explicit param in the URL wins.
  // (e2e/helpers.ts leans on this: it is why the click helper arms its
  // "did my click move the page" baseline lazily.)
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

  return (
    <QueryParamSelect
      param="range"
      label="Show"
      value={normalize(value)}
      options={OPTIONS}
      onSelect={(next) => {
        if (next) sessionStorage.setItem(STORAGE_KEY, next);
        else sessionStorage.removeItem(STORAGE_KEY);
      }}
    />
  );
}
