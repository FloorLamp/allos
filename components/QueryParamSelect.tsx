"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { currentPathHref } from "@/lib/hrefs";

// THE query-backed filter select (#3748). It owns the whole contract that
// Category, Panel and Show each used to restate: clone the CURRENT query string
// so unrelated params (a search term, the table's sort/dir, a tab) survive, set
// or DELETE this one param, and push the same pathname back — so the surface is
// path-agnostic and a server component re-reads the choice.
//
// CLOSED ON PURPOSE. There is no `className`, no caller-supplied URL builder and
// no per-caller option markup: those are exactly the seams the three copies drifted
// through, and reopening one puts the next divergence back. A call site that needs
// something this does not offer is a finding, not a prop. The one seam that IS here
// is `onSelect`, and it exists because #3748 rules that PERSISTENCE POLICY stays
// outside the primitive — the range filter's session memory is its own business.
//
// THE BOX, AND WHY THIS IS WHERE THE FLOOR COMES BACK (#3938). The field renders
// `.input`, i.e. the one 34px control box, and because a native `<select>` cannot
// grow a pseudo-element its target IS that box — it forfeits the 44px effective
// floor every repairable control keeps. #3938 names converging onto an OWNED picker
// as the recovery path, and this is now that owner: whatever restores contained
// reach for these three filters is one edit here, not three, and no call site can
// opt out of it.
export default function QueryParamSelect({
  param,
  label,
  value,
  options,
  onSelect,
}: {
  // The query key this control owns. Also its test id (`<param>-filter`), so the
  // marker cannot drift from the param it addresses.
  param: string;
  // The visible caption AND the select's accessible name — one string, because a
  // wrapping <label> gives both and they can therefore never disagree.
  label: string;
  value?: string;
  options: readonly { value: string; label: string }[];
  // The call site's own policy on the chosen value, run before navigating.
  onSelect?: (next: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <label className="flex max-w-full items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">{label}</span>
      {/* A `w-auto` select sizes itself to its WIDEST option, and the longest panel
          label ("Immunoglobulins & autoantibodies") pushes it past a 390px phone —
          the clipped-content guard catches exactly this. Cap it below `sm` (the
          browser ellipsizes the selected label; the open list is unaffected) and
          leave desktop unconstrained. */}
      <select
        className="input w-auto max-w-40 min-w-0 sm:max-w-none"
        data-testid={`${param}-filter`}
        value={value ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          onSelect?.(next);
          const sp = new URLSearchParams(searchParams.toString());
          if (next) sp.set(param, next);
          else sp.delete(param);
          const s = sp.toString();
          router.push(currentPathHref(s ? `${pathname}?${s}` : pathname));
        }}
      >
        {/* The unset option is the owner's, not a caller's: it is what DELETES the
            param, so "no filter" cannot be spelled two ways. */}
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
