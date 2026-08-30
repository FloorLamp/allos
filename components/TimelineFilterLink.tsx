"use client";

import type { MouseEventHandler, ReactNode } from "react";
import PendingLink, { PendingOverlay } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// A timeline filter chip, quick-range pill or month fold header (#2657) — every
// one of them a real navigation that re-queries the feed on the server.
//
// Since #2869 they answer the tap the same way a nav row does. A chip has no
// icon to swap, so its own label is the slot: it stays where it is at reduced
// opacity with the spinner over it (components/PendingLink.tsx). And a repeat
// tap while one is in flight is absorbed — these are chips people tap in quick
// succession while narrowing a view, which is exactly the cadence #1956
// measured turning a slow navigation into one that never lands.
//
// `aria-current`/`aria-expanded` and `scroll={false}` are unchanged.
//
// THE #2657 SCROLL-TARGET CAPTURE IS GONE, with `TimelineScrollRestorer` beside it.
// Both existed for `/timeline`, whose filter row and date-range control re-queried
// the whole feed and left the reader at an offset that no longer meant anything.
// #3958 phase 2 deleted that route and the record answers the question differently:
// #4062 re-nested the folds so an open month's days render under their own card, and
// `scroll={false}` alone leaves the reader looking at the card they tapped. The
// capture was already INERT here — it looked up `#timeline-controls`, which this page
// never had — so this removes dead code rather than a behaviour.
export default function TimelineFilterLink({
  href,
  className,
  children,
  testId,
  label,
  ariaCurrent,
  onClick,
  // Disclosure state for the link-driven fold headers (#2657). `aria-expanded` IS
  // supported on `role="link"` — unlike `aria-pressed`, which the #2535 scan bans
  // outright — so a month card announces open/closed to assistive technology while
  // staying a plain server-rendered link that works before hydration.
  ariaExpanded,
}: {
  href: AppRoute;
  className: string;
  children: ReactNode;
  ariaCurrent?: "page" | "true" | "location";
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
  /**
   * What the pending state announces. Optional because this component is also
   * passed as `DateRangeControl`'s Chip link renderer. A chip whose children ARE
   * its label names itself, and anything richer says so explicitly.
   */
  label?: string;
  ariaExpanded?: boolean;
}) {
  const announced =
    label ?? (typeof children === "string" ? children : "this view");
  return (
    <PendingLink
      href={href}
      label={announced}
      scroll={false}
      testId={testId}
      ariaCurrent={ariaCurrent}
      ariaExpanded={ariaExpanded}
      onClick={onClick}
      className={className}
    >
      {(pending) => (
        <PendingOverlay pending={pending}>{children}</PendingOverlay>
      )}
    </PendingLink>
  );
}
