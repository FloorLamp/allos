"use client";

import type { ReactNode } from "react";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

// A navigation ROW that answers the tap (issue #1956).
//
// The measurement that produced this: enter at `/`, wait for a sidebar link to
// be visible, then tap. The tap is intercepted (`defaultPrevented === true`),
// the App Router requests the destination's RSC payload ~20ms later and has a
// 200 back inside 100ms — and then the screen does not change for 0.3s on an
// idle box and multiple seconds on a loaded one. `(app)` deliberately ships no
// `loading.tsx` (app/(app)/layout.tsx explains why — issue #530), so the router
// transition has no Suspense boundary to reveal: React renders the whole
// destination before swapping, and the old page stays visible and fully
// interactive the entire time. Nothing about the app said "I heard you", so
// people tapped again — and every extra tap dispatched a SECOND navigation that
// threw away the render already in flight. That is why the original report
// measured 5–12 taps: the taps were the reason it never landed, not evidence
// that it never would.
//
// Both remedies — a spinner in the row's own icon slot, and absorption of the
// repeat tap — now live in `components/PendingLink.tsx`, because #2869 needed
// them on controls that are not row-shaped (day arrows, pagers, filter chips)
// and a second copy of the doctrine is how two surfaces drift. This file is what
// is left once they moved down: the ROW shape. The icon slot is the pending
// slot, and `children` rides after it (a nav row's label and its count badge).
export default function PendingNavLink({
  href,
  label,
  icon,
  className,
  current = false,
  testId,
  children,
}: {
  href: AppRoute;
  /** The row's own name — what the pending state announces. */
  label: string;
  /** The resting icon. Replaced in place by the spinner while pending. */
  icon: ReactNode;
  className?: string;
  /** Renders `aria-current="page"` when this row is the page being viewed. */
  current?: boolean;
  /**
   * `data-testid` on the anchor itself. A row whose only distinguishing mark is
   * its position — a bottom-dock slot (#2651) — needs a stable handle, and
   * wrapping the link in a marked <div> would put the marker on an element that
   * is not the thing you tap.
   */
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <PendingLink
      href={href}
      label={label}
      className={className}
      current={current}
      testId={testId}
    >
      {(pending) => (
        <>
          <PendingIconSlot pending={pending} icon={icon} />
          {children}
        </>
      )}
    </PendingLink>
  );
}
