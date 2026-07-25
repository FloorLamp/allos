"use client";

import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { MOTION_MS } from "@/lib/motion";

// Height-animated open/close for an inline region (issue #1416, section F) — the
// shared collapse the app's expanding panels can use instead of snapping.
//
// Implemented with the CSS grid `0fr → 1fr` technique rather than a measured
// pixel height: no ResizeObserver, no JS-written inline height, and it handles
// content whose height changes WHILE open (a form that grows a validation
// message) for free. The animating row is a single element; the child is clipped
// by `overflow: hidden` on the inner wrapper.
//
// The collapsed region stays MOUNTED (that is what lets it animate), but it is
// `aria-hidden` and `visibility: hidden`, which takes its controls out of both
// the accessibility tree and the tab order — a collapsed panel whose buttons are
// still tabbable is a keyboard trap you cannot see.
//
// #1413's attention-strip collapse is the first intended tenant; anything else
// that expands in place should reach for this rather than a second copy.

export default function Collapse({
  open,
  children,
  className = "",
  testId,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();
  return (
    <div
      data-testid={testId}
      data-open={open ? "true" : "false"}
      className={`grid ${className}`}
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        transition: reduceMotion
          ? undefined
          : `grid-template-rows ${MOTION_MS.collapse}ms ease-out`,
      }}
    >
      <div
        className="overflow-hidden"
        style={{ visibility: open ? undefined : "hidden" }}
        aria-hidden={open ? undefined : true}
      >
        {children}
      </div>
    </div>
  );
}
