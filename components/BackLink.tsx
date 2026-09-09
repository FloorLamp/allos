"use client";

import { IconArrowLeft } from "@tabler/icons-react";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// The app's ONE back affordance (#3237), placed by `PageHeader` since #5411.
//
//   • THE DESTINATION'S OWN NAME, and nothing else. An arrow alone is a
//     direction, not a destination, and "back" is ambiguous the moment a page is
//     reachable from two places. The name is COPIED from the destination's nav
//     row, tab or section title rather than composed, so there is no casing rule
//     and no "Back to" / "All" grammar left to drift apart.
//   • MUTED, not brand-colored. A back link is chrome. Several call sites drew it
//     in `text-brand-700` — the app's "this is an action" color — so the least
//     consequential control on the page competed with its real ones.
//   • PLACED BY THE HEADER, not by this component and not by its caller.
//     `PageHeader`'s `back` slot owns the position (above the h1) and the gap, and
//     keeps the link visible where `compactBelowSm` sends the title `sr-only`.
//     The pages that mount this directly are the ones with no `PageHeader` at all;
//     `lib/__tests__/back-link-mount-scan.test.ts` names them and holds the line.
//   • Built on `PendingLink`, so every back link ANSWERS ITS TAP (#1956/#2983) —
//     the spinner replaces the arrow in its own slot, nothing shifts, and a repeat
//     tap on a pending link is absorbed.
//
// WHAT THIS IS NOT: a back BUTTON. `IconArrowLeft` also appears on controls that
// REVERT IN-PAGE STATE rather than navigate — the offline page's card and snapshot
// views, the activity recap's step-back, the quick-log sheet's return to its kind
// menu — and all of those are `<button onClick>`, not links. They must not adopt
// this component, and it must not grow a mode for them: `href` plus `PendingLink`
// IS what it guarantees — a real destination, a pending state, an absorbed repeat
// tap — and a control that changes local state has no destination to name and
// nothing to be pending on.
//
// This matters because #3237's acceptance criterion asks for a grep finding no
// hand-rolled `IconArrowLeft` back links, and THAT GREP IS NOT EMPTY AND IS NOT
// MEANT TO BE: those sites are the entire remainder. A census that greps the icon
// and not the element type will refile this as unfinished work every time. Do not
// "finish the job" by converting them.
//
// `destination` is both the visible text and the accessible name, so a spec
// finding it by `getByRole("link", { name })` needs no testid.
export default function BackLink({
  href,
  destination,
  testId,
}: {
  href: AppRoute;
  destination: string;
  testId?: string;
}) {
  return (
    <PendingLink
      href={href}
      label={destination}
      testId={testId}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
    >
      {(pending) => (
        <>
          <PendingIconSlot
            pending={pending}
            size="h-4 w-4"
            icon={
              <IconArrowLeft className="h-4 w-4" stroke={1.75} aria-hidden />
            }
          />
          {destination}
        </>
      )}
    </PendingLink>
  );
}
