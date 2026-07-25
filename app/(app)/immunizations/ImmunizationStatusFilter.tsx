"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { ImmunizationFilter } from "@/lib/immunization-status";
import { currentPathHref } from "@/lib/hrefs";
import FilterPills, { type FilterPillOption } from "@/components/FilterPills";

// Status filter for the immunizations master table. The choice rides the `status`
// query param on the current path (preserving the sort params), so the server
// component reads it back and filters the assessments.
//
// #1449 (cluster C): this was a "Show" + <select>, one of FOUR filter affordances
// the records family had grown for one job. It now renders the shared
// `FilterPills` — the family's single filter control — in LINK mode: each state is
// a real <a href>, so a click landing in the pre-hydration window does a native
// navigation instead of being silently swallowed (the #830 reasoning that made
// NavTabs use Links), and the seven options scroll on one line rather than
// wrapping to three on a phone.
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = OPTIONS.some((o) => o.value === value) ? (value ?? "") : "";

  // One href per state, carrying the current sort/dir through. "All" DROPS the
  // param rather than encoding an empty value, so the default view has one URL.
  const options: FilterPillOption<string>[] = OPTIONS.map((o) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (o.value) sp.set("status", o.value);
    else sp.delete("status");
    const s = sp.toString();
    return {
      value: o.value,
      label: o.label,
      href: currentPathHref(s ? `${pathname}?${s}` : pathname),
    };
  });

  return (
    <FilterPills
      options={options}
      value={current}
      label="Filter vaccines by status"
      testId="immunization-status-filter"
    />
  );
}
