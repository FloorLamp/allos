"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useTransition,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import PendingLink, { PendingOverlay } from "@/components/PendingLink";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
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
// A SAFETY BOUND ON THE FREEZE, not a target duration. The View Transition API
// holds the LAST PAINTED FRAME on screen from the moment it starts until the
// update callback's promise resolves — `useHistoryFoldNavigate` below resolves it
// the instant `isPending` clears, which is normally under the continuity band. If
// that signal never arrives (a browser quirk, a navigation that errors out of the
// transition entirely), this is the difference between an animation that starts
// late and a page that is stuck looking at its own last frame forever.
const VIEW_TRANSITION_SAFETY_MS = 2000;

/**
 * Wraps a same-route `?open=`/`?expand=` navigation in the browser's own View
 * Transition API (#4365) — the `historyfold` continuity motion
 * (lib/micro-motion.ts's `CONTINUITY_MOTIONS`, `.motion-historyfold` in
 * app/globals.css). History's fold and rollup toggles are still plain URL state
 * (#4135: collapsed content stays server-omitted, the URL stays the state
 * carrier) — there is no client fold model here for a CSS class to transition, so
 * this rides the ONE thing that IS true either side of the tap: the browser's own
 * before/after paint of the whole page. Two pixel-identical regions crossfading is
 * indistinguishable from not animating at all, so rows outside the toggled fold or
 * rollup are never seen to move — only the revealed or hidden region visibly does.
 *
 * OPT-IN, not a change to `TimelineFilterLink` itself: a caller hands the returned
 * handler to the `onClick` prop the component already carries, exactly as any
 * other caller-supplied click side effect would. `Chip` and
 * `app/(app)/training/HistorySection.tsx` — this component's other two callers —
 * are unaffected because they never call this hook.
 *
 * Returns `undefined` (so the anchor's own `onClick` prop is simply unset) when
 * there is nothing to wrap: the reader asked for reduced motion, or this browser
 * has no `startViewTransition`. Either way `<Link>` runs its own ordinary
 * navigation, which is exactly today's behaviour.
 */
export function useHistoryFoldNavigate(
  href: AppRoute
): MouseEventHandler<HTMLAnchorElement> | undefined {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const reduceMotion = usePrefersReducedMotion();
  const resolveRef = useRef<(() => void) | null>(null);

  // Fires after every commit. `isPending` clears once the transition's own state
  // update — `router.push` below, started inside `startTransition` — has fully
  // committed, which for an App Router navigation is the new RSC payload landing.
  useEffect(() => {
    if (!isPending && resolveRef.current) {
      resolveRef.current();
      resolveRef.current = null;
    }
  }, [isPending]);

  const supported =
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function";

  return useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (!supported || reduceMotion) return;
      // The SAME conditions `<Link>` itself treats as "let the browser handle
      // it" (lib/nav-click.ts): a modified or non-primary click leaves this
      // document, and preventing it here would trap a middle-click or a
      // cmd/ctrl-click that was never asking to navigate in place.
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      e.preventDefault();
      const root = document.documentElement;
      root.classList.add("motion-historyfold");
      const done = new Promise<void>((resolve) => {
        resolveRef.current = resolve;
        // `{ scroll: false }` IS THE OTHER HALF OF #4045 §4, not an oversight: a
        // manual `router.push` defaults to scrolling to the top exactly like a
        // plain `<Link>` would, and this bypasses `<Link>`'s own click handling —
        // the ONLY place that default is set is here. Dropping this reintroduces
        // the defect #4045 §4 fixed: a tap lands the reader above their own recent
        // history instead of on the card and days they just revealed.
        startTransition(() => router.push(href, { scroll: false }));
      });
      const settle = Promise.race([
        done,
        new Promise<void>((resolve) =>
          setTimeout(resolve, VIEW_TRANSITION_SAFETY_MS)
        ),
      ]);
      document
        .startViewTransition(() => settle)
        .finished.finally(() => root.classList.remove("motion-historyfold"));
    },
    [href, reduceMotion, router, startTransition, supported]
  );
}

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
