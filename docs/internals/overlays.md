# Overlays: one motion/gesture system, three dismissal contracts

Status: shipped (issues #1425, #1469; the decision rule is #1428's owner
comment)

The app has four edge-anchored overlay surfaces. They look and move as one
system and they resolve the same gesture to different outcomes — on purpose. This file is the reasoning behind that split, because "unify the
overlays" is a tempting cleanup that would break the one part that must not be
unified.

## The four surfaces

| Surface                             | Anchor | Lifecycle     | The swipe resolves to               |
| ----------------------------------- | ------ | ------------- | ----------------------------------- |
| `components/BottomSheet.tsx`        | bottom | transactional | **discard** (dismiss, nothing kept) |
| `components/MobileNav.tsx` drawer   | left   | transient     | **close**                           |
| `components/ActivityOverlay.tsx`    | bottom | **session**   | **minimize** — never discard        |
| `components/ProfileIdentityBar.tsx` | top    | transient     | **close**                           |

The profile switcher (#1801) is the only TOP-anchored panel: it drops from the
identity bar in the phone's top bar, so the target appears where the finger
already is, and it retreats upward through the bar it came from. A bottom sheet
would have sent the thumb to the opposite end of the screen from the control
that opened it. It shares everything else — the scrim, the `--overlay-ms`
token pair, `useOverlayDrag` (whose axis/sign table gained the `up` row), and
the drag handle, mounted at the panel's BOTTOM edge because that is the edge
facing the reader.

The dock is the one that matters. A live workout runs for an hour, survives
navigation as the minimized bar, and "away" means STILL RUNNING. Wiring its
swipe to `onClose` would make an in-progress session silently discardable by a
stray flick — the destructive-gesture class this app refuses (which is also why
swipe-to-complete on dose/finding rows was rejected outright in #1425).

So the dock's drag is wired to `onMinimize` and is **disabled entirely** when
there is no minimize to reach (a retro log/edit): it never falls back to a
discard.

The same reasoning applies to the affordance that OPENS the editor (#1893). A
minimized session's elapsed timer ticks off `liveStartEpoch`, and `openLive()`
used to re-stamp it unconditionally — so the bolt, the palette's live action,
the Training Log aside, and the routine card each said "Start workout" mid-workout
and, when tapped, reset the running clock and dropped the sets already logged.
A stray flick can't discard a session, but a deliberate tap on a mislabelled
button could. All four surfaces now render one derivation
(`workoutOffer`, `lib/workout-offer.ts`): with a session live they read "Resume
workout" and reopen the docked session with its epoch untouched, and both
`openLive`/`openSession` enforce that internally so a stale caller can't stomp
it either. See [stateful affordances](./stateful-affordances.md).

## What IS shared

`components/overlay/` — the one import an overlay surface needs:

- **`useDragGesture`** — the ONE recognizer, over the pure `lib/gesture.ts`
  (axis lock → directed travel → distance-or-flick). Consumers supply the
  outcome; that callback is the only place the three surfaces differ.
- **`useOverlayDrag`** — panel drag-to-resolve: finger-following, release
  settle, and the keyframe/inline-transform handshake (below).
- **`OverlayDragHandle` + `tokens.ts`** — the affordance (a 40×6 bar inside a
  64×24 hit target), the scrim tint, panel radius/elevation/safe-area padding.
- **`overlayMotionClass()`** (from `lib/motion.ts`) — the enter/exit classes
  over ONE duration + easing pair, declared once as `--overlay-ms` /
  `--overlay-ease-enter` / `--overlay-ease-exit` in `app/globals.css`.

Before this, the drawer ran at 220ms, the sheet at 240ms, and the dock had no
animation at all; the drawer's scrim was a different tint with an extra blur.
That is the "hand-mirrored second engine" shape at the presentation layer.

### The one deliberate exception: the dock does not slide on mount

The dock takes every primitive above except the enter animation, and the reason
is worth keeping. Its panel is a full-height (`min-h-full`) child of its own
scroll container, so sliding it in changes that container's scroll extent for
the length of the animation and flips its scrollbar on and off. The width
changes with it and the activity form re-wraps: a browser test caught the
date/duration row landing 132px apart mid-enter (`e2e/entry-ergonomics.spec.ts`,
the #188 layout assertion). Suppressing the scrollbar for that window only
traded the glitch for 240ms in which the app's most complex form could not
scroll.

A mount animation would also be inconsistent here in a way it is not on a sheet:
minimizing HIDES this element rather than unmounting it (the rest timer has to
keep running), so a restore could never replay the slide. The dock arrives
instantly, on purpose — the convergence it owes is the scrim, chrome, handle,
recognizer and reduced-motion posture, all of which it takes.

## Load-bearing details

**The keyframe/inline-transform handshake.** A running CSS animation OUTRANKS
inline style. A panel that is both class-animated and finger-dragged therefore
ignores the drag and snaps back. `useOverlayDrag` reports `suppressMotion` the
moment a drag claims the panel; the consumer stops emitting the motion class,
and the panel's transform is the hook's alone from then on (including its exit,
run as an inline transition). The latch does not release while that panel is
alive — re-adding the enter class after a cancelled drag would replay the whole
slide-up on a panel that is already sitting still.

**The latch's scope is the PANEL, and only the panel** (#2725). Two corollaries,
both of which were wrong first and composed into one symptom — drag a sheet
closed on a phone and the screen holds dark.

_It expires when the panel unmounts._ The rationale above is a claim about one
DOM element, and `usePresence` destroys that element between opens: a remounted
panel has no inline transform to fight and is owed its slide. Scoping the latch
to the COMPONENT instead was invisible only while every consumer unmounted with
its panel — but the quick-log sheet's `BottomSheet` is rendered unconditionally
by `MobileNav`, and the quick-entry host retains its form after close, so those
instances never unmount and one cancelled 30px drag muted that sheet's
animations for the page's whole life. Consumers whose panel unmounts pass
`panelMounted` (their `usePresence` `mounted`); the dock passes none, because a
minimize parks its element rather than destroying it and its `commitSettle:
"rest"` clears the latch itself.

_It never reaches the scrim._ The backdrop carries no inline transform — nothing
ever writes one — so there is no handshake to honour and gating it only cost the
exit fade. `BottomSheet` used to route both classes through the latch; the
drawer and the switcher always animated their scrim unconditionally, and that is
now the one shape. The fade is what says a close is progressing: without it a
drag-dismissed sheet leaves a full-opacity `dark:bg-black/70` scrim over the
viewport until the presence timer blinks it out, and anything that delays that
timer stretches the hold.

**Pull-to-refresh stands down while an overlay is up** (#2725). `PullToRefresh`
listens at the window, so it sees touches inside overlays too, and a sheet's
drag-dismiss is downward, starts at the top of the page behind and travels well
past the arming distance — an armed pull by every test the classifier had.
Installed as a PWA that fired a whole-page `router.refresh()` inside the sheet's
exit window. `classifyPull` now takes `overlayOpen`, read once at `touchstart`
(the gesture dismisses the overlay it began in, so a mid-gesture re-read would
see none and re-arm).

The measure is **body scroll lock, and only that** (`overlayOwnsViewport` in
`lib/pull-to-refresh.ts`). `useLockBodyScroll` is the only writer of
`body.style.overflow`, and its callers are exactly the surfaces that own the
vertical drag: every downward-capable recognizer in the app runs under a locked
body, and the lock is a document-level fact, so it covers a drag begun on a
sheet's scrim too.

It deliberately does **not** ask "is a modal open". That was the first version —
added for four surfaces that never lock (`ModalShell` and its consumers,
`MergeConflictDialog`, `PhotoGallery`, `FitnessTestTimer`) — and it was a second
bug rather than a fix: none of the four has a touch gesture, so none can produce
the drag being refused, and `e2e/dirty-form-refresh.mobile.spec.ts` already pins
that a pull STILL refreshes while a record form in a `ModalShell` holds unsaved
input (#1878: a refresh the user asked for is never deferred, and installed there
is no other way to ask). "Is a modal open" is a question about ATTENTION; this
one is about who owns the DRAG. A new fact belongs in it only if it names a
surface that owns the gesture, and it owes the module a test in both directions.

**`commitSettle: "away" | "rest"`.** A sheet is going away, so it finishes its
travel while the consumer unmounts it. The dock is being PARKED — the same
element stays mounted with a live workout inside it and is merely hidden — so it
returns to its resting transform immediately. Animating it "away" would animate
something already `display: none`, and leaving the transform behind would
restore the panel translated off the bottom of the screen.

**Touch events, not Pointer Events.** Chromium fires `pointercancel` — and stops
sending `pointermove` — the moment its own scroll recognizer takes over, which
on a scrollable page happens after ONE move sample even on a purely horizontal
drag. A pointer-based recognizer therefore never gets to decide anything. Touch
events keep flowing, which lets our axis lock do the arbitration. Consequence,
accepted: these are touch gestures only; the tap/click affordance beside each
one is the pointer route.

**`overscroll-behavior-x: contain`** on `html`/`body`. Without it a horizontal
drag the page cannot scroll CHAINS to the browser's in-page history navigation:
the swipe goes "back" instead and the gesture appears to do nothing. Inner
horizontal scrollers are unaffected. (Caveat: this governs the browser's
overscroll gesture, not the platform's — an iOS Safari tab keeps its system
edge-swipe-back; installed to the home screen there is none.)

**Every gesture has a control beside it.** The drawer keeps its hamburger, the
sheet its backdrop tap and Escape, the dock its minimize button, the Timeline
its prev/next arrows — built from the SAME `timelineDayHref` destinations the
swipe uses, so the two can never disagree about which day is next. A gesture is
invisible, undiscoverable, and unavailable to a keyboard or a screen reader; it
is never the only way to do anything.

## The guard

`lib/__tests__/overlay-motion-chokepoint.test.ts` fails CI when:

1. a converged overlay surface stops consuming `components/overlay`;
2. a NEW full-viewport portal overlay is neither converged nor classified as a
   different anatomy (centred dialogs/popovers are scoped out of #1469, each
   recorded with a justification);
3. an overlay surface hand-rolls a slide (raw transform/transition/keyframe);
4. an `.overlay-*` class name is written anywhere but `lib/motion.ts`;
5. a second raw drag recognizer appears (allowlisted: pull-to-refresh, which
   asks a different question and has its own pure classifier; the image cropper,
   whose drag manipulates content rather than the overlay).

`lib/__tests__/motion-tokens.test.ts` pins the CSS duration/easing to the JS
ones — the number exists in both because one times the paint and the other times
the unmount, and a stylesheet that outlives its JS duration leaves a frozen
panel on screen.

## Testing gestures

`e2e/helpers.ts` has `touchSwipe` (real Chromium touch input via CDP —
Playwright's `touchscreen` only taps, and `page.mouse` produces pointer events
these gestures ignore) and `centerOf`, which waits for the element to STOP
MOVING before measuring. That settling is not a nicety: every overlay arrives on
a 240ms slide, and a `boundingBox()` taken mid-animation sends the touch to a
position the panel has already left — the gesture lands on some other element
and the test fails having done nothing at all.
