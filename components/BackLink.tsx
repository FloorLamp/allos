"use client";

import { IconArrowLeft } from "@tabler/icons-react";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// The app's ONE back affordance (#3237). Detail pages had drifted into four
// grammars — above the title, below it, inside a card, and (on dose history)
// absent, replaced by a right-aligned FORWARD link — with no shared component to
// converge on: every one was hand-rolled from `IconArrowLeft` plus a `<Link>`.
//
// The grammar this settles on, and why each half won:
//
//   • ABOVE the page title, never below and never inside a card. The decision to
//     leave a page is made BEFORE its content is read, so the affordance belongs
//     where the eye starts; putting it below the h1 wedges navigation chrome
//     between a title and the content it heads. "Never inside a card" is the
//     same rule stated for the title: a card is a content container, and a page
//     whose identity sits inside one has no page-level heading at all.
//   • MUTED, not brand-colored. A back link is chrome. Several call sites drew
//     it in `text-brand-700`, which is the app's "this is an action" color, so
//     the least consequential control on the page competed with its real ones.
//     The class set here is the one four detail pages had already converged on
//     byte-for-byte (encounters, providers, protocols, equipment) — the winner
//     was chosen on the argument, but it is also the incumbent.
//   • ICON PLUS LABEL, with the label naming the destination. An arrow alone is
//     a direction, not a destination, and "back" is ambiguous the moment a page
//     is reachable from two places.
//   • Built on `PendingLink`, so every back link ANSWERS ITS TAP (#1956/#2983)
//     — the spinner replaces the arrow in its own slot, nothing shifts, and a
//     repeat tap on a pending link is absorbed. Hand-rolled links got none of
//     that; adopting the house component is how a surface picks it up.
//
// WHAT THIS IS NOT: a back BUTTON. `IconArrowLeft` also appears on controls that
// REVERT IN-PAGE STATE rather than navigate — the offline page's card and
// snapshot views, and the activity recap's step-back — and all of those are
// `<button onClick>`, not links. They must not adopt this component, and it must
// not grow a mode for them: `href` plus `PendingLink` IS what it guarantees — a
// real destination, a pending state, an absorbed repeat tap — and a control that
// changes local state has no destination to name and nothing to be pending on. A
// non-navigating mode would dissolve the property the component exists for, on
// behalf of consumers that do not want it.
//
// This matters because #3237's acceptance criterion asks for a grep finding no
// hand-rolled `IconArrowLeft` back links, and THAT GREP IS NOT EMPTY AND IS NOT
// MEANT TO BE: those two sites are the entire remainder. A census that greps the
// icon and not the element type will refile this as unfinished work every time.
// Do not "finish the job" by converting them.
//
// `label` is both the visible text and the accessible name, so a spec finding it
// by `getByRole("link", { name })` needs no testid.
export default function BackLink({
  href,
  label,
  testId,
  className = "mb-4",
}: {
  href: AppRoute;
  label: string;
  testId?: string;
  /** Spacing only — a caller inside its own wrapper may need none. Never color. */
  className?: string;
}) {
  return (
    <PendingLink
      href={href}
      label={label}
      testId={testId}
      className={`inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300 ${className}`}
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
          {label}
        </>
      )}
    </PendingLink>
  );
}
