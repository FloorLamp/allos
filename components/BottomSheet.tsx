"use client";

import { useCallback, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./useFocusTrap";
import { usePresence } from "./usePresence";
import { useLockBodyScroll } from "./useLockBodyScroll";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { motionMs } from "@/lib/motion";
import {
  OverlayDragHandle,
  overlayMotionClass,
  useOverlayDrag,
  verticalScrollOwnersAtTop,
  OVERLAY_PANEL_BORDER,
  OVERLAY_PANEL_ELEVATION,
  OVERLAY_PANEL_MAX_WIDTH,
  OVERLAY_PANEL_MAX_WIDTH_FROM_MD,
  OVERLAY_PANEL_RADIUS_BOTTOM,
  OVERLAY_SAFE_BOTTOM,
  OVERLAY_SCRIM,
  type OverlaySize,
} from "./overlay";
import { IconX } from "@tabler/icons-react";

// The bottom sheet — the phone's modal surface (issue #1416, section E).
//
// A PRIMITIVE, not a one-off: it is ModalShell's thumb-reachable sibling, and it
// is deliberately content-agnostic so the follow-ups build on it rather than
// beside it (#1428 generalized the sheet to more surfaces; #1425 made it
// draggable). What holds that together:
//
//   * ONE transformed element. The panel is the only thing that moves — its
//     enter/exit animation is a `translateY` on `[data-sheet-panel]` and nothing
//     wraps it in a second transform, so the drag can write `style.transform`
//     straight onto it without fighting a parent.
//   * `panelRef` is forwarded, so a consumer that needs the element (the
//     quick-entry overlay) needs no fork of this file.
//   * Motion, scrim, chrome and the drag itself are the SHARED overlay
//     primitives (components/overlay, #1469) — the same ones the nav drawer and
//     the activity dock consume, so the three surfaces cannot drift into three
//     dialects of "slide up".
//   * a11y (focus trap, Escape, `aria-modal`) is the SHARED useFocusTrap hook, so
//     a new sheet consumer inherits it instead of re-deriving it.
//
// Chrome: a backdrop that dismisses on tap, safe-area bottom inset so the panel
// clears the home indicator, and a max height that keeps the sheet under the
// status bar with its own scroll for long content. Every animation is gated by
// prefers-reduced-motion through lib/motion.ts — reduced motion still gets the
// full open/close STATE sequence, just instantly.
//
// ── `presentation` (issue #1428, section A) ──────────────────────────────────
//
// #1428 asks for ONE responsive dialog primitive, "not a fork: the same
// component renders centered ≥md and as a sheet below — content authored once".
// That is this prop, and it is the ONLY thing that differs between the two:
//
//   * "sheet"  — bottom-anchored at every width. What the quick-log sheet and
//                the quick-entry overlay want: they are phone surfaces, and the
//                sheet IS the presentation.
//   * "dialog" — a sheet below `md`, a centered modal from `md` up. What a
//                confirm/picker wants: thumb-reachable on a phone, and the
//                familiar centered card on a desktop where "anchored to the
//                bottom edge" would read as a notification, not a decision.
//                Since #2774 this is what EVERY former ModalShell consumer
//                renders as — ModalShell is now a thin wrapper over this file
//                (components/ModalShell.tsx), so the app has ONE dialog
//                primitive and one scroll owner instead of two of each.
//   * "centered" — a card centred at EVERY width. The recorded ANATOMY
//                EXCEPTION, not a preference: a surface with no bottom edge to
//                flick toward at any size (the command palette, the camera
//                fallback). Each one is registered in
//                lib/__tests__/overlay-motion-chokepoint.test.ts with its
//                justification, so the exception list is reviewable rather than
//                whatever happened to get typed.
//
// ── `fullScreenBelowMd`, and why it is not a fourth presentation (#3423) ─────
//
// "Not a sheet" was only ever half an argument. It ruled the bottom edge OUT for
// the palette; it never defended a floating CARD on a phone — which is what the
// centred presentation shipped: a `max-h-[85dvh]` panel inset by `p-4`, with the
// software keyboard eating most of what was left. A desktop dialog wearing a
// phone's worst-case viewport.
//
// The phone idiom for "a field over a list of results" is the FULL-SCREEN SEARCH
// SURFACE — field at the top, results filling everything under it, one control
// that says Cancel. That is what this flag renders below `md`, and from `md` up
// nothing changes at all.
//
// IT IS A GEOMETRY FLAG, NOT A PRESENTATION. A presentation is a HOST decision —
// which component mounts, which lifecycle contract applies, whether a flick
// discards. None of that moves here: the surface is still the centred anatomy,
// still un-flickable at both widths, still the same portal, scrim, focus trap,
// scroll lock and Escape seam, and still the SAME `presentation="centered"` entry
// in the chokepoint register. Only the box's edges move, and they move in `md:`
// classes so there is no JS width check and no second rendered copy (#2305).
//
// Both share this file's focus trap, Escape handling, backdrop dismissal, scroll
// lock, portal, and presence/exit timing — so there is one implementation of the
// modal contract to fix, and no hand-mirrored `hidden md:*` pair to drift.
//
// ── The lifecycle contract (owner decision, #1428) ───────────────────────────
//
// Everything mounted here is TRANSACTIONAL: dismissal means DISCARD, and that is
// safe. Pickers, confirms, and the #1468 quick-log entry overlays qualify. A
// SESSION-lifecycle surface does NOT: the activity editor stays a DOCK
// (ActivityEditorProvider) because a live workout runs for an hour, survives
// navigation minimized, and "away" means still running — putting swipe-down /
// scrim-tap dismissal on it would make an in-progress workout silently
// discardable. The dock never becomes discardable; do not migrate it here.

export type SheetPresentation = "sheet" | "dialog" | "centered";

export default function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  testId = "bottom-sheet",
  initialFocusRef,
  panelRef: externalPanelRef,
  presentation = "sheet",
  zIndexClass = "z-60",
  titleHidden = false,
  titleTruncates = false,
  size = "sm",
  showClose = false,
  closeDisabled = false,
  fullScreenBelowMd = false,
  onGestureDismiss,
}: {
  open: boolean;
  onClose: () => void;
  // The sheet's accessible name. Rendered as a visible heading — a sheet with an
  // invisible title is a sheet whose purpose you have to infer from its rows.
  title: string;
  description?: string;
  children: React.ReactNode;
  testId?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  // #1425 seam: the drag layer takes the panel element from here.
  panelRef?: React.RefObject<HTMLDivElement | null>;
  // Sheet everywhere (default) vs sheet-below-`md`/centered-above vs centered
  // at every width. See above.
  presentation?: SheetPresentation;
  // The stacking layer. Defaults to the sheet's own `z-60`. A surface that must
  // out-rank the toasts (`z-100`) — a confirm, which is a DECISION the viewer
  // has to reach — passes its own. Kept a full class string so Tailwind's
  // scanner sees a literal (a computed `z-[${n}]` would never be generated).
  zIndexClass?: string;
  // Keep the title as the sheet's ACCESSIBLE name but let the mounted content
  // own the visible heading. For a sheet hosting an existing form component (the
  // #1468 quick-entry overlay mounts MeasurementsQuickAdd, which
  // already renders its own "Log …" heading) showing both prints the same
  // sentence twice. The sheet still HAS a name — `aria-labelledby` points at the
  // visually-hidden heading — so screen readers announce it exactly as before;
  // this is never a way to ship a nameless dialog.
  titleHidden?: boolean;
  // Keep the visible heading to ONE LINE, ellipsised (#3501). A sheet whose title
  // is built from a row's display name inherits that name's length, and a long one
  // wrapped the header and pushed the close control off the first line. The sheet
  // is still identified by its first words, which is what the heading is for.
  // Set by `components/overlay/AnchoredPanel.tsx` for every ⋯ panel it hosts, and
  // off by default: a sheet whose title is authored copy (a form, a confirm) is
  // written to fit and should be allowed to wrap rather than lose its last words.
  titleTruncates?: boolean;
  // How wide the panel gets from `sm` up (#2774). Below `sm` every presentation
  // is full-width, so there is nothing to choose. See OVERLAY_PANEL_MAX_WIDTH
  // for what the three buckets mean; the default is the sheet's historical
  // `sm:max-w-md`.
  size?: OverlaySize;
  // Draw an explicit Close control in the header. A sheet does not need one —
  // its drag handle IS the affordance and the scrim is a tap away — but a
  // CENTERED card has neither, so every dialog-presentation consumer that used
  // to be a ModalShell keeps the "✕" it has always had.
  showClose?: boolean;
  // Refuse the Close control while the surface has a reason to refuse dismissal
  // — a write already in flight, which closing would not cancel (#3405 review).
  //
  // WHY THIS IS A PROP AND NOT THE CONSUMER'S PROBLEM. A consumer that wants
  // "no dismissal right now" can already pass a no-op `onClose`, and that is
  // exactly the shape this exists to stop: the ✕ still looks live, still takes
  // the tap, and does nothing — an affordance lying about what it will do, two
  // pixels from a Cancel button that is honestly `disabled`. An ORNAMENT moving
  // is not a reason to widen this API; an AFFORDANCE LYING is.
  //
  // It disables ONLY the visible control. Escape and the gestures keep going to
  // `onGestureDismiss`/`onClose`, where the consumer's own guard already decides
  // — a surface that refuses dismissal refuses it there, and one that merely
  // wants the button greyed out (a submit in flight) still answers Escape. The
  // two questions are separate and this prop is deliberately the narrower one.
  closeDisabled?: boolean;
  // Fill the viewport below `md` instead of floating (see above). Only meaningful
  // with `presentation="centered"` — the other two are already full-bleed at that
  // width, where a sheet IS the phone shape. When it is on, `showClose` draws a
  // labelled "Cancel" below `md` and the usual "✕" from `md` up: ONE control with
  // two spellings, because a bare 20px glyph is under the #644 tap floor and a
  // full-screen surface with no named way out is the thing phone users report.
  fullScreenBelowMd?: boolean;
  // Called INSTEAD of onClose when the surface is dismissed by a GESTURE — a
  // flick on the drag handle, a tap on the scrim — or by ESCAPE. A consumer
  // hosting a form that may hold five typed minutes of family history routes them
  // through a confirm; a transactional quick-entry sheet leaves this unset and
  // keeps its one-flick discard (#1428).
  //
  // ESCAPE JOINED THIS SEAM IN #3420, and the Close button did not. #2774 put both
  // on `onClose` because a keypress on a named key and a click on a named control
  // are targeted actions rather than accidents — true, and it stayed true for a
  // surface with nothing to lose, which is what the consumer's own guard still
  // answers by closing outright. It was not true for a dialog holding unsaved work:
  // there, one keystroke destroyed exactly the typing a scrim tap two pixels away
  // would have asked about. So Escape asks the same question the gestures ask. The
  // CLOSE BUTTON still calls onClose unguarded: it is the control the person aimed
  // at, and a confirm on it would be the ask-before-acting pattern the house
  // grammar declines.
  //
  // Returning `false` REFUSES the dismissal: the panel settles back to rest
  // rather than leaving, which is what a consumer that has just raised a confirm
  // over itself needs — the form is staying, so the surface holding it must stay
  // too. See useOverlayDrag's `onOutcome`.
  onGestureDismiss?: () => void | boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const { mounted, phase } = usePresence(open, motionMs("sheet", reduceMotion));
  const localPanelRef = useRef<HTMLDivElement>(null);
  const panelRef = externalPanelRef ?? localPanelRef;
  const handleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // The lock is REFERENCE-COUNTED (components/useLockBodyScroll.ts), which is
  // what makes it safe for a dialog opened over an already-open sheet: the body
  // stays locked until the LAST surface releases, whatever order they close in.
  // #2774 made that a load-bearing invariant rather than a nicety, because every
  // former ModalShell consumer now holds a lock too.
  useLockBodyScroll(mounted);
  // Stop trapping focus / answering Escape the moment the exit starts, so a
  // closing sheet can't swallow the next Escape or steal focus back.
  // Scrim tap, flick and ESCAPE share ONE exit (#3420), so a consumer that guards
  // discards cannot accidentally guard some of them. The Close button below does
  // not: see `onGestureDismiss`.
  const dismissByGesture = onGestureDismiss ?? onClose;
  useFocusTrap({
    panelRef,
    onClose,
    onEscape: dismissByGesture,
    initialFocusRef,
    active: open,
  });

  // Drag-to-dismiss (#1425, #3691), on the shared recognizer (#1469). THE SHEET'S
  // OUTCOME IS DISCARD — that is what the lifecycle contract above licenses, and
  // it is the whole difference between this call site and the activity dock's,
  // which passes `onMinimize` to the very same hook. Enabled only while open, so
  // a sheet already playing its exit can't be re-grabbed.
  const canStartSheetDrag = useCallback((origin: Node): boolean => {
    const handle = handleRef.current;
    const content = contentRef.current;

    // THE RENDERED HANDLE GATES THE WHOLE SHEET GESTURE, separately from where
    // this particular touch began. The responsive dialog keeps the handle node
    // mounted but hides it from `md` up; its zero rendered boxes are the DOM
    // truth that no part of the centred desktop card may arm a drag. Do not fold
    // this into an origin-is-the-handle rule: the visible handle advertises the
    // gesture for the whole non-scrolling chrome below it — title, description
    // and Close included.
    if (!handle || handle.getClientRects().length === 0) return false;

    // Chrome outside the content scroller owns no competing vertical scroll,
    // so it always admits. Inside the content region, body ownership is decided
    // once from every effective scroll owner between the origin and this
    // boundary. Starting below any owner's top belongs to native scrolling for
    // that touch's whole lifecycle, even if it reaches zero. When all owners
    // start at zero the touch may pull the sheet down, and later scroll changes
    // cannot revoke that already-claimed origin.
    if (!content || !content.contains(origin)) return true;

    return verticalScrollOwnersAtTop(origin, content);
  }, []);

  const { suppressMotion } = useOverlayDrag({
    panelRef,
    canStart: canStartSheetDrag,
    direction: "down",
    onOutcome: onGestureDismiss ?? onClose,
    // The panel unmounts between opens, so the motion latch expires with it
    // (#2725) — without this, one drag on a sheet whose COMPONENT never
    // unmounts (the quick-log sheet, the quick-entry host) mutes its animations
    // for the rest of the page's life.
    panelMounted: mounted,
    // A centred card is not flickable at any width, so it never arms the
    // recognizer (its handle is not rendered either — this is the same fact
    // stated where the hook can see it).
    enabled: open && presentation !== "centered",
  });

  if (!mounted || typeof document === "undefined") return null;

  const entering = phase === "enter";
  const asDialog = presentation === "dialog";
  const asCentered = presentation === "centered";
  const motionPhase = entering ? "enter" : "exit";
  // The scrim animates UNCONDITIONALLY — the drawer's and the switcher's shape
  // (#2725). The `suppressMotion` latch below exists for one reason only: a
  // running keyframe outranks the inline transform a drag writes, so the two
  // cannot both own the same element. The scrim is not that element. Nothing
  // ever writes an inline transform to it, so gating it bought no handshake and
  // cost the exit fade: after a drag-dismiss the panel left under its inline
  // settle while the backdrop sat at full opacity — `dark:bg-black/70` over the
  // whole viewport — until the presence timer blinked it out. The fade IS the
  // signal that the close is progressing; without it the screen just holds dark.
  const backdropMotion = overlayMotionClass("scrim", motionPhase, reduceMotion);
  // The panel's travel — and the one element the latch is about. A plain sheet
  // always slides up; the responsive dialog uses the "dialog" anchor, which IS
  // the slide-up below `md` and becomes a fade from `md` up — the media query
  // lives in the stylesheet so one class name covers both viewports (a JS width
  // check would need a resize listener and would still be wrong between
  // hydration and the first paint). A centred card has no edge to travel from at
  // either width, so it fades at both.
  const panelMotion = suppressMotion
    ? ""
    : overlayMotionClass(
        asCentered ? "centered" : asDialog ? "dialog" : "bottom",
        motionPhase,
        reduceMotion
      );
  // Where the panel sits in the viewport, and the chrome that follows from it.
  // Bottom-anchored surfaces square off against the screen edge and clear the
  // home indicator; a centred card floats, so it rounds all the way round and
  // owes the home indicator nothing.
  //
  // WHO SCROLLS, at each width. Below `md` a sheet is bottom-anchored and
  // bounded, so the PANEL is the scroller — the same contract every sheet in the
  // app has always had. From `md` up the responsive dialog is a centred card
  // with no reason to be bounded, so the CONTAINER scrolls and the panel clips
  // NOTHING. That second half is not cosmetic: an `overflow` of any kind
  // establishes a clip whether or not it is currently scrolling, and the forms
  // behind this host open comboboxes and date pickers that must be allowed to
  // paint past the panel's edge. Bounding the panel at desktop cut the practice
  // picker's listbox off mid-list, which is what e2e/wellness-practices.spec.ts
  // caught. Exactly one scroller at each width, and both contain their
  // overscroll.
  // A centred card that fills the phone (#3423) stretches instead of floating,
  // and the CONTAINER stops scrolling below `md` — the panel is exactly the
  // viewport there, so a scrolling container over it would be a second scroller
  // with nothing to scroll, and on iOS a place for the address bar to fight the
  // keyboard. From `md` up every one of these classes is the centred card's own.
  const asFullScreen = asCentered && fullScreenBelowMd;
  const containerAnchor = asFullScreen
    ? "items-stretch p-0 md:items-start md:overflow-y-auto md:overscroll-contain md:p-8"
    : asCentered
      ? "items-start overflow-y-auto overscroll-contain p-4 sm:p-8"
      : asDialog
        ? "items-end md:items-start md:overflow-y-auto md:overscroll-contain md:p-8"
        : "items-end";
  const panelShape = asFullScreen
    ? // Square to the screen edges, no border, and the home indicator cleared —
      // the same safe-area posture every bottom-anchored surface here already
      // takes, for the same reason: the content region ends where the hardware
      // does. `max-h-none` because the panel IS the viewport height.
      `max-h-none rounded-none border-0 px-4 pt-2 ${OVERLAY_SAFE_BOTTOM} md:max-h-[85dvh] md:rounded-2xl md:border md:px-6 md:pt-5 md:pb-5`
    : asCentered
      ? "max-h-[85dvh] rounded-2xl border px-4 pt-4 pb-4 sm:px-6 sm:pt-5 sm:pb-5"
      : `max-h-[85dvh] border-t px-4 pt-1 sm:pb-4 ${OVERLAY_PANEL_RADIUS_BOTTOM} ${OVERLAY_SAFE_BOTTOM} ${
          asDialog
            ? "md:max-h-none md:overflow-visible md:rounded-2xl md:border md:px-6 md:pt-5 md:pb-5"
            : ""
        }`;
  // Below `md` a full-screen surface is the screen's width, so its declared size
  // must not bite until `md` either — see OVERLAY_PANEL_MAX_WIDTH_FROM_MD.
  const panelMaxWidth = asFullScreen
    ? OVERLAY_PANEL_MAX_WIDTH_FROM_MD[size]
    : OVERLAY_PANEL_MAX_WIDTH[size];
  const titleClass = titleHidden
    ? "sr-only"
    : `font-semibold text-slate-900 dark:text-slate-100 ${
        asDialog || asCentered ? "text-lg" : "text-base"
      }${titleTruncates ? " min-w-0 truncate" : ""}`;
  const heading = (
    <h2 id={titleId} className={titleClass}>
      {title}
    </h2>
  );

  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClass} flex justify-center ${containerAnchor}`}
      data-testid={testId}
      data-phase={phase}
      data-presentation={presentation}
      // The GEOMETRY the centred presentation took, declared rather than
      // measured — a spec that wants to know the palette chose its phone shape
      // should not have to infer it from a bounding box. The box is pinned
      // separately, by measurement, in e2e/command-palette-shell.mobile.spec.ts.
      data-full-screen-below-md={asFullScreen ? "" : undefined}
    >
      <div
        className={`${OVERLAY_SCRIM} ${backdropMotion}`}
        onClick={() => {
          // Discard the refusal signal here: a scrim tap moves no panel, so
          // there is nothing to put back, and React gives a handler's return
          // value no meaning.
          dismissByGesture();
        }}
        aria-hidden
        data-testid={`${testId}-backdrop`}
      />
      <div
        ref={panelRef}
        data-sheet-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        // The DECLARED size, exposed so a spec can pin the decision rather than
        // a rendering of it. The width a size resolves to is a Tailwind class
        // that only bites from `sm` up, so at phone width a class assertion
        // tests nothing at all — which is exactly what
        // e2e/protocol-templates.spec.ts's `toHaveClass(/max-w-3xl/)` was doing
        // at a 390px viewport before #2774 moved it. The size's EFFECT on width
        // is pinned separately, by measurement, in e2e/dialog-convergence.spec.ts.
        data-size={size}
        // THE PANEL DOES NOT SCROLL — its content region does (#2774). Before
        // this the panel was the scroller and the header scrolled away with the
        // form; more importantly, ModalShell's version of the same shape scrolled
        // a `fixed inset-0` container over an UNLOCKED body, so a drag its
        // scroller declined chained straight out to the document and the page
        // underneath drifted. One scroll owner, `overscroll-contain` on it, and a
        // locked body behind it is the whole of that fix.
        className={`relative flex w-full flex-col overflow-hidden bg-surface outline-hidden ${panelMaxWidth} ${OVERLAY_PANEL_BORDER} ${OVERLAY_PANEL_ELEVATION} ${panelShape} ${panelMotion}`}
      >
        {/* The visible drag affordance gates the whole gesture (#1425/#3721):
        the handle and the non-scrolling chrome below it dismiss at any body
        scroll position. The body itself joins only when its scroller started
        at the top (#3691). A centered dialog is not flickable, so the
        responsive presentation drops the handle from `md` up exactly where that
        stops being true (#1428) — and the recognizer goes with it, since a
        hidden handle has no rendered box. A card centred at EVERY width never
        draws one at all. */}
        {!asCentered && (
          <OverlayDragHandle
            handleRef={handleRef}
            className={`mb-0.5 ${asDialog ? "md:hidden" : ""}`}
          />
        )}
        {showClose ? (
          <div
            className={`flex shrink-0 items-start gap-3 ${
              titleHidden ? "justify-end" : "justify-between"
            }`}
          >
            {heading}
            <button
              type="button"
              onClick={onClose}
              disabled={closeDisabled}
              className={
                asFullScreen
                  ? // ONE control, two spellings. Below `md` it is a named,
                    // tap-floor "Cancel" — the way out of a full-screen surface
                    // has to be readable, and a 20px glyph is under #644's floor
                    // where a thumb is doing the tapping. From `md` up it is the
                    // "✕" every centred card in the app has always drawn.
                    // NOT `shrink-0` below `md`: #3450 established that class as
                    // protection FROM prose, and this control sits beside a
                    // heading rather than inside one.
                    //
                    // THE `disabled:` CLASSES ARE ON BOTH BRANCHES, and #3455 is
                    // why (`closeDisabled`, above). A branch that drops them
                    // renders a control that is `disabled` in the DOM, looks
                    // completely live, and still swallows the tap — the exact
                    // lying affordance that prop was written to stop.
                    // `pointer-events-none` is load-bearing SEPARATELY from the
                    // fade, and at THIS width it is the `md:` half that needs it:
                    // Tailwind emits `disabled:` after `hover:` at equal
                    // specificity, so below `md` the `disabled:text-slate-500`
                    // below already outranks `hover:text-brand-800` — but
                    // `md:hover:text-slate-600` is a BREAKPOINT variant and sorts
                    // after the unprefixed `disabled:`, so from `md` up nothing
                    // except `pointer-events: none` stops a refused ✕ lighting up
                    // under the pointer. The flat string below has no
                    // `disabled:text-*` at all, so there it is the only thing
                    // holding at every width. Either way a resting-state
                    // screenshot never shows the difference; e2e/command-palette-
                    // shell.mobile.spec.ts hovers it by coordinate at both widths.
                    //
                    // AND THE HUE GOES WITH THEM, which the slate branch never
                    // had to say because it was already slate. #1450 ruled that
                    // FADING a saturated brand colour does not read as disabled
                    // — it reads as washed-out brand, "half-loaded or broken" —
                    // and replaced the button family's `disabled:opacity-50`
                    // with a muted surface for exactly that reason
                    // (app/globals.css, `.btn:disabled`). MEASURED, not assumed
                    // — composited over the real `--surface`, the ✕'s own
                    // disabled state is 2.16:1 light and 2.56:1 dark. Faded
                    // brand-700 lands on that in light (2.03:1), but faded
                    // brand-400 lands at 3.48:1 in dark — half again the ✕'s
                    // disabled state, on a saturated hue, which reads as an
                    // ordinary live link. Fading harder
                    // is the wrong lever (#1450 again, and 30% would read as
                    // 1.50:1/2.03:1 — under the baseline, not on it), so the hue
                    // goes instead and the disabled state lands exactly on
                    // 2.16/2.56: ONE disabled look for one control, at both
                    // widths, rather than a second one invented for the phone.
                    "-mr-2 min-h-11 px-2 text-sm font-medium text-brand-700 hover:text-brand-800 disabled:pointer-events-none disabled:text-slate-500 disabled:opacity-50 md:mr-0 md:min-h-0 md:shrink-0 md:px-0 md:text-slate-500 md:hover:text-slate-600 dark:text-brand-400 dark:hover:text-brand-300 dark:disabled:text-slate-400 md:dark:text-slate-400 md:dark:hover:text-slate-300"
                  : "min-h-11 min-w-11 shrink-0 text-slate-500 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-300"
              }
              // "Cancel" at BOTH widths when full-screen, so the accessible
              // name matches the visible one below `md` (WCAG 2.5.3) instead of
              // announcing "Close" over a control that reads Cancel. From `md`
              // up the glyph is the same "✕" as every other card and only its
              // name differs, which is the accurate word for abandoning a search.
              aria-label={asFullScreen ? "Cancel" : "Close"}
              title={asFullScreen ? "Cancel" : "Close"}
              data-testid={`${testId}-close`}
            >
              {asFullScreen && (
                <span className="md:hidden" aria-hidden>
                  Cancel
                </span>
              )}
              <IconX
                className={`h-5 w-5 ${asFullScreen ? "hidden md:block" : ""}`}
              />
            </button>
          </div>
        ) : (
          heading
        )}
        {description && (
          <p
            id={descriptionId}
            className="mt-0.5 shrink-0 text-sm text-slate-500 dark:text-slate-400"
          >
            {description}
          </p>
        )}
        {/* THE CONTENT REGION REFUSES HORIZONTAL SCROLL (#3360). `overflow-y-auto`
        alone is not a y-only declaration: per CSS, a non-`visible` `overflow-y`
        forces `overflow-x` to compute to `auto`, so this region was silently a
        horizontal scroll container too. Any mounted body with a full-bleed
        negative margin — FoodLogBar's `-mx-2 px-2` header was the one the owner
        hit — then handed it real overflow, and one thumb drag with a horizontal
        component parked the whole sheet sideways with no snap-back, no scrollbar
        on touch, and nothing saying "swipe back". Declaring the x axis costs a
        stray bleed at most a few clipped pixels of background instead of a
        scrollable viewport, and it holds for every future dialog body rather than
        for the one that was reported. The `md:overflow-visible` branch below
        still unclips BOTH axes from `md` up, which is what lets a combobox
        listbox paint past the panel edge (e2e/wellness-practices.spec.ts).

        `hidden` AND NOT `clip`, WHICH IS NOT A CHOICE. `clip` would be the
        stronger word — it establishes no scrollport at all, so even a written
        `scrollLeft` would have nowhere to go — but CSS does not allow it here:
        when one axis is `clip` and the other is a scrolling value, the used value
        of `clip` is `hidden`. Measured, not assumed: `overflow-x-clip` beside
        `overflow-y-auto` reported computed `hidden` in Chromium. So `hidden` is
        the strongest the y-scrolling region can be, and what it buys is the whole
        of the reported bug — a `hidden` box is not USER-scrollable, so no thumb
        drag moves it. A script that writes `scrollLeft` still can; the second
        layer (bodies that do not overflow in the first place) is what closes
        that, which is why #3360 asked for both. */}
        <div
          ref={contentRef}
          className={`mt-3 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain ${
            asDialog ? "md:overflow-visible" : ""
          }`}
          data-sheet-content
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
