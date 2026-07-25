// The overlay primitive set (issue #1469) — the ONE import an overlay surface
// needs.
//
// Three bottom/edge-anchored overlays exist: the mobile nav drawer
// (components/MobileNav.tsx), BottomSheet (components/BottomSheet.tsx), and the
// activity dock's expanded editor (components/ActivityOverlay.tsx). Their
// DISMISSAL CONTRACTS differ by design and must keep differing — the #1428
// owner decision: a sheet is transactional, so swipe-down DISCARDS it; the dock
// is a session, so swipe-down MINIMIZES it and it never becomes discardable.
// Their gesture mechanics and visual language, on the other hand, are one
// system, and this module is that system:
//
//   * useDragGesture   — the ONE recognizer (axis lock, directed travel,
//                        distance-or-flick), over the pure lib/gesture.ts.
//   * useOverlayDrag   — panel drag-to-resolve: finger-following, release
//                        settle, keyframe handshake. The OUTCOME is the
//                        consumer's single `onOutcome` callback; that is the
//                        only place the three surfaces are allowed to differ.
//   * OverlayDragHandle + tokens — the affordance, scrim, and panel chrome.
//   * overlayMotionClass (re-exported from lib/motion.ts) — the enter/exit
//     classes over the one duration+easing token pair.
//
// lib/__tests__/overlay-motion-chokepoint.test.ts fails CI if an overlay
// component hand-rolls any of this instead.

export { useDragGesture, type DragGestureOptions } from "./useDragGesture";
export { useOverlayDrag, type OverlayDragOptions } from "./useOverlayDrag";
export { default as OverlayDragHandle } from "./OverlayDragHandle";
export {
  OVERLAY_SCRIM,
  OVERLAY_SCRIM_TINT,
  OVERLAY_SCRIM_TINT_SM,
  OVERLAY_PANEL_ELEVATION,
  OVERLAY_PANEL_BORDER,
  OVERLAY_PANEL_RADIUS_BOTTOM,
  OVERLAY_SAFE_BOTTOM,
  OVERLAY_DRAG_HANDLE_HIT,
  OVERLAY_DRAG_HANDLE_BAR,
} from "./tokens";
export {
  overlayMotionClass,
  OVERLAY_MOTION_MS,
  type OverlayAnchor,
} from "@/lib/motion";
