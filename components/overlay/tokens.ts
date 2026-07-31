// The overlay VISUAL vocabulary (issue #1469).
//
// The drawer, BottomSheet and the activity dock are three different lifecycles
// (#1428: transactional vs session) but ONE visual language. Before this each
// one carried its own hand-written scrim opacity, its own radius, its own
// safe-area padding and its own drag-handle geometry — the same divergence the
// motion tokens fixed one layer up, in Tailwind class strings instead of CSS.
//
// These are plain class-string constants rather than components because the
// three surfaces compose them differently (a left-anchored drawer has no top
// radius; the dock is full-bleed below `sm`). Sharing the VALUES is the point;
// sharing a wrapper element would force three anatomies into one box.
//
// Anything that animates lives in lib/motion.ts + app/globals.css instead — a
// token here never carries a duration.

// The backdrop behind any overlay. One treatment: the drawer used to add a
// `backdrop-blur-sm` that the sheet did not, which made the same dimming read as
// two different depths depending on which surface opened it. The blur went
// rather than spread — it is a full-viewport GPU cost on the app's most
// frequently opened surface, for an effect the opacity already delivers.
export const OVERLAY_SCRIM_TINT = "bg-slate-900/40 dark:bg-black/70";
export const OVERLAY_SCRIM = `absolute inset-0 ${OVERLAY_SCRIM_TINT}`;
// The same tint from `sm` up only. The activity dock's editor is FULL-BLEED on a
// phone — below `sm` the container is the panel's own background and there is no
// scrim to tint — so it needs the breakpoint-prefixed spelling. Written out
// rather than composed because Tailwind's scanner reads literals: a computed
// `sm:${OVERLAY_SCRIM_TINT}` would never be generated.
export const OVERLAY_SCRIM_TINT_SM = "sm:bg-slate-900/40 sm:dark:bg-black/70";

// Panel chrome. Elevation and border are shared; each surface adds its own
// anchor-appropriate radius from the pair below.
export const OVERLAY_PANEL_ELEVATION = "shadow-2xl";
export const OVERLAY_PANEL_BORDER = "border-black/10 dark:border-white/10";
// Bottom-anchored: rounded where it meets the page, square where it meets the
// screen edge. From `sm` up a sheet floats, so it rounds all the way around.
export const OVERLAY_PANEL_RADIUS_BOTTOM = "rounded-t-2xl sm:rounded-2xl";
// The panel's own bottom padding must clear the home indicator; `max()` means it
// is a plain 1rem on hardware with no inset.
export const OVERLAY_SAFE_BOTTOM = "pb-[max(1rem,env(safe-area-inset-bottom))]";

// The drag handle. Two pieces on purpose: a 40x6 BAR you can see, inside a
// 64x24 HIT TARGET you can actually land a thumb on — the visible affordance is
// far too thin to be the touch target, and every hand-rolled sheet gets this
// wrong the same way.
//
// `touch-none` (touch-action: none) is the ONE place in the app that takes an
// axis away from the browser. It is safe exactly here: the handle has nothing to
// scroll, so the browser's scroll arbitration has nothing to arbitrate, and
// without it a downward drag starting on the handle would be stolen by the
// panel's own scroller before the recognizer saw a second sample.
export const OVERLAY_DRAG_HANDLE_HIT =
  "mx-auto flex h-6 w-16 shrink-0 touch-none items-center justify-center";
export const OVERLAY_DRAG_HANDLE_BAR =
  "h-1.5 w-10 rounded-full bg-slate-300 dark:bg-ink-700";

// ── The bottom edge (issue #1520, part B) ────────────────────────────────────
//
// FOUR fixed surfaces converge on the phone's bottom edge and, before this,
// each one hand-wrote its own inset and picked its own z-index in isolation:
// the workout dock (full-width, `z-40`), the offline-queue pill (bottom-left,
// `z-[100]`), that queue's error panel (bottom-right, `z-[101]`) and the toast
// stack (bottom-right, `z-[100]`). Since three of them anchored to `bottom:
// max(1rem, safe-area)` regardless of the dock, a toast raised during a live
// workout landed ON TOP of the dock — the notice covered the "still working
// out?" bar it was competing with for the same 60px of screen.
//
// The convergence is deliberately NOT a slot manager. It is (a) documented
// stacking ORDER, (b) shared class strings, and (c) ONE CSS custom property
// naming how much of the bottom edge is already claimed:
//
//   LAYER 0 (base) — the workout dock. It OWNS the edge: full-width, flush to
//     `bottom-0`, and it CLAIMS its height into `--bottom-edge-offset` while
//     mounted (useBottomEdgeClaim). It is session state, not a notice, so it
//     never moves out of another surface's way.
//   LAYER 1 (notices) — transient things that stack ABOVE the dock rather than
//     over it: the toast stack and the offline pill.
//   LAYER 2 (alerts) — the offline error panel, which out-ranks a toast because
//     it reports a write that did not land.
//   (Modals/sheets/confirms sit above all of this — see BottomSheet's note.)
//
// The offset var defaults to `0px`, so with no dock present every one of these
// surfaces resolves to EXACTLY the inset it had before. Only ONE claimant exists
// (the dock); a second would need to sum or max them, which is the point at which
// this stops being constants and starts being the slot manager #1520 rejected.
//
// Import path note: the toast stack and the offline queue live in the ROOT layout,
// above the activity editor's tree, and they need only these constants — so they
// import this module DIRECTLY rather than through components/overlay's barrel,
// which would pull the gesture recognizer and drag handle into the app's very
// first client chunk (including /login). The dock, already inside that tree, uses
// the barrel because it also needs the claim hook.
export const BOTTOM_EDGE_OFFSET_VAR = "--bottom-edge-offset";
// Written out (not composed from the constant above) because Tailwind's scanner
// reads LITERALS — a class string interpolating the var name above would never be
// generated. (Do not spell such an interpolation out even in a comment here: the
// scanner reads comments too, and would emit it as a broken rule.)
export const BOTTOM_EDGE_NOTICE_BOTTOM =
  "bottom-[calc(var(--bottom-edge-offset,0px)+max(1rem,env(safe-area-inset-bottom)))]";
export const BOTTOM_EDGE_GUTTER_RIGHT =
  "right-[max(1rem,env(safe-area-inset-right))]";
export const BOTTOM_EDGE_GUTTER_LEFT =
  "left-[max(1rem,env(safe-area-inset-left))]";
export const BOTTOM_EDGE_DOCK_LAYER = "z-40";
export const BOTTOM_EDGE_NOTICE_LAYER = "z-[100]";
export const BOTTOM_EDGE_ALERT_LAYER = "z-[101]";
