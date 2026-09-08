# Overlays

Use the shared hosts and `components/overlay/` primitives. Choose a host by the
surface's lifecycle; consumers supply content and the action dismissal means.

## Choose a host

| Surface                                            | Host                         | Dismissal                                              |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| Transactional form, picker, or confirmation        | `ModalShell`                 | Discard                                                |
| Live workout that survives navigation              | `ActivityOverlay`            | Minimize; keep the session running                     |
| Rare entry such as labs or imaging                 | `AddEntryPanel`              | Inline in a reading column; `ModalShell` in a hub rail |
| Menu or navigation                                 | `BottomSheet` or `MobileNav` | Close                                                  |
| Menu, date picker, or detail anchored to a control | `overlay/AnchoredPanel`      | Close                                                  |

`ModalShell` uses `BottomSheet` with `presentation="dialog"`: a sheet below
`md`, a centered card above. Declare `size="sm" | "md" | "lg"` through
`OVERLAY_PANEL_MAX_WIDTH`; do not add a per-consumer maximum width.

A centered presentation needs an anatomy-based exception in
`CENTERED_PRESENTATION` in `lib/__tests__/overlay-motion-chokepoint.test.ts`.
The command palette and `media/MediaInput` are the current exceptions; the latter
includes a live camera viewfinder whose aiming gesture conflicts with dismissal.
The palette also uses `fullScreenBelowMd` to fill a phone's viewport, changing geometry
within the same host, focus trap, scrim, and scroll lock.

The activity panel is bottom-anchored on phones and right-anchored on desktop.
Its phone handle is both a minimize button and a drag handle. The desktop
backdrop minimizes it. Resume controls use `workoutOffer` and preserve the
session's epoch and logged sets; see [stateful affordances](stateful-affordances.md).

## Dismissal and focus

`ModalShell` checks the dirty-form registry for flicks, scrim taps, and Escape.
Unsaved input opens `ConfirmDialog`; a clean form closes immediately. The explicit
Close button calls `onClose` without that confirmation. If a write temporarily
prevents closing, pass `closeDisabled` and retain the consumer's dismissal guard;
do not give an enabled Close control a no-op handler.

Modal surfaces need a name, dialog semantics, and focus management even when
their presentation is exceptional. `useFocusTrap` restores focus and gives a
nearer dialog or `[data-escape-layer="true"]` first claim on Escape.
`useLockBodyScroll` is reference-counted: nested surfaces keep the page locked
until the last lock releases, regardless of closing order. Their scrollers
contain overscroll so a declined drag cannot scroll the page behind them.

These surfaces use another host for a specific reason:

| Surface                          | Reason                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `ImageCropper`                   | Sits above an existing photo dialog at `z-120`; its drag manipulates image content        |
| `photo/PhotoGallery`             | Full-bleed media viewer with paging gestures                                              |
| `activity-form/FitnessTestTimer` | Collapses back into its parent sheet while its timer keeps running; needs no second scrim |
| `ActivityOverlay`                | Persistent session; converges on overlay primitives                                       |
| `MobileNav`                      | Left-edge navigation and swipe; converges on overlay primitives                           |

`ActivityOverlay`, `PhotoGallery`, and `MobileNav` use the shared focus trap.
Presentation exceptions do not waive accessibility.

## Anchored content

`AnchoredPanel` renders a `BottomSheet` below `md` and a fixed, portaled popover
positioned by `useAnchoredPopover` above it. Author content once through its
`children` function; mount one copy, never responsive hidden twins. Menu sheets
need no dirty-form guard.

`MENU_ITEM` supplies 44px rows below `md` and for coarse pointers above it, and
32px rows for a desktop mouse. The pointer rules are mutually exclusive.

The sheet traps focus. A desktop popover declaring a `role` moves focus inside
after positioning, restores it on close, and handles Escape without trapping
Tab. A role-less panel leaves focus alone so a `DateField` calendar can open
without taking focus from its input. Match popup roles and names to the trigger's
ARIA declaration.

Two exceptions remain: `CompactDateMenu` is a phone-only inline day switcher
already at the touch floor; `Combobox`'s listbox belongs to its field and is not
a menu.

## Dialog bodies

The host owns the outer border, radius, padding, title, Close control, and
`mt-3` title gap. Bodies render content. Remove duplicate outer cards, headings,
and top margins; keep internal groups and description-to-form spacing. Prefer
the host's accessible title over a second body heading (`titleHidden` is available
when needed).

A full-width list or sticky footer must match the host's padding at each
breakpoint. For dialog presentation, use `-mx-4 md:-mx-6` and re-inset with
`px-4 md:px-6`. Centered presentation steps at `sm`; check `panelShape` in
`BottomSheet` for the actual mount. This constraint concerns insets: content may
change its flex layout at another breakpoint. Footer spacing belongs to the
body because the host draws no footer.

For a form used both on a page and inside a dialog, reuse an existing chrome
switch: `embedded` in encounter, appointment, and dietary-preference forms, or
`compact` in `PracticeEditor`.
Do not rename working props or introduce another spelling. A dialog-only form
needs no switch.

Quick-log content reserves its asynchronous context slot and the largest row
segment visible to the active profile inside the host's scroller. Loading,
empty results, errors, and segment changes should not move the panel or segment
strip; the gathered section uses its declared opacity-only arrival.

## Motion and gestures

`components/overlay/` owns these shared pieces:

- `useDragGesture`: touch recognition over `lib/gesture.ts`, including axis lock,
  directed travel, and distance-or-flick decisions.
- `useOverlayDrag`: finger-following transforms and release settling.
- `OverlayDragHandle` and `tokens.ts`: a 40×6 bar in a 64×44 target, scrim,
  panel chrome, and safe-area padding.
- `overlayMotionClass()` in `lib/motion.ts`: classes tied to the shared CSS
  duration and enter/exit easing. Keep paint and presence timing aligned and
  preserve reduced-motion behavior; see [micro-motion](micro-motion.md).

A CSS keyframe animation overrides inline transforms. Once a drag claims a panel,
`useOverlayDrag` latches `suppressMotion` so the panel stops emitting its motion
class, including during exit. Keep the latch until that panel unmounts; resetting
it after a canceled drag would replay entry. Pass presence's `mounted` as
`panelMounted` when the panel unmounts between opens. Scrims have no drag transform
and must keep their fade independently of this latch.

Use `commitSettle="away"` for an unmounting sheet and `"rest"` for the activity
panel that remains mounted while minimized. The activity workspace has no entry
animation: translating its full-height child changes its scroller's extent,
and restoring an already-mounted session would not replay a mount animation.

The handle always owns a downward drag. A touch starting in sheet content can
dismiss only if every vertical scroll owner up through that content was at its
top at touch-start. Admission stays fixed for the gesture, including when native
scrolling later reaches zero. `canStart` owns this decision without blocking taps
or fields.

Pull-to-refresh likewise captures ownership at touch-start, using body scroll
lock through `overlayOwnsViewport` in `lib/pull-to-refresh.ts`. A closing overlay
must not release that same gesture into a page refresh. This includes record
forms in `ModalShell`, which now use the locking sheet primitive. Closing the
sheet allows a subsequent pull again.

Use the shared touch recognizer rather than pointer handlers for overlay drags;
native scroll arbitration can cancel pointer movement. Keep a button, backdrop,
or keyboard route for each gesture. Horizontal overscroll containment on
`html`/`body` prevents chaining into browser history where supported; it does not
remove the platform's own navigation gesture.

The handle's `touch-action: none` preserves drag ownership. The repository's
Chromium probe records suppression of the first tap immediately after this drag;
`consumeSuppressedTap` in `e2e/helpers.ts` accounts for it in gesture tests.
Use `scripts/tap-suppression-probe.mjs` when investigating that behavior.

## Verification

Use existing coverage for the behavior changed:

- `overlay-motion-chokepoint.test.ts` checks host convergence, declared exceptions,
  motion ownership, recognizers, overscroll containment, anchored menus, and
  disabled-close handling. Do not duplicate its inventories here.
- `scroll-lock.test.ts` and `dialog-convergence.mobile.spec.ts` cover nested
  ownership; `motion-tokens.test.ts` checks CSS/JS timing agreement.
- `dirty-form-refresh.mobile.spec.ts` covers refusal of a pull under a locking
  form and refresh after closing it.

Follow [E2E hygiene](e2e-hygiene.md). Use `touchSwipeFrom(page, locator, delta)` for
a gesture starting on an element: it verifies the actual touchstart target before
moving, including when asynchronous content shifts the handle. Use `touchSwipe`
for document coordinates such as the drawer edge or Timeline. Mouse events do
not exercise these touch gestures.
