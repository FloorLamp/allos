"use client";

import { useEffect } from "react";
import {
  acquireScrollLock,
  EMPTY_SCROLL_LOCK,
  isScrollLocked,
  releaseScrollLock,
  type ScrollLockState,
} from "@/lib/scroll-lock";

// Hold the page still behind a full-screen surface while `active`.
//
// The DOM half only. WHO is holding and whether that means locked is
// lib/scroll-lock.ts — reference-counted, order-blind, and tested in both
// closing orders there.
//
// ── Why `overflow: hidden` alone is not the lock (issue #2774) ───────────────
//
// It stops the chaining, and it also THROWS THE READER TO THE TOP OF THE PAGE.
// Making the viewport non-scrollable clamps its scroll offset to 0, so a dialog
// opened two thousand pixels down jumps the page behind it to the very top, and
// closing it leaves the reader there — which is the same complaint #2774 filed
// about the chaining ("on release the page is somewhere other than where the
// dialog was opened from"), arriving by the other road. It was survivable while
// seven drag-owning surfaces held this lock; it is not survivable now that every
// record dialog in the app does.
//
// So the FIRST holder also parks the page: the body goes `position: fixed` with
// its top offset by the current scroll, which keeps every pixel exactly where it
// was, and the LAST holder puts the offset back and restores the scroll. The
// captured offset lives here, next to the DOM it describes, and it is captured
// once per LOCK rather than once per holder — a second surface opening over the
// first must not re-read a scroll position that is already parked at 0.
//
// Restoring to "" rather than to captured values is safe because this hook is the
// app's only writer of these inline body styles — the invariant
// components/PullToRefresh.tsx's `bodyScrollLocked` already leans on (it reads
// exactly `document.body.style.overflow`, which is still the lock's signature).
let lock: ScrollLockState = EMPTY_SCROLL_LOCK;
let parkedScrollY = 0;

function park() {
  parkedScrollY = window.scrollY;
  const { style } = document.body;
  style.overflow = "hidden";
  style.position = "fixed";
  style.top = `-${parkedScrollY}px`;
  style.left = "0";
  style.right = "0";
}

function unpark() {
  const { style } = document.body;
  style.overflow = "";
  style.position = "";
  style.top = "";
  style.left = "";
  style.right = "";
  window.scrollTo(0, parkedScrollY);
}

export function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const wasLocked = isScrollLocked(lock);
    lock = acquireScrollLock(lock);
    if (!wasLocked) park();
    return () => {
      lock = releaseScrollLock(lock);
      if (!isScrollLocked(lock)) unpark();
    };
  }, [active]);
}
