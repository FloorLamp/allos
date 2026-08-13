"use client";

import Link, { useLinkStatus } from "next/link";
import { IconLoader2 } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { isDuplicateNavClick } from "@/lib/nav-click";
import type { AppRoute } from "@/lib/hrefs";

// A navigation row that ANSWERS THE TAP (issue #1956).
//
// The measurement that produced this: enter at `/`, wait for a sidebar link to
// be visible, then tap. The tap is intercepted (`defaultPrevented === true`),
// the App Router requests the destination's RSC payload ~20ms later and has a
// 200 back inside 100ms — and then the screen does not change for 0.3s on an
// idle box and multiple seconds on a loaded one. `(app)` deliberately ships no
// `loading.tsx` (app/(app)/layout.tsx explains why — issue #530), so the router
// transition has no Suspense boundary to reveal: React renders the whole
// destination before swapping, and the old page stays visible and fully
// interactive the entire time. Nothing about the app says "I heard you".
//
// The reading a person takes from that is "the app is frozen", so they tap
// again — and a second tap dispatches a SECOND navigation that throws away the
// render already in flight. At a tap-a-second cadence against a destination that
// takes about a second to render, the navigation can be restarted indefinitely.
// That is why the original report measured 5–12 taps: the taps were the reason
// it never landed, not evidence that it never would.
//
// So this component owes two things, and one alone is not enough:
//
//   1. IMMEDIATE FEEDBACK. `useLinkStatus()` reports THIS link's transition, and
//      it works with no `loading.tsx` anywhere — that is precisely what Next
//      added it for. The status flips in the same commit that starts the
//      navigation, so the row shows a spinner in the icon's own slot (no layout
//      shift) from the first frame after the tap.
//   2. NO RESTART. While pending, a further plain tap on the same row is
//      suppressed instead of re-navigating. The pure rule (lib/nav-click.ts)
//      keeps cmd/ctrl/shift/alt-click and middle-click working, because those
//      mean "open it beside this page", not "go there again".
//
// Together those close the reported window rather than narrowing it: there is no
// state in which tapping a nav row produces no feedback. Before the router
// mounts, `<Link>` does not intercept at all (it returns early on a null router,
// so no `preventDefault` runs) and the anchor's real `href` performs an ordinary
// browser navigation; after it mounts, the tap flips this row to pending. What
// this does NOT do is make the destination render faster — that cost is real and
// is now visible instead of silent.
//
// `useLinkStatus` only resolves inside a `<Link>` subtree, so the pending state
// is read by the child rendered below and handed back up through a ref for the
// click guard. A ref, not state: the guard is read during the NEXT click, hundreds
// of milliseconds later, and re-rendering the whole row to store a boolean the
// row does not display would be a second render per navigation for nothing.
//
// The hand-back happens in an EFFECT, and that is load-bearing — writing the ref
// during render looks tighter and does not work. `useLinkStatus` is backed by
// `useOptimistic`, so React renders this subtree speculatively both with and
// without the optimistic value; a render-phase write therefore records whichever
// pass ran last rather than the one that committed, and the guard read `false`
// while the spinner was on screen. Measured: with the render-phase write the
// repeat taps still dispatched four navigations; with the effect they dispatch
// one. An effect is not a delay worth worrying about here — it flushes in the
// same frame, and the tap it has to absorb comes hundreds of milliseconds later.
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
  const pending = useRef(false);
  const report = useCallback((p: boolean) => {
    pending.current = p;
  }, []);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      data-testid={testId}
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
        }
      }}
    >
      <NavLinkStatus icon={icon} label={label} report={report} />
      {children}
    </Link>
  );
}

// Rendered INSIDE the <Link> — that is the only place useLinkStatus resolves to
// a link's own transition.
function NavLinkStatus({
  icon,
  label,
  report,
}: {
  icon: ReactNode;
  label: string;
  report: (pending: boolean) => void;
}) {
  const { pending } = useLinkStatus();
  useEffect(() => {
    report(pending);
  }, [pending, report]);
  if (!pending) return <>{icon}</>;
  return (
    <>
      <IconLoader2
        data-testid="nav-link-pending"
        aria-hidden
        className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none"
        stroke={1.75}
      />
      {/* Named, not just spun: a screen reader hears which row is loading. */}
      <span role="status" className="sr-only">
        Opening {label}
      </span>
    </>
  );
}
