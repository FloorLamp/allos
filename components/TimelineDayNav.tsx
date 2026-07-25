"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useDragGesture } from "@/components/overlay";
import type { AppRoute } from "@/lib/hrefs";

// Adjacent-day navigation for the Timeline's single-day view (issue #1425).
//
// Two things, deliberately in one component: the visible prev/next controls and
// the horizontal swipe that does the same thing. They ship together because the
// gesture is a SHORTCUT and must never be the only route — a swipe is invisible,
// undiscoverable, and unavailable to a keyboard, a mouse, or a screen reader.
// Keeping them in one file also keeps them keyed to the SAME hrefs: there is one
// pair of destinations, built once on the server by `timelineDayHref`, so the
// gesture cannot drift into its own date arithmetic and land on a different day
// than the arrow beside it. (The day math is the server's for a reason: which
// calendar day is "yesterday" depends on the profile's timezone, and a client
// recomputing it from `new Date()` would be wrong for exactly the travelling
// user the multi-timezone work exists for.)
//
// ── What the swipe is attached to ────────────────────────────────────────────
//
// The page's content container, not the event feed: a day with nothing logged
// renders an empty state instead of a feed, and "swipe past the quiet day" is
// precisely when you most want the gesture. It is still SCOPED, not global —
// anything portalled over the page (the nav drawer, a bottom sheet, the activity
// dock) is a sibling of <body> and therefore outside the target, so an open
// overlay's own gestures can never double as a day change. Inside the container
// the recognizer stands down for horizontally scrollable children
// (`ignoreSameAxisScrollers`) so the filter chips, a wide table or a chart strip
// keep their own scroll, and for gestures starting in the left edge zone
// (`ignoreEdgeStart`) which belong to the drawer.
//
// Vertical scrolling always wins: nothing here calls preventDefault, and the
// axis lock in lib/gesture.ts refuses to claim anything that isn't decisively
// horizontal (see `axisRatio` — a 45° drag is read as a scroll, on purpose).
export default function TimelineDayNav({
  prevHref,
  nextHref,
  prevLabel,
  nextLabel,
  targetSelector,
}: {
  prevHref: AppRoute;
  nextHref: AppRoute;
  prevLabel: string;
  nextLabel: string;
  targetSelector: string;
}) {
  const router = useRouter();
  // The container is rendered by the layout/server component that mounts this
  // one, so there is no ref to pass down. Resolved after every render (cheap,
  // and it survives the page re-rendering under a filter change); the recognizer
  // only reads it at touch-start, by which time it is populated.
  const targetRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    targetRef.current = document.querySelector<HTMLElement>(targetSelector);
  });

  const shared = {
    targetRef,
    ignoreSameAxisScrollers: true,
    ignoreEdgeStart: true,
  } as const;

  // Swipe left: the day slides away to the left, the NEXT one arrives — the
  // direction every paged calendar on a phone already teaches.
  useDragGesture({
    ...shared,
    direction: "left",
    onCommit: () => router.push(nextHref),
  });
  useDragGesture({
    ...shared,
    direction: "right",
    onCommit: () => router.push(prevHref),
  });

  return (
    <nav
      data-testid="timeline-day-nav"
      aria-label="Adjacent days"
      className="mb-5 flex items-center justify-between gap-2"
    >
      <Link
        href={prevHref}
        data-testid="timeline-day-prev"
        className="btn-secondary text-xs"
      >
        <IconChevronLeft className="h-4 w-4" stroke={2} aria-hidden="true" />
        {prevLabel}
      </Link>
      <Link
        href={nextHref}
        data-testid="timeline-day-next"
        className="btn-secondary text-xs"
      >
        {nextLabel}
        <IconChevronRight className="h-4 w-4" stroke={2} aria-hidden="true" />
      </Link>
    </nav>
  );
}
