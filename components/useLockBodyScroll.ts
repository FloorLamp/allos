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
// Because measured, it is not one. With the body's overflow hidden and nothing
// else done, opening a dialog on a long desktop page scrolled the document from
// 0 to 1511 and a wheel over the scrim moved it another 256 — the page sliding
// around behind the surface that supposedly owns the viewport, which is the
// exact defect #2774 was filed about. The overflow alone stops a TOUCH drag from
// chaining and stops very little else.
//
// It also throws the reader away. Making the viewport unscrollable means the
// place they were reading is not restored by anything; they close the dialog
// somewhere other than where they opened it.
//
// So the FIRST holder PARKS the page: the body goes `position: fixed` with its
// top offset by the current scroll, which pins every pixel where it was and
// leaves nothing for a wheel, a focus, or a drag to scroll. The LAST holder puts
// the offset back and restores the scroll. e2e/dialog-convergence.spec.ts and its
// mobile sibling fail without this — that is what it is for, and the version of
// this file that skipped it is what they were run against.
//
// The offset lives here, next to the DOM it describes, and it is captured once
// per LOCK rather than once per holder: a second surface opening over the first
// must not re-read a scroll position that is already parked at 0.
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
