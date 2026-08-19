"use client";

import { useCallback, useRef } from "react";
import BottomSheet, { type SheetPresentation } from "./BottomSheet";
import { useOptionalConfirm } from "./ConfirmDialog";
import { useUnsavedInputWithin } from "./DirtyFormRegistry";
import type { OverlaySize } from "./overlay";

// The app's dialog host — now a THIN WRAPPER over the one responsive dialog
// primitive (components/BottomSheet.tsx, `presentation="dialog"`).
//
// ── Why this file still exists (issue #2774) ─────────────────────────────────
//
// It used to be the app's SECOND dialog primitive, and that was the defect. It
// rendered its own portal, its own backdrop and its own `fixed inset-0
// overflow-y-auto` scroller — so the app had two "centred card on desktop"
// implementations with different chrome, insets, widths and scroll ownership,
// which is the hand-mirrored-second-engine shape docs/internals/overlays.md
// names, one layer above where #1469 fixed it. Three costs, each observed:
//
//   1. Phones got a centred floating card outside the sheet idiom every other
//      phone surface converged on (#1425/#1469) — a desktop shape at thumb
//      distance, with no safe-area posture and no gesture system.
//   2. THE PAGE SCROLLED BEHIND IT. The scroller was a full-viewport container
//      over an UNLOCKED body, so a drag (or wheel) it declined chained out to
//      the document and on release the page sat somewhere other than where the
//      dialog was opened from.
//   3. Width was hardcoded per host: a `className` override at every call site,
//      `max-w-sm` through `max-w-5xl`, so "how wide is a dialog?" had thirty
//      answers.
//
// All three retire at once by having ONE primitive. It is a wrapper rather than
// a deletion so that the 34 call sites keep their import and their two-prop
// shape: what changed is what "modal" RENDERS as, which is exactly the surface
// area #2774 asked to change.
//
// What a consumer gets from here that a raw BottomSheet does not:
//
//   * `presentation="dialog"` by default — a sheet below `md`, a centred card
//     above — plus the explicit Close control a card needs (a sheet has its drag
//     handle and its scrim; a centred card has neither).
//   * A DECLARED SIZE instead of a `className` width (see OverlaySize).
//   * The dirty-discard guard below.
//
// ── Discarding a dirty form (issue #2774, consequence B) ─────────────────────
//
// The sheet's transactional contract is discard-on-flick (#1428), which is right
// for a half-typed weight and wrong for five typed minutes of family history.
// The forms behind THIS host are the second kind, so a gesture dismissal — a
// flick on the handle, a tap on the scrim — asks first when the hosted form
// holds unsaved input, through the app's existing ConfirmDialog. A clean form
// still dismisses in one gesture: the confirm appears only when there is
// something to lose, which is what keeps it from becoming a click-through.
//
// Escape and the Close button are deliberately NOT guarded. They are targeted
// actions on a named control — the user aimed at "close" — where a flick and a
// scrim tap are the two dismissals a hand can produce by accident.
export default function ModalShell({
  title,
  onClose,
  children,
  size = "md",
  presentation = "dialog",
  initialFocusRef,
  testId = "modal-shell",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  // How wide the card gets from `sm` up. Replaces the per-host `className`
  // width overrides (#2774); content stays intrinsic per #2014.
  size?: OverlaySize;
  // Only a RECORDED anatomy exception passes this — a surface with no bottom
  // edge to flick toward at any width (the command palette, the camera
  // fallback). Each one is registered in
  // lib/__tests__/overlay-motion-chokepoint.test.ts with its justification.
  presentation?: Extract<SheetPresentation, "dialog" | "centered">;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirm = useOptionalConfirm();
  const hasUnsavedInputWithin = useUnsavedInputWithin();

  const onGestureDismiss = useCallback(() => {
    if (!confirm || !hasUnsavedInputWithin(panelRef.current)) {
      onClose();
      return;
    }
    void confirm({
      title: "Discard your changes?",
      message: "This form has entries you have not saved yet.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    }).then((ok) => {
      if (ok) onClose();
    });
    // REFUSED, for now. The dialog is staying open behind the confirm, so the
    // panel must come back to rest — without this a flick leaves the form parked
    // off the bottom edge, and "Keep editing" keeps the typing and loses the
    // surface it was typed into.
    return false;
  }, [confirm, hasUnsavedInputWithin, onClose]);

  return (
    <BottomSheet
      // A consumer renders `{open && <ModalShell/>}`, so mounting IS opening.
      // The exit animation therefore does not play here (the element is gone
      // before it could) — the same as this host has always behaved, and not
      // worth pushing an `open` prop through 34 call sites to gain.
      open
      onClose={onClose}
      onGestureDismiss={onGestureDismiss}
      title={title}
      presentation={presentation}
      size={size}
      showClose
      testId={testId}
      panelRef={panelRef}
      initialFocusRef={initialFocusRef}
    >
      {children}
    </BottomSheet>
  );
}
