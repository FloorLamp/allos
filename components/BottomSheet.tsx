"use client";

import { useId, useRef } from "react";
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
  OVERLAY_PANEL_BORDER,
  OVERLAY_PANEL_ELEVATION,
  OVERLAY_PANEL_MAX_WIDTH,
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
  size = "sm",
  showClose = false,
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
  // Called INSTEAD of onClose when the surface is dismissed by a GESTURE — a
  // flick on the drag handle, or a tap on the scrim. Escape and the Close button
  // deliberately still call onClose: those are targeted actions on a named
  // control, and this seam exists for the two dismissals that are not (#2774,
  // consequence B). A consumer hosting a form that may hold five typed minutes of
  // family history routes them through a confirm; a transactional quick-entry
  // sheet leaves this unset and keeps its one-flick discard (#1428).
  onGestureDismiss?: () => void;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const { mounted, phase } = usePresence(open, motionMs("sheet", reduceMotion));
  const localPanelRef = useRef<HTMLDivElement>(null);
  const panelRef = externalPanelRef ?? localPanelRef;
  const handleRef = useRef<HTMLDivElement>(null);
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
  useFocusTrap({ panelRef, onClose, initialFocusRef, active: open });

  // Drag-to-dismiss (#1425), on the shared recognizer (#1469). THE SHEET'S
  // OUTCOME IS DISCARD — that is what the lifecycle contract above licenses, and
  // it is the whole difference between this call site and the activity dock's,
  // which passes `onMinimize` to the very same hook. Enabled only while open, so
  // a sheet already playing its exit can't be re-grabbed.
  const { suppressMotion } = useOverlayDrag({
    panelRef,
    grabRef: handleRef,
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
  // Scrim tap and flick share ONE exit, so a consumer that guards discards
  // cannot accidentally guard half of them.
  const dismissByGesture = onGestureDismiss ?? onClose;

  // Where the panel sits in the viewport, and the chrome that follows from it.
  // Bottom-anchored surfaces square off against the screen edge and clear the
  // home indicator; a centred card floats, so it rounds all the way round and
  // owes the home indicator nothing.
  const containerAnchor = asCentered
    ? "items-center p-4"
    : asDialog
      ? "items-end md:items-center md:p-4"
      : "items-end";
  const panelShape = asCentered
    ? "max-h-[85dvh] rounded-2xl border px-4 pt-4 pb-4 sm:px-6 sm:pt-5 sm:pb-5"
    : `max-h-[85dvh] border-t px-4 pt-1 sm:pb-4 ${OVERLAY_PANEL_RADIUS_BOTTOM} ${OVERLAY_SAFE_BOTTOM} ${
        asDialog ? "md:max-h-[80dvh] md:border md:px-6 md:pt-5 md:pb-5" : ""
      }`;
  const titleClass = titleHidden
    ? "sr-only"
    : `font-semibold text-slate-900 dark:text-slate-100 ${
        asDialog || asCentered ? "text-lg" : "text-base"
      }`;
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
    >
      <div
        className={`${OVERLAY_SCRIM} ${backdropMotion}`}
        onClick={dismissByGesture}
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
        // THE PANEL DOES NOT SCROLL — its content region does (#2774). Before
        // this the panel was the scroller and the header scrolled away with the
        // form; more importantly, ModalShell's version of the same shape scrolled
        // a `fixed inset-0` container over an UNLOCKED body, so a drag its
        // scroller declined chained straight out to the document and the page
        // underneath drifted. One scroll owner, `overscroll-contain` on it, and a
        // locked body behind it is the whole of that fix.
        className={`relative flex w-full flex-col overflow-hidden bg-surface outline-hidden ${OVERLAY_PANEL_MAX_WIDTH[size]} ${OVERLAY_PANEL_BORDER} ${OVERLAY_PANEL_ELEVATION} ${panelShape} ${panelMotion}`}
      >
        {/* The drag affordance, now functional (#1425): a downward drag from
        here dismisses the sheet. A centered dialog is not flickable, so the
        responsive presentation drops the handle from `md` up exactly where that
        stops being true (#1428) — and the recognizer goes with it, since a
        hidden element receives no pointer events. A card centred at EVERY width
        never draws one at all. */}
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
              className="shrink-0 text-slate-500 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-300"
              aria-label="Close"
              title="Close"
            >
              <IconX className="h-5 w-5" />
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
        <div
          className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
          data-sheet-content
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
