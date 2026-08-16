"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import {
  getNavProgress,
  getServerNavProgress,
  retryNavProgress,
  settleNavProgress,
  subscribeNavProgress,
} from "@/lib/nav-progress";

// The slow-navigation floor, and the ask a failed navigation resolves into
// (issue #2869).
//
// #1956 gave nav rows a spinner in their own slot, and #2869 extended that to
// every control shaped like a button. But most navigation in this app is not
// button-shaped: a card, a table row, a drill-down, a link inside a sentence,
// the timeline's day swipe. Those have nowhere to put a spinner, and inventing
// somewhere for each of them is how an app ends up with six pending styles. So
// they share one floor: a thin line at the top edge, on screen only while a
// navigation is genuinely slow.
//
// Three deliberate properties:
//
//   • IT IS NOT ON THE FAST PATH. Nothing paints until the navigation has been
//     running past NAV_PROGRESS_THRESHOLD_MS. On a normal connection the
//     destination commits well inside that and this component renders `null`
//     from start to finish, so there is no flash on every tap.
//   • IT DOES NOT ANIMATE A FRACTION. There is no progress to report — `(app)`
//     has no Suspense boundaries to count (#530) and the server does not stream
//     a percentage — so a bar creeping toward 90% would be an invented number.
//     It is present or absent, and the `role="status"` line says which.
//   • IT DOES NOT REPLACE THE PAGE. The page under it is the one that was
//     already working, still fully interactive. That is the whole argument of
//     the failure state below.
//
// Completion is observed at COMMIT rather than from a hook, because Next has no
// router-level "transition ended" event: `onRouterTransitionStart` fires the
// start (instrumentation-client.ts) and the destination landing is what changes
// `usePathname()`/`useSearchParams()` here. The one case that leaves is a
// navigation to the URL already on screen, which cannot move either of them —
// it resolves on the next navigation and paints nothing meanwhile.
export default function NavProgress() {
  const phase = useSyncExternalStore(
    subscribeNavProgress,
    getNavProgress,
    getServerNavProgress
  );
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // The destination committed.
  useEffect(() => {
    settleNavProgress();
  }, [pathname, search]);

  // The connection came back on its own. A held navigation resumes without
  // anyone having to find the Retry — the tap they already made is the tap that
  // lands, which is the same promise #1956 made about repeat taps.
  useEffect(() => {
    const resume = () => retryNavProgress();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, []);

  if (phase === "idle" || phase === "waiting") return null;

  if (phase === "failed") {
    return (
      // Sits at the notice layer (the ladder in components/overlay/tokens.ts):
      // above the sticky shell chrome, below modals and confirms.
      <div className="fixed inset-x-0 top-0 z-100 flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div
          role="status"
          data-testid="nav-load-failed"
          className="flex max-w-[min(26rem,calc(100vw-1.5rem))] items-center gap-3 rounded-lg border border-black/10 bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm dark:border-white/10 dark:bg-ink-850/95"
        >
          <span>{"Couldn't load — check your connection"}</span>
          <button
            type="button"
            data-testid="nav-load-retry"
            className="btn-ghost shrink-0 text-sm"
            onClick={() => retryNavProgress()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        aria-hidden
        data-testid="nav-progress"
        className="pointer-events-none fixed inset-x-0 top-0 z-100 h-0.5 bg-brand-500 dark:bg-brand-400"
      />
      <span role="status" data-testid="nav-progress-status" className="sr-only">
        Still loading
      </span>
    </>
  );
}
