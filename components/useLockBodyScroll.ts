"use client";

import { useEffect } from "react";
import {
  acquireScrollLock,
  EMPTY_SCROLL_LOCK,
  isScrollLocked,
  releaseScrollLock,
  type ScrollLockState,
} from "@/lib/scroll-lock";

// Lock the page behind a full-screen surface while `active`: without it,
// (over)scroll chains to the document and the covered page drifts around
// underneath. Since #2774 every converged dialog holds one too, which is what
// retires that drift for the whole class rather than for four surfaces.
//
// The DOM half only. Who is holding and whether that means locked is
// lib/scroll-lock.ts — reference-counted, order-blind, and tested in both
// closing orders there. Restoring to "" rather than to a captured value is safe
// because this hook is the app's only writer of the body's INLINE overflow — the
// invariant components/PullToRefresh.tsx's `bodyScrollLocked` already leans on —
// so there is never a foreign value to preserve.
let lock: ScrollLockState = EMPTY_SCROLL_LOCK;

export function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lock = acquireScrollLock(lock);
    document.body.style.overflow = "hidden";
    return () => {
      lock = releaseScrollLock(lock);
      if (!isScrollLocked(lock)) document.body.style.overflow = "";
    };
  }, [active]);
}
