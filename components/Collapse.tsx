"use client";

import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { CONTINUITY_MOTIONS, MICRO_MOTION_EASE } from "@/lib/micro-motion";

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
// This is the app's BUTTON disclosure — a control with `aria-expanded` over a panel.
// A `<details>` reaches for components/Disclosure.tsx instead, because this grid
// technique cannot animate one (its contents are not rendered while it is closed, so
// opening has no earlier height to travel from). Both spend the SAME continuity token
// (#3676's `disclose`) on the same ease, so there is one duration and one feel for
// every region in the app that expands in place.

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
          : `grid-template-rows ${CONTINUITY_MOTIONS.disclose.ms}ms ${MICRO_MOTION_EASE}`,
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
