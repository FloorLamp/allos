"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// The standard medical-record categories, matching the biomarkers filter and the
// per-row category editor. Offering the fixed set (rather than only categories
// present in the current view) keeps the control consistent with the biomarkers
// table wherever it's used. This is the DEFAULT option set — the document view
// relies on it including 'prescription' so meds stay filterable there; the
// biomarkers browser passes its own prescription-less list.
const CATEGORIES = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
] as const;

// Category dropdown for a medical records table. Writes the choice into the
// `category` query param on the current path (preserving other params), so
// server components read it back. Path-agnostic, so it works on both the
// biomarkers browser and a per-document results table. `categories` overrides the
// offered set (defaults to the full list, so the document view is unchanged).
export default function CategoryFilterSelect({
  value,
  categories = CATEGORIES,
}: {
  value?: string;
  categories?: readonly string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setCategory(next: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set("category", next);
    else sp.delete("category");
    const s = sp.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  }

  return (
    <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">Category</span>
      <select
        className="input w-auto capitalize"
        value={value ?? ""}
        onChange={(e) => setCategory(e.target.value)}
      >
        <option value="">All</option>
        {categories.map((c) => (
          <option key={c} value={c} className="capitalize">
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}
