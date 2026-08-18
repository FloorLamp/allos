"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useDragGesture } from "@/components/overlay";
import { useShellChrome } from "@/components/useShellChrome";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
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
//
// ── The pinned slot (issue #1517 A) ─────────────────────────────────────────
//
// On a phone this is the control the day view is FOR — prev/next day, used
// constantly — and until #1517 it scrolled away the moment you read into the
// day's events, while the filter block (set once a session) was glued to the
// screen above it. The priority is swapped: this nav is the sticky one below
// `sm`, and the filters scroll away behind their one-line summary.
//
// It rides the SAME machinery the Trends context bar does (#1485 F) rather than
// forking it — `useShellChrome()` for the hide/reveal state, `--shell-chrome-h`
// for the offset, `.sub-chrome` for the transform (app/globals.css). That is
// also what the "#1416 interaction" note in #1517 asks for: the offset is the
// shell's published height, never a hardcoded 3.5rem, so it stays correct when
// the multi-profile view banner rides inside the chrome and makes it taller.
// From `sm` up it drops to static and nothing sticks — desktop is unchanged.
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
  const { hidden, ready } = useShellChrome();
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

  // ── The swipe answers too (issue #2869) ─────────────────────────────────────
  //
  // The arrows get their pending state from `useLinkStatus` inside PendingLink,
  // but the swipe is a `router.push` and has no link to report it. It was the
  // most-repeated navigation on a phone with the least feedback: the finger
  // leaves the screen and nothing at all happens until the next day commits.
  //
  // So the push runs inside this component's own transition, and the direction
  // it went is remembered — that lets the SAME chevron slot the arrow would use
  // carry the spinner, rather than the swipe inventing a second pending style
  // somewhere else in the bar. A swipe while one is already running is dropped
  // for the same reason a repeat tap is (lib/nav-click.ts): a second push
  // discards the render already in flight, and the gesture has no modifier keys,
  // so "already navigating" is the whole rule here.
  const [swiping, startSwipe] = useTransition();
  const [swipeDirection, setSwipeDirection] = useState<"prev" | "next" | null>(
    null
  );
  const swipeTo = (direction: "prev" | "next", href: AppRoute) => {
    if (swiping) return;
    setSwipeDirection(direction);
    startSwipe(() => {
      router.push(href);
    });
  };

  // Swipe left: the day slides away to the left, the NEXT one arrives — the
  // direction every paged calendar on a phone already teaches.
  useDragGesture({
    ...shared,
    direction: "left",
    onCommit: () => swipeTo("next", nextHref),
  });
  useDragGesture({
    ...shared,
    direction: "right",
    onCommit: () => swipeTo("prev", prevHref),
  });

  const swipePending = (direction: "prev" | "next") =>
    swiping && swipeDirection === direction;

  return (
    <nav
      data-testid="timeline-day-nav"
      aria-label="Adjacent days"
      data-hidden={hidden ? "true" : "false"}
      // Same contract as ShellChrome's/TrendsContextBar's: the scroll listener only
      // exists after hydration, so before it the nav is simply always revealed (the
      // safe state), and a browser test can wait for the real behavior.
      data-ready={ready ? "true" : "false"}
      // Full-bleed on a phone so the sticky nav's background covers the content
      // gutters as the day's events scroll under it; from `sm` up it is an ordinary
      // block in the reading column, exactly as before.
      className="sub-chrome sticky top-(--shell-chrome-h) z-20 -mx-4 mb-5 flex items-center justify-between gap-2 border-b border-(--border) bg-(--nav) px-4 py-2 sm:static sm:z-auto sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0"
    >
      <PendingLink
        href={prevHref}
        label={prevLabel}
        testId="timeline-day-prev"
        className="btn-ghost text-xs"
      >
        {(pending) => (
          <>
            <PendingIconSlot
              pending={pending || swipePending("prev")}
              size="h-4 w-4"
              icon={
                <IconChevronLeft
                  className="h-4 w-4"
                  stroke={2}
                  aria-hidden="true"
                />
              }
            />
            {prevLabel}
          </>
        )}
      </PendingLink>
      <PendingLink
        href={nextHref}
        label={nextLabel}
        testId="timeline-day-next"
        className="btn-ghost text-xs"
      >
        {(pending) => (
          <>
            {nextLabel}
            <PendingIconSlot
              pending={pending || swipePending("next")}
              size="h-4 w-4"
              icon={
                <IconChevronRight
                  className="h-4 w-4"
                  stroke={2}
                  aria-hidden="true"
                />
              }
            />
          </>
        )}
      </PendingLink>
      {/* The arrows announce themselves from inside PendingLink; a swipe has no
          link to do that, so the bar names the day it is opening. */}
      {swiping && (
        <span role="status" className="sr-only">
          Opening {swipeDirection === "next" ? nextLabel : prevLabel}
        </span>
      )}
    </nav>
  );
}
