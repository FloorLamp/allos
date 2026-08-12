"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoReloadPlan,
  AUTO_RELOAD_KEY,
  AUTO_RELOAD_UNNAMED_TARGET,
  nextAutoReloadGuard,
  parseAutoReloadGuard,
  RESUME_EDITOR_KEY,
  showsManualUpdateNotice,
  UPDATE_TAKEN_KEY,
  type AutoReloadVerdict,
} from "@/lib/sw-update";
import {
  captureUnsavedWork,
  hasUnrecoverableWork,
  subscribeUnsavedWork,
} from "@/lib/offline/unsaved-work";
import {
  isStaleBuild,
  registerUpdateReload,
  setManualUpdateFallback,
  subscribeStaleBuild,
} from "./update-reload-channel";
import { useLatestRef } from "./useLatestRef";

// The tab that takes the deploy by itself (#2471) — the wiring half. Every decision
// it makes is `autoReloadPlan` in lib/sw-update.ts; this file owns listeners, the
// two markers, and the ordering that makes the reload provably lossless.
//
// THE ORDERING IS THE FEATURE, and it is fixed:
//
//   1. the plan says `reload` (see lib/sw-update.ts for what that costs to earn);
//   2. every recoverable draft is FLUSHED and settled — never a debounce still in
//      flight, because a reload over an unflushed keystroke is worse than the four
//      taps this replaces;
//   3. the resume and toast markers are written;
//   4. the ration is spent, recorded BEFORE the attempt exactly as the crash path
//      records its own (an unrecorded attempt is an unguarded one);
//   5. and only then the reload, through the registrar's own handshake path — the
//      same one the bar's tap uses, so the tab lands on the waiting build and the
//      #1806 only-the-asking-tab rule still holds.
//
// Any step that throws or refuses stops the sequence. Nothing is reloaded, the
// manual affordance renders, and the user is exactly where this issue found them.
//
// WHY THIS CANNOT COMPOUND WITH THE CRASH PATH. `app/global-error.tsx` rations its
// own hard reload under `SKEW_RECOVERY_KEY`; this rations its own under
// `AUTO_RELOAD_KEY`. Neither clears nor refills the other, and neither is cleared by
// a page that loads successfully, so the worst case of a genuinely broken deploy is
// the SUM of two rations of one — two automatic reloads, then the banner, then
// nothing. That bound is asserted directly in lib/__tests__/auto-reload.test.ts.

/** Events that mean a human is touching the page right now. */
const INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
  "touchmove",
  "scroll",
] as const;

/**
 * How often the verdict is re-evaluated while a deploy is outstanding.
 *
 * A quiet window is the absence of events, so nothing will wake this up when the
 * user stops touching the page — the tick is what notices the silence. It runs only
 * while there is a deploy to answer, so an ordinary tab schedules nothing.
 */
const EVALUATE_MS = 500;

export function useAutoUpdateReload({
  pending,
  targetSha,
  commitMessage,
  machineryReload,
}: {
  /** `resolveUpdateState().pending`, already narrowed to the offer case. */
  pending: boolean;
  /** The build the server named, when it named one. */
  targetSha: string | null;
  commitMessage: string | null;
  /**
   * The registrar's own reload: SKIP_WAITING handshake or plain, `requestedRef` set
   * so this tab is the one that asked. Called last and never by anything else here.
   */
  machineryReload: () => void;
}): AutoReloadVerdict {
  const [verdict, setVerdict] = useState<AutoReloadVerdict>({ action: "none" });
  // Set the moment the sequence STARTS, not when it commits: the flush is awaited, so
  // two evaluation ticks 500ms apart could otherwise both enter it and write two
  // markers over each other. Cleared again only on a refusal, so a committed sequence
  // stays closed while the navigation is dispatched.
  const takingRef = useRef(false);
  // A capture that refused (IndexedDB denied, a flush that threw). The work is not
  // durable, so this tab never auto-reloads again this episode — it holds, and the
  // manual affordance is the honest remedy.
  const [captureRefused, setCaptureRefused] = useState(false);
  // When the input listeners attached. Silence before this is ignorance, not quiet —
  // see INPUT_QUIET_MS. 0 until the effect below runs, which the gate reads as "not
  // watching yet" and therefore never as quiet.
  const watchingSinceRef = useRef(0);
  const lastInputRef = useRef(0);
  const lastSubmitRef = useRef(0);
  // The evaluation tick and the reload routine both outlive any one render, so they
  // read the latest COMMITTED props rather than a render's snapshot.
  const pendingRef = useLatestRef(pending);
  const targetShaRef = useLatestRef(targetSha);
  const commitMessageRef = useLatestRef(commitMessage);
  const machineryReloadRef = useLatestRef(machineryReload);

  // Input activity, watched at the document in the capture phase so nothing can stop
  // it from being seen. Passive: this only ever reads a timestamp.
  useEffect(() => {
    const touched = () => {
      lastInputRef.current = Date.now();
    };
    const submitted = () => {
      lastSubmitRef.current = Date.now();
    };
    for (const type of INPUT_EVENTS) {
      document.addEventListener(type, touched, {
        capture: true,
        passive: true,
      });
    }
    document.addEventListener("submit", submitted, true);
    watchingSinceRef.current = Date.now();
    return () => {
      for (const type of INPUT_EVENTS) {
        document.removeEventListener(type, touched, true);
      }
      document.removeEventListener("submit", submitted, true);
    };
  }, []);

  /**
   * Steps 2–5. Returns false when it refused, so the caller — automatic tick or a
   * user's tap on a surviving affordance — knows the tab is still where it was.
   */
  const takeUpdate = useCallback(async (): Promise<boolean> => {
    if (takingRef.current) return true; // already running; the navigation is coming
    takingRef.current = true;
    const target = targetShaRef.current;

    // 2. Everything recoverable becomes durable first.
    const captured = await captureUnsavedWork();
    if (!captured.ok) {
      takingRef.current = false;
      setCaptureRefused(true);
      return false;
    }
    // Re-check after the await: a flush is fast but not instant, and a form that
    // started holding unrecoverable input in the gap must still stop this.
    if (hasUnrecoverableWork()) {
      takingRef.current = false;
      return false;
    }

    // 3. + 4. Both markers and the ration, all in one guarded write. Storage denied
    // means we cannot prove the reload is safe OR bound it, so we do not take it.
    try {
      if (captured.resume) {
        sessionStorage.setItem(
          RESUME_EDITOR_KEY,
          JSON.stringify({ ...captured.resume, at: Date.now() })
        );
      } else {
        sessionStorage.removeItem(RESUME_EDITOR_KEY);
      }
      sessionStorage.setItem(
        UPDATE_TAKEN_KEY,
        JSON.stringify({
          sha: target,
          commitMessage: commitMessageRef.current,
        })
      );
      const now = Date.now();
      sessionStorage.setItem(
        AUTO_RELOAD_KEY,
        JSON.stringify(
          nextAutoReloadGuard(
            parseAutoReloadGuard(sessionStorage.getItem(AUTO_RELOAD_KEY)),
            target ?? AUTO_RELOAD_UNNAMED_TARGET,
            now
          )
        )
      );
    } catch {
      takingRef.current = false;
      setCaptureRefused(true);
      return false;
    }

    // 5. The one reload path.
    machineryReloadRef.current();
    return true;
  }, [targetShaRef, commitMessageRef, machineryReloadRef]);

  // Publish the shared routine for the surviving manual affordances, so a tap
  // reloads through exactly the same flush-then-marker sequence.
  useEffect(() => {
    registerUpdateReload(takeUpdate);
    return () => registerUpdateReload(null);
  }, [takeUpdate]);

  useEffect(() => {
    let disposed = false;

    const evaluate = () => {
      if (disposed || takingRef.current) return;
      const next = autoReloadPlan({
        staleBuild: isStaleBuild(),
        pending: pendingRef.current,
        targetSha: targetShaRef.current,
        unrecoverableWork: hasUnrecoverableWork() || captureRefused,
        hidden:
          typeof document !== "undefined"
            ? document.visibilityState === "hidden"
            : false,
        watchingSince: watchingSinceRef.current,
        lastInputAt: lastInputRef.current,
        lastSubmitAt: lastSubmitRef.current,
        guard: readGuard(targetShaRef.current ?? AUTO_RELOAD_UNNAMED_TARGET),
        now: Date.now(),
      });
      setVerdict((prev) => (sameVerdict(prev, next) ? prev : next));
      if (next.action === "reload") void takeUpdate();
    };

    evaluate();
    const timer = setInterval(evaluate, EVALUATE_MS);
    const unsubscribeWork = subscribeUnsavedWork(evaluate);
    const unsubscribeStale = subscribeStaleBuild(evaluate);
    document.addEventListener("visibilitychange", evaluate);
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribeWork();
      unsubscribeStale();
      document.removeEventListener("visibilitychange", evaluate);
    };
  }, [
    pending,
    targetSha,
    captureRefused,
    takeUpdate,
    pendingRef,
    targetShaRef,
  ]);

  // The manual affordances render off ONE answer, wherever they are in the tree.
  const fallback = showsManualUpdateNotice(verdict);
  useEffect(() => {
    setManualUpdateFallback(fallback);
  }, [fallback]);

  return verdict;
}

function readGuard(target: string) {
  try {
    return parseAutoReloadGuard(sessionStorage.getItem(AUTO_RELOAD_KEY));
  } catch {
    // No storage means no guard, and an unrationed automatic reload is exactly the
    // loop the ration exists to prevent — so answer "spent for this target" rather
    // than "clear", and let the manual affordance be the remedy.
    return { targets: [target], at: Date.now() };
  }
}

function sameVerdict(a: AutoReloadVerdict, b: AutoReloadVerdict): boolean {
  if (a.action !== b.action) return false;
  if (a.action === "reload" && b.action === "reload")
    return a.target === b.target;
  if (a.action === "wait" && b.action === "wait") return a.reason === b.reason;
  if (a.action === "hold" && b.action === "hold") return a.reason === b.reason;
  return true;
}
