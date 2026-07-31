"use client";

import { OVERLAY_DRAG_HANDLE_BAR, OVERLAY_DRAG_HANDLE_HIT } from "./tokens";

// The drag affordance shared by every draggable overlay (issue #1469).
//
// It is `aria-hidden` and carries no role: the gesture is a SHORTCUT, never the
// only way out. Every surface that renders this also renders a real, focusable
// control with the same outcome — the sheet's backdrop tap and Escape, the
// dock's minimize button — so a viewer using a keyboard, a switch, or a screen
// reader loses nothing. A handle that announced itself as a button you cannot
// press with a keyboard would be worse than a decorative one.
export default function OverlayDragHandle({
  handleRef,
  testId = "sheet-drag-handle",
  className = "",
}: {
  // Where the recognizer attaches (see useOverlayDrag's `grabRef`).
  handleRef?: React.RefObject<HTMLDivElement | null>;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      ref={handleRef}
      data-testid={testId}
      aria-hidden
      className={`${OVERLAY_DRAG_HANDLE_HIT} ${className}`}
    >
      <span className={OVERLAY_DRAG_HANDLE_BAR} />
    </div>
  );
}
