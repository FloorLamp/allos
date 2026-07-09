"use client";

import { useEffect } from "react";

// Lock the page behind a full-screen surface while `active`: without it,
// (over)scroll chains to the document and the covered page drifts around
// underneath.
export function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}
