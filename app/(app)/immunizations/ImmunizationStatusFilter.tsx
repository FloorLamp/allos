"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ImmunizationFilter } from "@/lib/immunization-status";

// Status filter for the immunizations master table. Writes the
// choice into the `status` query param on the current path (preserving the sort
// params), so the server component reads it back and filters the assessments.
// Modeled on the biomarkers RangeFilterSelect.
const OPTIONS: { value: "" | ImmunizationFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "needs-attention", label: "Needs attention" },
  { value: "up-to-date", label: "Up to date" },
  { value: "complete", label: "Complete" },
  { value: "immune", label: "Immune" },
  { value: "declined", label: "Declined" },
  { value: "unknown", label: "No record" },
];

export default function ImmunizationStatusFilter({
  value,
}: {
  value?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = OPTIONS.some((o) => o.value === value) ? value : "";

  function setStatus(next: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set("status", next);
    else sp.delete("status");
    const s = sp.toString();
    router.push(s ? `${pathname}?${s}` : pathname);
  }

  return (
    <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">Show</span>
      <select
        className="input w-auto"
        value={current}
        onChange={(e) => setStatus(e.target.value)}
      >
        {OPTIONS.map((o) => (
          <option key={o.value || "all"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
