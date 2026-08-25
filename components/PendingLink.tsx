"use client";

import Link, { useLinkStatus } from "next/link";
import { IconLoader2 } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { isDuplicateNavClick } from "@/lib/nav-click";
import type { AppRoute } from "@/lib/hrefs";

// The answered tap, as a primitive (issues #1956, #2869).
//
// #1956 established the doctrine and #2651 extended it one surface at a time:
// a tap on something that navigates must paint feedback IN THE CONTROL'S OWN
// SLOT, and a repeat tap on a control that is already navigating must be
// absorbed rather than restarting the navigation. Both halves lived inside
// `PendingNavLink`, which is shaped like a nav ROW — it takes an icon and swaps
// the spinner into the icon's place. Every other navigation affordance in the
// app (day arrows, pagers, filter chips) had neither half, because adopting the
// doctrine meant adopting a row.
//
// So the two guarantees moved DOWN here and `PendingNavLink` became one of the
// callers. There is exactly one mechanism, and a new surface picks it up by
// choosing which of the two pending TREATMENTS below fits its shape:
//
//   • `PendingIconSlot` — the control already has an icon. The spinner replaces
//     it in place, so nothing shifts. This is #1956's original treatment and it
//     is what nav rows, the dock, and the timeline day arrows use.
//   • `PendingOverlay` — the control is text (a "Prev" pager step, a filter
//     chip). Its own area IS the slot: the label stays exactly where it is at
//     reduced opacity and the spinner is laid over it. No shift, and the label
//     is still readable — a pending treatment must not erase the content that
//     was there (components/AGENTS.md).
//
// Both are the same rule ("the spinner paints in the control's own slot"),
// differing only in which slot the control has. Neither is a second mechanism.
//
// The two implementation notes #1956 paid a measurement for still hold and are
// the reason this is a component rather than a hook:
//
//   • `useLinkStatus()` only resolves INSIDE a `<Link>` subtree, so the pending
//     flag is read by the child rendered below and handed back up for the click
//     guard.
//   • That hand-back is an EFFECT, not a render-phase write. `useLinkStatus` is
//     backed by `useOptimistic`, so React renders the subtree speculatively both
//     with and without the optimistic value; a render-phase write records
//     whichever pass ran last rather than the one that committed, and the guard
//     then read `false` while the spinner was on screen. Measured in #1956: with
//     the render-phase write five taps dispatched four navigations, with the
//     effect they dispatch one.
//
// A ref, not state, for the same reason as before: the guard is read during the
// NEXT click, hundreds of milliseconds later, and re-rendering the control to
// store a boolean it does not display would be a second render per navigation
// for nothing.

/** Every pending affordance in the app carries this one marker. */
export const NAV_PENDING_TESTID = "nav-link-pending";

/**
 * The spinner itself. `size` is a Tailwind size pair because the icon slot it
 * replaces differs per surface (a 20px nav row icon, a 16px chevron).
 */
function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <IconLoader2
      data-testid={NAV_PENDING_TESTID}
      aria-hidden
      className={`${className} shrink-0 animate-spin motion-reduce:animate-none`}
      stroke={1.75}
    />
  );
}

/**
 * Icon-slot treatment: the resting icon, replaced in place by the spinner.
 * Nothing shifts because the two occupy the same box.
 */
export function PendingIconSlot({
  pending,
  icon,
  size,
}: {
  pending: boolean;
  icon: ReactNode;
  size?: string;
}) {
  return pending ? <Spinner className={size} /> : <>{icon}</>;
}

/**
 * Overlay treatment for a control whose only slot is its own label. The label
 * keeps its box and stays legible at reduced opacity; the spinner sits over it.
 */
export function PendingOverlay({
  pending,
  children,
  size = "h-4 w-4",
  className = "gap-2",
}: {
  pending: boolean;
  children: ReactNode;
  size?: string;
  /** Layout for the wrapper, which only exists while pending. */
  className?: string;
}) {
  if (!pending) return <>{children}</>;
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <span className="opacity-30">{children}</span>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <Spinner className={size} />
      </span>
    </span>
  );
}

/**
 * The overlay treatment as ONE serializable component: `children` is ordinary
 * `ReactNode`, not a render prop, so a Server Component can render it.
 *
 * That distinction is load-bearing, not stylistic. `PendingLink` below takes a
 * function for `children` — which React cannot pass across the server/client
 * boundary, so a server-rendered pager (`app/(app)/settings/audit`,
 * `app/(app)/settings/notify-log`) throws at render if it reaches for it. Those
 * are text-shaped controls that want the overlay and nothing else, so this is
 * the shape they take.
 */
export function PendingTextLink({
  href,
  label,
  className,
  testId,
  children,
}: {
  href: AppRoute;
  label: string;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <PendingLink
      href={href}
      label={label}
      className={className}
      testId={testId}
    >
      {(pending) => (
        <PendingOverlay pending={pending}>{children}</PendingOverlay>
      )}
    </PendingLink>
  );
}

/**
 * A `<Link>` that answers the tap. `children` is a render prop so the control
 * decides where its pending state paints; the repeat-tap guard and the named
 * `role="status"` announcement come from here, identically for every caller.
 *
 * A render prop cannot cross the server/client boundary — a Server Component
 * reaching for this gets "Functions cannot be passed directly to Client
 * Components" at render time. Use `PendingTextLink` above from a server page.
 */
export default function PendingLink({
  href,
  label,
  className,
  current = false,
  ariaCurrent,
  testId,
  title,
  scroll,
  ariaExpanded,
  onClick,
  children,
}: {
  href: AppRoute;
  /** The control's own name — what the pending state announces. */
  label: string;
  className?: string;
  /** Renders `aria-current="page"` when this control is the page being viewed. */
  current?: boolean;
  /** Exact current-state token for a registered navigation adapter. */
  ariaCurrent?: "page" | "true" | "location";
  testId?: string;
  title?: string;
  /** Passed straight to `<Link>` — the timeline's filter links suppress scroll. */
  scroll?: boolean;
  /**
   * `aria-expanded` for a link-shaped disclosure (#2657's month fold headers).
   * Supported on `role="link"`, unlike `aria-pressed`.
   */
  ariaExpanded?: boolean;
  /**
   * The caller's own click side effect. It runs ONLY for a click this component
   * lets through — a repeat tap on a pending control is absorbed before it, so
   * a caller that records scroll position (TimelineFilterLink) does not record
   * it twice for one navigation.
   */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: (pending: boolean) => ReactNode;
}) {
  const pending = useRef(false);
  const report = useCallback((p: boolean) => {
    pending.current = p;
  }, []);
  return (
    <Link
      href={href}
      aria-current={ariaCurrent ?? (current ? "page" : undefined)}
      aria-expanded={ariaExpanded}
      data-testid={testId}
      title={title}
      scroll={scroll}
      className={className}
      onClick={(e) => {
        if (
          isDuplicateNavClick({
            pending: pending.current,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            button: e.button,
            target: e.currentTarget.getAttribute("target"),
          })
        ) {
          // `<Link>` runs this handler first and stands down on a prevented
          // default, so this drops the repeat without touching the navigation
          // already running.
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      <PendingLinkStatus label={label} report={report}>
        {children}
      </PendingLinkStatus>
    </Link>
  );
}

// Rendered INSIDE the <Link> — the only place `useLinkStatus` resolves to a
// link's own transition.
function PendingLinkStatus({
  label,
  report,
  children,
}: {
  label: string;
  report: (pending: boolean) => void;
  children: (pending: boolean) => ReactNode;
}) {
  const { pending } = useLinkStatus();
  useEffect(() => {
    report(pending);
  }, [pending, report]);
  return (
    <>
      {children(pending)}
      {pending && (
        // Named, not just spun: a screen reader hears which control is loading.
        <span role="status" className="sr-only">
          Opening {label}
        </span>
      )}
    </>
  );
}
