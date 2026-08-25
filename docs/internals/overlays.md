# Overlays: one motion/gesture system, three dismissal contracts

Status: shipped (issues #1425, #1469; the decision rule is #1428's owner
comment)

The app has four edge-anchored overlay surfaces. They share one visual and
gesture system while preserving their different lifecycle outcomes.

## The four surfaces

| Surface                             | Anchor                            | Lifecycle     | Gesture outcome                     |
| ----------------------------------- | --------------------------------- | ------------- | ----------------------------------- |
| `components/BottomSheet.tsx`        | bottom                            | transactional | **discard** (dismiss, nothing kept) |
| `components/MobileNav.tsx` drawer   | left                              | transient     | **close**                           |
| `components/ActivityOverlay.tsx`    | bottom on phone, right on desktop | **session**   | **minimize** — never discard        |
| `components/ProfileIdentityBar.tsx` | top                               | transient     | **close**                           |

The profile switcher (#1801) is the only TOP-anchored panel: it drops from the
identity bar in the phone's top bar, so the target appears where the finger
already is, and it retreats upward through the bar it came from. A bottom sheet
would have sent the thumb to the opposite end of the screen from the control
that opened it. It shares everything else — the scrim, the `--overlay-ms`
token pair, `useOverlayDrag` (whose axis/sign table gained the `up` row), and
the drag handle, mounted at the panel's BOTTOM edge because that is the edge
facing the reader.

The activity workspace is the one that matters. A live workout runs for an
hour, survives navigation as the minimized bar, and "away" means STILL RUNNING.
On mobile it has one horizontal minimize bar. The bar is both a real button and
the drag handle, so touch, keyboard, and assistive technology all reach the same
action without a second affordance. Its downward drag is wired to `onMinimize`;
wiring it to `onClose` would make an in-progress session discardable. The
desktop drawer omits the bar; its backdrop remains the minimize affordance.

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

The quick-log consumer holds its own content geometry stable (#3675), without a
`BottomSheet` variant: it reserves the due-and-usual context slot before that
Server Action resolves and fixes the row list to the largest segment the active
profile can actually see. Both reserves remain inside BottomSheet's existing
content scroller. Segment switches, non-empty gathers, empty answers, and failed
gathers therefore leave the panel and its segment strip in place; only the
gathered section's declared opacity-only `arrive` receipt paints.

## Choosing a host for a new surface

One rule, so a new form does not pick its host by looking at whichever neighbour
it happened to open next to. Read down the left column; the first row that
describes the surface is the answer.

| The surface is…                                                          | Host                                                | Why                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a TRANSACTIONAL capture or decision — a record form, a picker, a confirm | `components/ModalShell.tsx` (the responsive dialog) | Sheet below `md`, centred card above, body locked, one scroll owner, declared size. Dismissal means discard.               |
| a SESSION that survives navigation — a live workout                      | `components/ActivityOverlay.tsx` (the dock)         | "Away" means still running. Its drag resolves to **minimize**; it must never become discardable.                           |
| a RARE-CADENCE page entry — lab results, imaging                         | `components/AddEntryPanel.tsx`                      | Inline in a reading column, modal in a hub rail (#1497). What "modal" renders as is the row above; the rule is unchanged.  |
| MENU or NAVIGATION                                                       | the sheet / `components/MobileNav.tsx` drawer       | Dismissal is close, nothing is lost, and the drawer owns the edge swipe.                                                   |
| ANCHORED to a control — a ⋯ menu, a date picker, a control's own detail  | `components/overlay/AnchoredPanel.tsx`              | A bottom action sheet below `md`, the trigger-anchored popover above it (#3374/#3376). One host decision, thirty surfaces. |

Two consequences worth stating outright, because both were decided rather than
discovered (#2774):

- **Sheets on phones, for every converged consumer.** An exception is an ANATOMY
  fact — a surface with no bottom edge to flick toward at any width — and it is
  RECORDED, not smuggled: it passes `presentation="centered"` and lands in
  `CENTERED_PRESENTATION` in the chokepoint test with its reason. The command
  palette (a search field over a result list) and the camera fallback (a live
  viewfinder) are the two. **"Not a sheet" is only half the argument**, and
  #3423 is the other half: it rules the bottom edge out, it never defended a
  floating CARD on a phone. So the palette also passes `fullScreenBelowMd`, and
  the same host fills the viewport below `md` — same portal, scrim, focus trap,
  scroll lock and Escape seam, same register entry. It is a GEOMETRY flag, not a
  fourth presentation.
- **Width is DECLARED, not styled.** `size: "sm" | "md" | "lg"`
  (`OVERLAY_PANEL_MAX_WIDTH`) replaced thirty per-host `max-w-*` overrides.
  Content stays intrinsic (#2014); this is the container half of that rule.

A dirty form gets one more thing for free: a dismissal — a flick, a scrim tap,
or **Escape** — routes through the app's `ConfirmDialog` when the hosted form
holds unsaved input. A clean form still dismisses in one gesture or one
keypress, which is what keeps the confirm from becoming a click-through.

**Escape was added to that list by an owner ruling (#3420), narrowing #2774.**
The original rule put Escape and the Close button on the unguarded path because
both are targeted actions on a named control, where a flick and a scrim tap are
the two a hand produces by accident. That still governs a dialog holding
**nothing** unsaved: Escape closes it outright, no prompt. It no longer governs
a dialog holding unsaved work — there, one keystroke destroyed exactly the
typing a scrim tap two pixels away would have asked about, and the dirty-form
registry already knew the difference. **The Close button is untouched** and
still closes without a prompt: it is the control the person aimed at, and a
confirm on it would be the ask-before-acting pattern the house grammar declines.

### Dialogs that do NOT live on the host (#3405)

**Convergence is the default.** A dialog belongs on
`components/ModalShell.tsx` unless it is named below with its reason. That is an
owner ruling, and the alternative was considered and declined: naming every
hostless dialog as sanctioned would have been nine exceptions to a rule with
about a dozen followers, which is not a convention — the next hand-rolled dialog
would have precedent to be the tenth.

Three converged when the ruling landed. `MergeConflictDialog` and
`PlateBuilderModal` were centred cards hand-copying the host's anatomy;
`FitnessCheckView`'s entry panel hand-rolled the whole of it, including a scroller
that had shipped without `overscroll-contain` — the #2774 defect, live, for as
long as the convergence has existed (#3421).

These are the current non-host rows. Some are genuine anatomy-driven exceptions
to the shared primitives; some have already converged onto
`components/overlay` rather than the dialog host. Primitive-first convergence
onto `ModalShell` or `components/overlay` stays the default.
`HOSTLESS_DIALOGS` (`scripts/dialog-census-core.ts`) is documentary input to
the detector, and `lib/__tests__/dialog-census.test.ts` keeps that input and
this table aligned.

| Dialog                                          | Why the shared host cannot serve it                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ImageCropper.tsx`                   | Opens **over** an already-open dialog (both profile-photo pickers are ModalShells), so it needs `z-120` — above the sheet's `z-60` and the toasts' `z-100` — and the host takes no stacking prop. Its pointer drag also manipulates CONTENT across the whole panel.                                                                                                                     |
| `components/photo/PhotoGallery.tsx`             | A full-bleed media viewer: black ground, image `object-contain` to the viewport edges, its own left/right paging. A titled `bg-surface` card with padding and a scroll owner is the wrong shape, and swipe-to-dismiss would fight the paging gesture.                                                                                                                                   |
| `components/activity-form/FitnessTestTimer.tsx` | Must survive being closed. Collapsing the takeover returns the viewer to the entry sheet **with the run still going**, and the host unmounts a dialog when it closes. It is also nested inside an already-scrimmed sheet, so it carries no scrim of its own.                                                                                                                            |
| `components/ActivityOverlay.tsx`                | Converged — onto `components/overlay`, not the dialog host. A session that survives navigation, whose drag resolves to **minimize** (#1469). The host is transactional; this is the row above it in the host table.                                                                                                                                                                     |
| `components/ProfileIdentityBar.tsx`             | Converged onto `components/overlay` the same way, TOP-anchored: the panel drops out of the identity bar and a swipe **up** retreats through it (#1801). A centred host has no anchor to drop from.                                                                                                                                                                                      |
| `components/MobileNav.tsx`                      | Converged onto `components/overlay` the same way, EDGE-anchored: the drawer travels in from the left screen edge and an edge swipe both opens it and retreats through it (#1416/#2746). A centred card has no edge to travel from. Found by ANATOMY, not by ARIA (#3445) — it carries no `role` and no `aria-modal`, which is a real gap and a separate question from where it renders. |

`components/MobileDetailPage.tsx` is **not on this table and not an exception**.
It is a full-page mobile takeover — it replaces the page rather than floating
over it, carries no scrim, and is dismissed by the back gesture the way a page
is. It leaves the dialog family by ANATOMY, so the census reports it under
`SCOPED OUT` rather than counting it as an exception to a rule it was never an
instance of.

**A recorded exception is about presentation, not about the a11y floor.**
`ActivityOverlay`, `ProfileIdentityBar` and the photo lightbox all take the
shared `useFocusTrap` — named rather than counted, so the claim stays checkable
against `npm run census:dialogs`, which prints "shared focus trap" against
exactly those three. The lightbox adopted it as part of this ruling: its Escape
lived on the panel's own `onKeyDown`, which fires only once focus is inside, and
nothing ever put it there — so Escape did nothing at all unless the viewer
happened to Tab first.

### The anchored panel forks at `md` (#3374 / #3376)

An anchored popover is a DESKTOP shape. It is right where a pointer is precise
and a page has room beside the control; it is wrong on a phone, where a 160px
panel of 32px rows hanging off a kebab is a context menu a finger cannot use.
Before this, thirty phone surfaces opened one — the ⋯ menu is the primary
per-row action affordance on the most phone-used screens — and every form's date
picker was a 288px desktop calendar.

`components/overlay/AnchoredPanel.tsx` is where that is decided, once:

- **below `md`** the content mounts in `components/BottomSheet.tsx`. A menu's
  dismissal IS discard, so it passes no `onGestureDismiss` guard and inherits
  the drag, the scrim, the scroll lock, the focus trap and the #3425 Escape
  seam unchanged.
- **from `md` up** it is the portaled `position: fixed` popover placed by
  `components/overlay/useAnchoredPopover.ts`, exactly as before.

The rules that make it one fork rather than thirty:

- **Content is authored once.** `children` is a function and the node it returns
  is mounted in exactly ONE host — never a `hidden md:` twin (#2305). A consumer
  passes items and an anchor; it says nothing about viewports.
- **The floor is met where a finger does the tapping.** `MENU_ITEM` rows are
  44px below `md`, 40px on a coarse pointer above it, and the compact 32px
  desktop row under a mouse. The two `md:` rules are keyed on mutually exclusive
  pointer media so neither depends on stylesheet order.
- **Focus returns to the trigger in both**, by different routes: the popover
  never takes focus, and the sheet's trap restores it.
- **Every anchored menu goes through it**, enforced by the chokepoint test's
  anchored-menu rule. `components/CompactDateMenu.tsx` is the one recorded
  exception — a phone-only two-or-three-option day switcher inline in a heading,
  already at the tap floor, where a modal sheet is a heavier answer than the
  question. `components/Combobox.tsx`'s listbox is NOT forked either, and for a
  different reason recorded in #3374: a listbox reads as part of its field on
  touch, so it is not a menu at all.

## What a dialog BODY renders

The table above says which host a surface gets. This says what goes INSIDE it,
and it is one sentence:

> **A dialog body renders content, never chrome** — no outer card, no duplicate
> heading, no own horizontal insets except a bleed that exactly matches the
> host's declared padding steps.

The host already draws the border, the radius, the padding, the title and the
Close control. A body that draws them again produces a bordered card floating
inside a bordered card, with the same sentence printed twice — which is what
the quick-entry measurements sheet did until #3361.

Three consequences, each one a real defect that shipped:

- **No outer card.** A body whose root carries the `card` utility, or a
  hand-rolled `rounded-xl` + `border` + `p-4`, is wearing standalone-page
  chrome inside a panel. A bare `space-y-*` root is the shape. Sub-cards INSIDE a body — the Vitals/Body group boxes, the
  per-row dose and practice cards, the routine-template picker — are deliberate
  grouping and stay; the rule is about the body's OWN outermost box.
- **No duplicate heading.** The host prints the title. If a body prints it too,
  one of the two must go — either the body drops its `<h2>` or the host hides
  its own (`titleHidden`). Prefer dropping the body's: the host's title is the
  dialog's accessible name and it stays in the same place on every surface.
- **A bleed steps where the PANEL steps.** A body that runs edge to edge (a
  sticky footer, a full-width list) counteracts the panel's padding with a
  negative margin, so the two must agree at every width. The dialog panel pads
  `px-4` and steps to `px-6` at **`md`**, so the bleed is `-mx-4 md:-mx-6` and
  every re-inset inside it is `px-4 md:px-6`. A bleed that stepped at `sm`
  over-pulled half a rem per side through the whole `sm`..`md` band, and the
  footer's edge sat past the panel's (#3361). The centred presentation steps at
  `sm` instead — read `panelShape` in `components/BottomSheet.tsx` rather than
  guessing, and match the presentation the body is actually mounted in.

  This rule governs INSETS ONLY, and the difference is load-bearing. A body's
  other responsive classes have no host counterpart to agree with, so they step
  where their own content wants. `ProtocolForm`'s sticky footer is the worked
  example and it looks like an oversight until you know why: it turns horizontal
  at `sm` (`sm:flex-row sm:justify-end`) while its padding steps at `md`
  (`md:px-6`). That is DELIBERATE — two buttons fit side by side from 640px, and
  the padding has to match the panel, which changes at 768px. Do not "tidy" the
  two onto one breakpoint; that would turn a correct mismatch into a real one.

The title gap has ONE owner: the host's content region (`mt-3`). A call site
that adds its own `mt-4` on top is not choosing a bigger gap, it is accreting
one — 28px under a dialog title, decided by nobody.

This is now true everywhere: no dialog body's outermost element carries a top
margin. Be careful reading the tree for a precedent, though — a `mt-4` on the
element BELOW a `<p className="mt-2">` description is a description-to-form gap,
not a title gap, and six dialogs legitimately have one.

The gap ABOVE a dialog FOOTER stays with the call site, and that is a decision
rather than the sweep running out of steam (#3401). The host draws no footer, so
there is no host counterpart for a footer's `mt-4` to agree with — it is content
rhythm, the same category as `ProtocolForm`'s `sm:flex-row` above, not chrome.
Three bodies do it today, all `mt-4 flex justify-end`, and all three are right.
Do not "finish the job" by hoisting that gap to the host.

### A form with two mounts uses an escape hatch, not a fifth spelling

Some forms are genuinely mounted both ways: a standalone card on a page AND a
body inside a dialog. Those take a prop that gates the card chrome, and several
already exist:

| Form                                                    | Prop           | Dialog value |
| ------------------------------------------------------- | -------------- | ------------ |
| `app/(app)/trends/MeasurementsQuickAdd.tsx`             | `presentation` | `"modal"`    |
| `app/(app)/encounters/EncounterForm.tsx`                | `embedded`     | `true`       |
| `app/(app)/encounters/AppointmentForm.tsx`              | `embedded`     | `true`       |
| `app/(app)/settings/profile/DietaryPreferencesForm.tsx` | `embedded`     | `true`       |
| `app/(app)/wellness/PracticeEditor.tsx`                 | `compact`      | `true`       |

Three spellings of one question, and they are staying that way — renaming
working props is churn, not convergence. **Copy one of these when a form gains
its second mount; do not invent a fifth.** And when a mount forgets to pass it,
the failure is silent and visual: the form simply falls back to its card
default and the double chrome appears inside the panel. That is exactly how
#3361's defect reached a phone.

A form with only ONE mount, and that mount a dialog, needs no hatch at all — it
just renders content. `InstrumentsView` and `SubstanceInstrumentsForm` each
carried a border wrapper with no page mount left to serve.

## What IS shared

`components/overlay/` — the one import an overlay surface needs:

- **`useDragGesture`** — the ONE recognizer, over the pure `lib/gesture.ts`
  (axis lock → directed travel → distance-or-flick). Consumers supply the
  outcome; that callback is the only place the three surfaces differ.
- **`useOverlayDrag`** — panel drag-to-resolve: finger-following, release
  settle, and the keyframe/inline-transform handshake (below).
- **`OverlayDragHandle` + `tokens.ts`** — the affordance (a 40×6 bar inside a
  64×44 hit target), the scrim tint, panel radius/elevation/safe-area padding.
- **`overlayMotionClass()`** (from `lib/motion.ts`) — the enter/exit classes
  over ONE duration + easing pair, declared once as `--overlay-ms` /
  `--overlay-ease-enter` / `--overlay-ease-exit` in `app/globals.css`.

Before this, the drawer ran at 220ms, the sheet at 240ms, and the dock had no
animation at all; the drawer's scrim was a different tint with an extra blur.
That is the "hand-mirrored second engine" shape at the presentation layer.

### The deliberate activity-workspace exceptions

The workspace shares the scrim, surface chrome, drag recognizer, and handle
geometry, but takes no enter animation. Its panel is a full-height
(`min-h-full`) child of its own scroll container, so sliding it in changes that
container's scroll extent for the length of the animation and flips its
scrollbar on and off. The width changes with it and the activity form re-wraps:
a browser test caught the date/duration row landing 132px apart mid-enter
(`e2e/entry-ergonomics.spec.ts`, the #188 layout assertion). Suppressing the
scrollbar for that window only traded the glitch for 240ms in which the app's
most complex form could not scroll.

A mount animation would also be inconsistent here in a way it is not on a sheet:
minimizing HIDES this element rather than unmounting it (the rest timer has to
keep running), so a restore could never replay the slide. The workspace arrives
instantly, on purpose.

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
`panelMounted` (their `usePresence` `mounted`); the activity workspace uses
`commitSettle: "rest"` because minimizing parks its panel instead.

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
travel while the consumer unmounts it. The activity workspace is being parked:
the same element stays mounted with a live workout inside it and is merely
hidden. It therefore returns to its resting transform before minimizing.

**Touch events, not Pointer Events.** Chromium fires `pointercancel` — and stops
sending `pointermove` — the moment its own scroll recognizer takes over, which
on a scrollable page happens after ONE move sample even on a purely horizontal
drag. A pointer-based recognizer therefore never gets to decide anything. Touch
events keep flowing, which lets our axis lock do the arbitration. Consequence,
accepted: these are touch gestures only; the tap/click affordance beside each
one is the pointer route.

**BottomSheet fixes body ownership at touch-start** (#3691). The handle always
owns a downward drag, whatever the content scroll position. A drag beginning in
the content owns dismissal only when every effective vertical scroll owner from
the touch origin through the sheet content was already at its top. That includes
intentional nested form scrollers with fixed action footers; beginning below any
owner's top belongs to native scrolling for the touch's entire lifecycle, even
if the scroll reaches zero before the finger lifts. The shared recognizer's
one-shot `canStart` admission expresses that boundary without preventing
default, re-reading mid-gesture, or interfering with taps and fields.

**`overscroll-behavior-x: contain`** on `html`/`body`. Without it a horizontal
drag the page cannot scroll CHAINS to the browser's in-page history navigation:
the swipe goes "back" instead and the gesture appears to do nothing. Inner
horizontal scrollers are unaffected. (Caveat: this governs the browser's
overscroll gesture, not the platform's — an iOS Safari tab keeps its system
edge-swipe-back; installed to the home screen there is none.)

**The drag handle's `touch-action: none` costs one tap** (#3262). It is the one
place in the app that takes an axis away from the browser, and it is still the
right call — without it the panel's own scroller steals a downward drag before
the recognizer sees a second sample. The price, measured rather than reasoned:
**Chromium suppresses the tap gesture of the first touch sequence after a drag
whose starting element forbade the drag's axis.** The touch events and the
touch-type PointerEvents still arrive; no `GestureTap` is produced, so no
`mousedown`, no `mouseup` and no `click` reaches the page at all. It is exactly
one sequence and roughly 300 ms wide, and the next tap always lands — which is
the whole of the user-visible symptom #3262 confirmed: after flicking a dirty
sheet and being asked to confirm, a tap that follows within a third of a second
does nothing, the dialog stays open, and nothing is ever discarded. `pan-x`
behaves the same way (it forbids the same axis); `pan-y`, `manipulation` and
`auto` do not, and all three would give the scroller back the drag. No JS can
see the suppression or clear it, so the app cannot work around it — the e2e
suite spends the sequence deliberately instead (`consumeSuppressedTap` in
`e2e/helpers.ts`, which carries the measurements). Re-derive any of this with
`node scripts/tap-suppression-probe.mjs`.

**Every gesture has a control path.** The drawer keeps its hamburger, the sheet
its backdrop tap and Escape, the activity handle is itself a button, and the
Timeline keeps its prev/next arrows — built from the SAME `timelineDayHref`
destinations the swipe uses, so the two can never disagree about which day is
next. A gesture is
invisible, undiscoverable, and unavailable to a keyboard or a screen reader; it
is never the only way to do anything.

## The guard

`lib/__tests__/overlay-motion-chokepoint.test.ts` fails CI when:

1. a converged overlay surface stops consuming `components/overlay`;
2. a NEW full-viewport overlay is neither converged nor classified as a
   different anatomy (centred dialogs/popovers are scoped out of #1469, each
   recorded with a justification). **Not just a portalled one** — the
   `createPortal` half of that test was dropped in #3405, because it is exactly
   why the guard could not see four of the nine hostless dialogs the census
   found. They render `fixed inset-0` inline, so they sat outside every rule here
   by construction. The stated cost of the widening: every `fixed inset-0`
   surface now answers to these rules and some legitimately should not — a
   full-bleed chart, a camera viewfinder — so expect recorded exceptions rather
   than reading the first wave as a regression;
3. an overlay surface hand-rolls a slide (raw transform/transition/keyframe);
4. an `.overlay-*` class name is written anywhere but `lib/motion.ts`;
5. a second raw drag recognizer appears (allowlisted: pull-to-refresh, which
   asks a different question and has its own pure classifier; the image cropper,
   whose drag manipulates content rather than the overlay);
6. a full-viewport overlay's own scroller does not contain its overscroll — the
   #2774 defect, where a drag the scroller declined chained out to the document
   and moved the page BEHIND the overlay;
7. a full-viewport dialog hosts a `<form>` without going through the converged
   host, or opts out of the phone sheet idiom without recording why;
8. a file positions a `role="menu"` panel itself instead of opening it through
   `components/overlay/AnchoredPanel.tsx` — the anchored-menu rule (#3374).
   `CompactDateMenu` is the one recorded exception. The scan reads the panel's
   WHOLE opening tag by brace depth rather than stopping at the next `>`: its
   first version stopped at an `onKeyDown={(event) => {` arrow and could not see
   `CompactDateMenu` at all, which is a green sweep that was never taken.
9. a consumer hands the host an `onClose` that does nothing (#3405 review). The
   host draws a real ✕, so a no-op handler makes it a control that lies — it
   takes the tap and ignores it, often two pixels from a Cancel button that is
   honestly `disabled`. A surface that must refuse dismissal for a moment (a
   write already in flight, which closing would not cancel) passes
   **`closeDisabled`**, which greys the control out and leaves Escape and the
   gestures on the consumer's own guard. The scan resolves the handler through
   its LOCAL BINDINGS rather than reading the attribute: the instance that
   produced this rule was spelled `const close = busy ? noop : onCancel` with
   `onClose={close}`, and a version of the scan that read the attribute text was
   green against it.

`lib/__tests__/scroll-lock.test.ts` pins the other half of #2774: the body-scroll
lock is reference-counted, so a dialog opened over an open sheet leaves the page
held until the LAST surface closes — in either closing order. The DOM-level stack
is pinned in `e2e/dialog-convergence.mobile.spec.ts`.

`lib/__tests__/motion-tokens.test.ts` pins the CSS duration/easing to the JS
ones — the number exists in both because one times the paint and the other times
the unmount, and a stylesheet that outlives its JS duration leaves a frozen
panel on screen.

### Censusing this family

Use `npm run census:dialogs` — not a grep — when you sweep the dialogs.

    npm run census:dialogs              # hosts, hosted, confirm callers, hostless
    npm run census:dialogs -- --hostless

Three earlier sweeps enumerated this family with a file-level
`grep -l 'ModalShell|BottomSheet'`. That asks whether a FILE mentions the string,
which is a cheaper question than whether a component USES the host, and it is
wrong in both directions: it counted `MergeConflictDialog` off a comment, and it
could not see any dialog that hand-rolls its own surface.
`scripts/dialog-census-core.ts`
matches on the import and on the rendered JSX instead.

**What "sees a hand-rolled dialog" means, stated so you can check it.** That
sentence was true of the over-match and only half true of the under-match until
#3445: the census asked whether a file spelled `role="dialog"`, `role="alertdialog"`
or `aria-modal`, so what it really reported was "hand-rolls a dialog **and
remembered the ARIA**" — the weaker claim, reading as the stronger one, in the
paragraph above. It now asks two questions and prints which one answered:

- **by ARIA** — the file declares a dialog: `role="dialog"` / `role="alertdialog"`
  (including a computed `role={danger ? "alertdialog" : "dialog"}`), `aria-modal`,
  or a native `<dialog>` element.
- **by ANATOMY** — the file declares nothing, and is recognised by what it
  renders: a full-viewport layer of its own, **and** a portal or the shared body
  lock, **and** a dismissal (Escape, a click on that layer or its scrim, or a
  labelled Close control). All three, because each holds something out: an
  anchored popover has no full-viewport layer (`components/Combobox.tsx`,
  `components/InfoTooltipIcon.tsx`), a click-catcher under a menu never leaves its
  own DOM neighbourhood (`components/CompactDateMenu.tsx`), and a blocking curtain
  with no dismissal is not a dialog.

The anatomy route deliberately **reports and lets a human decide** rather than
staying silent — the same bias the module states over `handRolled`. Being found
by anatomy is itself a finding: it means the surface tells assistive technology
nothing, so `npm run census:dialogs` prints it as `found by ANATOMY`.

It reports dialogs belonging to no dialog host rather than omitting them, in two
sections that are two different answers: RECORDED EXCEPTIONS (the table above),
and SCOPED OUT BY ANATOMY (surfaces the convergence rule was never about).
`lib/__tests__/dialog-census.test.ts` is the detection layer: it fails when a
new hostless dialog appears, when a documentary `HOSTLESS_DIALOGS` entry
outlives its subject, and when that input and the table above drift apart. It
does not make hostless dialogs the goal; the default remains convergence onto
`ModalShell` or `components/overlay`, and the remaining rows are explained here
rather than minted by recurrence.

## Testing gestures

`e2e/helpers.ts` drives real Chromium touch input via CDP — Playwright's
`touchscreen` only taps, and `page.mouse` produces pointer events these gestures
ignore. It offers two entry points, and the choice is about WHERE the gesture
must start:

- `touchSwipeFrom(page, locator, { dx, dy })` for a gesture that must begin
  inside an element (a drag handle, a panel), which is what the recognizer's
  containment test demands.
- `touchSwipe(page, from, to)` for a gesture anchored to the DOCUMENT — the
  drawer's edge swipe, the Timeline's day swipe.

A point measured from an element is not good enough for the first kind, and
`centerOf`-style settling does not rescue it (#2714): waiting for the box to stop
moving proves the element held still across one past window, never that it will
hold still until the touch is dispatched. A bottom-anchored sheet that gathers
content lazily grows UPWARD after it has come to rest, the handle leaves the
certified coordinate, the touch lands on whatever moved into it, and the gesture
is rejected with **no error and no effect** — the test then waits out its budget
on an exit that was never scheduled. So `touchSwipeFrom` re-aims and proves the
landing (the target of the dispatched touchstart, the same fact the recognizer
uses) before moving a pixel; `centerOf` is private to the helper module.
