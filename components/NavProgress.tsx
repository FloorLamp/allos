"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  getNavProgress,
  getServerNavProgress,
  retryNavProgress,
  subscribeNavProgress,
} from "@/lib/nav-progress";

// Display the shared progress state without replacing the usable page beneath it.
export default function NavProgress() {
  const phase = useSyncExternalStore(
    subscribeNavProgress,
    getNavProgress,
    getServerNavProgress
  );
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
          className="flex max-w-[min(26rem,calc(100vw-1.5rem))] items-center gap-3 rounded-lg border border-black/10 bg-surface/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm dark:border-white/10"
        >
          <span>{"Couldn't load — check your connection."}</span>
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
