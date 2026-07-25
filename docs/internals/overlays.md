# Overlays: one motion/gesture system, three dismissal contracts

Status: shipped (issues #1425, #1469; the decision rule is #1428's owner comment)

The app has three bottom/edge-anchored overlay surfaces. They look and move as one
system and they resolve the same gesture to three different outcomes — on purpose.
This file is the reasoning behind that split, because "unify the overlays" is a
tempting cleanup that would break the one part that must not be unified.

## The three surfaces

| Surface                           | Lifecycle     | Swipe-down/left resolves to         |
| --------------------------------- | ------------- | ----------------------------------- |
| `components/BottomSheet.tsx`      | transactional | **discard** (dismiss, nothing kept) |
| `components/MobileNav.tsx` drawer | transient     | **close**                           |
| `components/ActivityOverlay.tsx`  | **session**   | **minimize** — never discard        |

The dock is the one that matters. A live workout runs for an hour, survives
navigation as the minimized bar, and "away" means STILL RUNNING. Wiring its swipe
to `onClose` would make an in-progress session silently discardable by a stray
flick — the destructive-gesture class this app refuses (which is also why
swipe-to-complete on dose/finding rows was rejected outright in #1425).

So the dock's drag is wired to `onMinimize` and is **disabled entirely** when there
is no minimize to reach (a retro log/edit): it never falls back to a discard.

## What IS shared

`components/overlay/` — the one import an overlay surface needs:

- **`useDragGesture`** — the ONE recognizer, over the pure `lib/gesture.ts`
  (axis lock → directed travel → distance-or-flick). Consumers supply the
  outcome; that callback is the only place the three surfaces differ.
- **`useOverlayDrag`** — panel drag-to-resolve: finger-following, release settle,
  and the keyframe/inline-transform handshake (below).
- **`OverlayDragHandle` + `tokens.ts`** — the affordance (a 40×6 bar inside a
  64×24 hit target), the scrim tint, panel radius/elevation/safe-area padding.
- **`overlayMotionClass()`** (from `lib/motion.ts`) — the enter/exit classes over
  ONE duration + easing pair, declared once as `--overlay-ms` /
  `--overlay-ease-enter` / `--overlay-ease-exit` in `app/globals.css`.

Before this, the drawer ran at 220ms, the sheet at 240ms, and the dock had no
animation at all; the drawer's scrim was a different tint with an extra blur. That
is the "hand-mirrored second engine" shape at the presentation layer.

### The one deliberate exception: the dock does not slide on mount

The dock takes every primitive above except the enter animation, and the reason is
worth keeping. Its panel is a full-height (`min-h-full`) child of its own scroll
container, so sliding it in changes that container's scroll extent for the length
of the animation and flips its scrollbar on and off. The width changes with it and
the activity form re-wraps: a browser test caught the date/duration row landing
132px apart mid-enter (`e2e/entry-ergonomics.spec.ts`, the #188 layout assertion).
Suppressing the scrollbar for that window only traded the glitch for 240ms in which
the app's most complex form could not scroll.

A mount animation would also be inconsistent here in a way it is not on a sheet:
minimizing HIDES this element rather than unmounting it (the rest timer has to keep
running), so a restore could never replay the slide. The dock arrives instantly, on
purpose — the convergence it owes is the scrim, chrome, handle, recognizer and
reduced-motion posture, all of which it takes.

## Load-bearing details

**The keyframe/inline-transform handshake.** A running CSS animation OUTRANKS
inline style. A panel that is both class-animated and finger-dragged therefore
ignores the drag and snaps back. `useOverlayDrag` reports `suppressMotion` the
moment a drag claims the panel; the consumer stops emitting the motion class for
the rest of that mount, and the panel's transform is the hook's alone from then on
(including its exit, run as an inline transition). The latch never releases while
mounted — re-adding the enter class after a cancelled drag would replay the whole
slide-up on a panel that is already sitting still.

**`commitSettle: "away" | "rest"`.** A sheet is going away, so it finishes its
travel while the consumer unmounts it. The dock is being PARKED — the same element
stays mounted with a live workout inside it and is merely hidden — so it returns to
its resting transform immediately. Animating it "away" would animate something
already `display: none`, and leaving the transform behind would restore the panel
translated off the bottom of the screen.

**Touch events, not Pointer Events.** Chromium fires `pointercancel` — and stops
sending `pointermove` — the moment its own scroll recognizer takes over, which on
a scrollable page happens after ONE move sample even on a purely horizontal drag.
A pointer-based recognizer therefore never gets to decide anything. Touch events
keep flowing, which lets our axis lock do the arbitration. Consequence, accepted:
these are touch gestures only; the tap/click affordance beside each one is the
pointer route.

**`overscroll-behavior-x: contain`** on `html`/`body`. Without it a horizontal
drag the page cannot scroll CHAINS to the browser's in-page history navigation:
the swipe goes "back" instead and the gesture appears to do nothing. Inner
horizontal scrollers are unaffected. (Caveat: this governs the browser's
overscroll gesture, not the platform's — an iOS Safari tab keeps its system
edge-swipe-back; installed to the home screen there is none.)

**Every gesture has a control beside it.** The drawer keeps its hamburger, the
sheet its backdrop tap and Escape, the dock its minimize button, the Timeline its
prev/next arrows — built from the SAME `timelineDayHref` destinations the swipe
uses, so the two can never disagree about which day is next. A gesture is
invisible, undiscoverable, and unavailable to a keyboard or a screen reader; it is
never the only way to do anything.

## The guard

`lib/__tests__/overlay-motion-chokepoint.test.ts` fails CI when:

1. a converged overlay surface stops consuming `components/overlay`;
2. a NEW full-viewport portal overlay is neither converged nor classified as a
   different anatomy (centred dialogs/popovers are scoped out of #1469, each
   recorded with a justification);
3. an overlay surface hand-rolls a slide (raw transform/transition/keyframe);
4. an `.overlay-*` class name is written anywhere but `lib/motion.ts`;
5. a second raw drag recognizer appears (allowlisted: pull-to-refresh, which asks
   a different question and has its own pure classifier; the image cropper, whose
   drag manipulates content rather than the overlay).

`lib/__tests__/motion-tokens.test.ts` pins the CSS duration/easing to the JS ones
— the number exists in both because one times the paint and the other times the
unmount, and a stylesheet that outlives its JS duration leaves a frozen panel on
screen.

## Testing gestures

`e2e/helpers.ts` has `touchSwipe` (real Chromium touch input via CDP — Playwright's
`touchscreen` only taps, and `page.mouse` produces pointer events these gestures
ignore) and `centerOf`, which waits for the element to STOP MOVING before
measuring. That settling is not a nicety: every overlay arrives on a 240ms slide,
and a `boundingBox()` taken mid-animation sends the touch to a position the panel
has already left — the gesture lands on some other element and the test fails
having done nothing at all.
