"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { currentPathHref } from "@/lib/hrefs";

// THE query-backed filter select (#3748). Category, Panel and Show each restated
// the same clone / set-or-delete / push and the same labelled shell; this owns all
// of it. Unrelated params (a search term, sort/dir, a tab) and the pathname
// survive, the unset option DELETES the param, `param` is also the test id
// (`<param>-filter`) and `label` is both caption and accessible name, so no marker
// can drift from what it addresses.
//
// CLOSED: no className, no caller URL builder, no caller option markup — the seams
// the three copies drifted through, and a call site needing more is a finding
// rather than a prop. The two callbacks invert that: #3748 keeps PERSISTENCE
// POLICY outside the primitive, so a call site says WHICH value it remembers while
// every URL write stays in here.
//
// AND THIS IS WHERE THE 44px FLOOR COMES BACK (#3938). The field renders `.input`,
// the one 34px box, and a native <select> cannot grow a pseudo-element, so its
// target IS the box — it forfeits the effective floor every repairable control
// keeps. #3938 names an owned picker as the recovery path: that is now one edit
// here rather than three, and no call site can opt out of it.
export default function QueryParamSelect({
  param,
  label,
  value,
  options,
  onSelect,
  restoreWhenUnset,
}: {
  param: string;
  label: string;
  value?: string;
  // Rendered as given: the owner applies no text transform, because one shared
  // `capitalize` would retitle another caller's labels.
  options: readonly { value: string; label: string }[];
  // The call site's own policy on the chosen value, run before navigating.
  onSelect?: (next: string) => void;
  // Its remembered value, adopted only when the URL names none — read in an effect
  // so a server render never reaches for browser storage.
  restoreWhenUnset?: () => string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function href(next: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set(param, next);
    else sp.delete(param);
    const s = sp.toString();
    return currentPathHref(s ? `${pathname}?${s}` : pathname);
  }

  useEffect(() => {
    if (searchParams.has(param)) return;
    const saved = restoreWhenUnset?.();
    if (saved) router.replace(href(saved));
    // Mount-only: restore once, not on every param change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <label className="flex max-w-full items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="font-medium">{label}</span>
      {/* NO WIDTH NUMBER, and that is a measurement rather than a preference. A
          `w-auto` select sizes to its WIDEST option, and the panel facet's longest
          ("Immunoglobulins & autoantibodies") wants 295px, so the shipped treatment
          capped it at `max-w-40`. Converging put that cap on all three, and at
          390x844 in Chromium it made "Out of range only" the 1 of 3 range options
          that no longer fit its 110px content box — a control truncating a label it
          had always shown. So this takes the shape `IntakeRulesEditor`'s "Other
          item" select uses for the same problem: `min-w-0` releases the flex
          content-minimum so a wrapping row can shrink the control, the wrapper's
          `max-w-full` clamps it to that row, and `truncate` ellipsizes only if
          something actually overruns — no constant to be right for one vocabulary
          and wrong for the next. Measured on this page with it: at 390 the three
          boxes are 123 / 295 / 173 px with 0 of 5, 0 of 37 and 0 of 3 options
          clipped, every row ending by 354.8px, and `documentElement.scrollWidth
          === clientWidth === 390`; the same at 1280; and 173px / 0 of 3 / row end
          252px for the range filter on `/import/908`, the route the
          clipped-content guard walks. It also frees the 14 of 37 panel labels the
          fixed cap had been ellipsizing. */}
      <select
        className="input w-auto min-w-0 truncate"
        data-testid={`${param}-filter`}
        value={value ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          onSelect?.(next);
          router.push(href(next));
        }}
      >
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
