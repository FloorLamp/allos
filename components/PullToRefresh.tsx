"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconRefresh } from "@tabler/icons-react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import {
  classifyPull,
  indicatorPresentation,
  shouldRefresh,
  type PullState,
} from "@/lib/pull-to-refresh";

// Overscroll pull-to-refresh, STANDALONE PWA ONLY (issue #1428, section B).
//
// Installed to the home screen there is no URL bar and therefore no refresh
// control, so a stale page has no recovery gesture. In a browser tab there
// already is one — the browser's — and Chrome-Android has its own native
// overscroll refresh, so a second one here would fight it. Hence the hard gate on
// `matchMedia("(display-mode: standalone)")`: this listens to nothing at all in a
// tab.
//
// The decision (at the top? far enough? downward? vertical?) is the pure
// `classifyPull` in lib/pull-to-refresh.ts, and so is the indicator's position,
// opacity and rotation (`indicatorPresentation`); this file owns only the DOM.
// Keeping the style decision pure is what makes it testable at all: the
// standalone gate below means no browser test ever sees this render.
//
// `router.refresh()` is the whole refresh: the app has no client cache to
// invalidate, so re-running the Server Components IS the fresh page. This is one
// of the few refreshes that survived the #1473 sweep — it answers a user GESTURE,
// not an awaited Server Action, so there is no action response to carry a fresh
// tree (docs/internals/server-action-refresh.md).
//
// `data-state` / `data-refreshes` on the indicator are the observable contract —
// they are what the e2e spec asserts against, since "did router.refresh() get
// called" is otherwise invisible from the outside. `data-refreshes` counts
// exactly the calls, so a spec can prove a mid-page pull triggered NOTHING.
export default function PullToRefresh() {
  const router = useRouter();
  const reduceMotion = usePrefersReducedMotion();
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<PullState>({ kind: "idle" });
  const [refreshes, setRefreshes] = useState(0);
  const [pending, startTransition] = useTransition();
  // Gesture origin. A ref, not state: touchmove fires at frame rate and must not
  // re-render on every sample beyond the indicator's own state.
  const start = useRef<{ y: number; x: number; scrollY: number } | null>(null);

  // Standalone only. Read after mount (SSR can't know), and subscribed: iOS can
  // flip display-mode when a page is opened from the installed app.
  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    setEnabled(mq.matches);
    const on = () => setEnabled(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Keep the overscroll inside the page so the gesture can't chain out to the
    // shell (and, on the platforms that still have one, can't double up with a
    // native pull). Scoped to the time this component is active, and restored on
    // unmount rather than left on the element.
    const root = document.documentElement;
    const prev = root.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = "contain";

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      start.current = { y: t.clientY, x: t.clientX, scrollY: window.scrollY };
      setState({ kind: "idle" });
    };
    const onMove = (e: TouchEvent) => {
      const origin = start.current;
      const t = e.touches[0];
      if (!origin || !t) return;
      setState(
        classifyPull({
          startScrollY: origin.scrollY,
          scrollY: window.scrollY,
          deltaY: t.clientY - origin.y,
          deltaX: t.clientX - origin.x,
        })
      );
    };
    const onEnd = () => {
      start.current = null;
      setState((current) => {
        if (shouldRefresh(current)) {
          setRefreshes((n) => n + 1);
          startTransition(() => router.refresh());
        }
        return { kind: "idle" };
      });
    };

    // Passive: the gesture never calls preventDefault (overscroll-behavior above
    // is what contains it), so the listeners must not block scrolling.
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
      root.style.overscrollBehaviorY = prev;
    };
  }, [enabled, router]);

  if (!enabled) return null;

  const { translateY, opacity, rotation } = indicatorPresentation(
    state,
    pending,
    reduceMotion
  );

  return (
    <div
      data-testid="pull-to-refresh"
      data-state={pending ? "refreshing" : state.kind}
      data-refreshes={refreshes}
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex justify-center print:hidden"
      style={{
        // Transform + opacity only — never layout. Both numbers, and the badge's
        // rotation below, come from the pure `indicatorPresentation`.
        transform: `translateY(${translateY}px)`,
        opacity,
      }}
    >
      <span
        className="mt-[max(0.5rem,env(safe-area-inset-top))] flex h-9 w-9 items-center justify-center rounded-full border border-black/10 bg-white shadow-md dark:border-white/10 dark:bg-ink-850"
        style={{ transform: `rotate(${rotation}deg)` }}
      >
        <IconRefresh
          className={`h-5 w-5 ${
            state.kind === "armed" || pending
              ? "text-brand-600 dark:text-brand-400"
              : "text-slate-400"
          }`}
          stroke={2}
        />
      </span>
    </div>
  );
}
