"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconRefresh } from "@tabler/icons-react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useHaptics } from "./useHaptics";
import { useStandaloneDisplayMode } from "./useStandaloneDisplayMode";
import {
  classifyPull,
  indicatorPresentation,
  overlayOwnsViewport,
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
// ── Standing down for an overlay (#2725) ─────────────────────────────────────
//
// The listeners are on the WINDOW, so they see every touch in the app including
// the ones inside a sheet, drawer or modal. A bottom sheet's drag-dismiss is
// downward, starts from a page sitting at its top and travels far past the
// arming distance, so `classifyPull` — which asks only about direction, travel
// and scroll position — armed on it: in the installed app every drag-dismiss
// fired a whole-page `router.refresh()` at the exact moment the sheet was
// closing. (`touch-action: none` on the drag handle stops the browser's scroll
// arbitration, not event delivery, so these listeners still saw every move.)
//
// The DOM READING behind that clause; the decision itself is the pure
// `overlayOwnsViewport` in lib/pull-to-refresh.ts, which is where the reasoning
// for it lives. This file supplies the one fact and nothing else.
//
// `useLockBodyScroll` is the only writer of `body.style.overflow` in the app, so
// reading the inline style — rather than a computed value that a stylesheet
// could also produce — asks exactly "did an overlay lock this?".
function bodyScrollLocked(): boolean {
  return document.body.style.overflow === "hidden";
}

const renderedAt = () =>
  document.querySelector("main")!.getAttribute("data-rendered-at")!;
// `data-state` / `data-refreshes` on the indicator are the observable contract —
// they are what the e2e spec asserts against, since "did router.refresh() get
// called" is otherwise invisible from the outside. `data-refreshes` counts
// exactly the calls, so a spec can prove a mid-page pull triggered NOTHING.
export default function PullToRefresh() {
  const router = useRouter();
  const reduceMotion = usePrefersReducedMotion();
  const haptic = useHaptics();
  const enabled = useStandaloneDisplayMode();
  const [state, setState] = useState<PullState>({ kind: "idle" });
  const [refreshes, setRefreshes] = useState(0);
  const [pending, startTransition] = useTransition();
  const beforeRefresh = useRef<string | null>(null);
  // Gesture origin. A ref, not state: touchmove fires at frame rate and must not
  // re-render on every sample beyond the indicator's own state.
  const start = useRef<{
    y: number;
    x: number;
    scrollY: number;
    overlayOpen: boolean;
  } | null>(null);
  // Was the gesture ARMED at the last sample? Only the CROSSING gets a cue (#3699):
  // touchmove fires at frame rate, and a pull held just past the threshold would
  // otherwise buzz continuously. A ref rather than reading `state`, because the
  // listeners below are installed once and would close over a stale value — and a
  // check inside the `setState` updater would fire twice under React's development
  // double-invoke, which is a side effect an updater is not allowed to have.
  const armed = useRef(false);

  useEffect(() => {
    const before = beforeRefresh.current;
    if (pending || before === null) return;
    beforeRefresh.current = null;
    setState({ kind: renderedAt() !== before ? "updated" : "failed" });
  }, [pending]);
  useEffect(() => {
    if (state.kind !== "updated") return;
    const timer = window.setTimeout(() => setState({ kind: "idle" }), 1500);
    return () => window.clearTimeout(timer);
  }, [state.kind]);
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
      start.current = {
        y: t.clientY,
        x: t.clientX,
        scrollY: window.scrollY,
        overlayOpen: overlayOwnsViewport({
          bodyScrollLocked: bodyScrollLocked(),
        }),
      };
      setState({ kind: "idle" });
    };
    const onMove = (e: TouchEvent) => {
      const origin = start.current;
      const t = e.touches[0];
      if (!origin || !t) return;
      const next = classifyPull({
        overlayOpen: origin.overlayOpen,
        startScrollY: origin.scrollY,
        scrollY: window.scrollY,
        deltaY: t.clientY - origin.y,
        deltaX: t.clientX - origin.x,
      });
      // Past the threshold: letting go now refreshes. Today that is a purely visual
      // claim, and it is made while the finger is covering the indicator.
      if (next.kind === "armed" && !armed.current) haptic("select");
      armed.current = next.kind === "armed";
      setState(next);
    };
    const onEnd = () => {
      const refresh = armed.current;
      start.current = null;
      armed.current = false;
      setState({ kind: "idle" });
      if (!refresh) return;
      setRefreshes((n) => n + 1);
      beforeRefresh.current = renderedAt();
      startTransition(() => router.refresh());
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
  }, [enabled, router, haptic]);

  if (!enabled) return null;

  const { translateY, opacity, rotation, message } = indicatorPresentation(
    state,
    pending,
    reduceMotion
  );

  return (
    <div
      data-testid="pull-to-refresh"
      data-state={pending ? "refreshing" : state.kind}
      data-refreshes={refreshes}
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-90 flex justify-center print:hidden"
      style={{
        // Transform + opacity only — never layout. Both numbers, and the badge's
        // rotation below, come from the pure `indicatorPresentation`.
        transform: `translateY(${translateY}px)`,
        opacity,
      }}
    >
      <span
        className={`mt-[max(0.5rem,env(safe-area-inset-top))] flex h-9 items-center justify-center rounded-full border border-(--border) bg-surface shadow-md ${message ? "max-w-[calc(100vw-2rem)] gap-2 px-3 text-sm font-medium" : "w-9"}`}
      >
        <IconRefresh
          className={`h-5 w-5 ${
            state.kind === "armed" || pending
              ? "text-brand-600 dark:text-brand-400"
              : "text-slate-400"
          }`}
          stroke={2}
          style={{ transform: `rotate(${rotation}deg)` }}
          aria-hidden
        />
        {message}
      </span>
    </div>
  );
}
