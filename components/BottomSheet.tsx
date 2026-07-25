"use client";

import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./useFocusTrap";
import { usePresence } from "./usePresence";
import { useLockBodyScroll } from "./useLockBodyScroll";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { motionMs } from "@/lib/motion";

// The bottom sheet — the phone's modal surface (issue #1416, section E).
//
// A PRIMITIVE, not a one-off: it is ModalShell's thumb-reachable sibling, and it
// is deliberately content-agnostic so the follow-ups can build on it rather than
// beside it (#1428 generalizes the sheet to more surfaces; #1425 adds
// drag-to-dismiss). The seams that exist for them:
//
//   * ONE transformed element. The panel is the only thing that moves — its
//     enter/exit animation is a `translateY` on `[data-sheet-panel]` and nothing
//     wraps it in a second transform. A drag layer can therefore take the panel
//     ref and write `style.transform` directly during the gesture, then hand it
//     back to the class-driven animation on release, without fighting a parent.
//   * `panelRef` is forwarded so that layer needs no fork of this file.
//   * The drag handle is already rendered (`[data-testid="sheet-drag-handle"]`)
//     as the affordance the gesture will attach to — it reads as draggable today
//     and becomes draggable in #1425 with no visual change.
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

export type SheetPresentation = "sheet" | "dialog";

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
  zIndexClass = "z-[60]",
  titleHidden = false,
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
  // Sheet everywhere (default) vs sheet-below-`md`/centered-above. See above.
  presentation?: SheetPresentation;
  // The stacking layer. Defaults to the sheet's own `z-[60]`. A surface that must
  // out-rank the toasts (`z-[100]`) — a confirm, which is a DECISION the viewer
  // has to reach — passes its own. Kept a full class string so Tailwind's
  // scanner sees a literal (a computed `z-[${n}]` would never be generated).
  zIndexClass?: string;
  // Keep the title as the sheet's ACCESSIBLE name but let the mounted content
  // own the visible heading. For a sheet hosting an existing form component (the
  // #1468 quick-entry overlay mounts BodyQuickAdd / VitalsQuickAdd, each of which
  // already renders its own "Log …" heading) showing both prints the same
  // sentence twice. The sheet still HAS a name — `aria-labelledby` points at the
  // visually-hidden heading — so screen readers announce it exactly as before;
  // this is never a way to ship a nameless dialog.
  titleHidden?: boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const { mounted, phase } = usePresence(open, motionMs("sheet", reduceMotion));
  const localPanelRef = useRef<HTMLDivElement>(null);
  const panelRef = externalPanelRef ?? localPanelRef;
  const titleId = useId();
  const descriptionId = useId();

  useLockBodyScroll(mounted);
  // Stop trapping focus / answering Escape the moment the exit starts, so a
  // closing sheet can't swallow the next Escape or steal focus back.
  useFocusTrap({ panelRef, onClose, initialFocusRef, active: open });

  if (!mounted || typeof document === "undefined") return null;

  const entering = phase === "enter";
  const asDialog = presentation === "dialog";
  const backdropMotion = reduceMotion
    ? ""
    : entering
      ? "motion-fade-in"
      : "motion-fade-out";
  // The panel's travel. A plain sheet always slides up; the responsive dialog
  // uses the `.motion-dialog-*` pair, which IS the slide-up below `md` and
  // becomes a fade from `md` up — the media query lives in the stylesheet so one
  // class name covers both viewports (a JS width check would need a resize
  // listener and would still be wrong between hydration and the first paint).
  const panelMotion = reduceMotion
    ? ""
    : asDialog
      ? entering
        ? "motion-dialog-in"
        : "motion-dialog-out"
      : entering
        ? "motion-slide-up-in"
        : "motion-slide-up-out";

  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClass} flex justify-center ${
        asDialog ? "items-end md:items-center md:p-4" : "items-end"
      }`}
      data-testid={testId}
      data-phase={phase}
      data-presentation={presentation}
    >
      <div
        className={`absolute inset-0 bg-slate-900/40 dark:bg-black/70 ${backdropMotion}`}
        onClick={onClose}
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
        className={`relative flex max-h-[85dvh] w-full flex-col overflow-y-auto rounded-t-2xl border-t border-black/10 bg-white px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl outline-none sm:max-w-md sm:rounded-2xl sm:pb-4 dark:border-white/10 dark:bg-ink-900 ${
          asDialog ? "md:max-h-[80dvh] md:border md:px-6 md:pt-5 md:pb-5" : ""
        } ${panelMotion}`}
      >
        {/* Drag-handle affordance (#1425 will make it functional). Decorative
        today: it is what makes the surface read as a sheet you can flick away.
        A centered dialog is not flickable, so the responsive presentation drops
        the handle exactly where it stops being true (#1428). */}
        <div
          data-testid="sheet-drag-handle"
          aria-hidden
          className={`mx-auto mb-2 h-1.5 w-10 shrink-0 rounded-full bg-slate-300 dark:bg-ink-700 ${
            asDialog ? "md:hidden" : ""
          }`}
        />
        <h2
          id={titleId}
          className={
            titleHidden
              ? "sr-only"
              : `font-semibold text-slate-900 dark:text-slate-100 ${
                  asDialog ? "text-lg" : "text-base"
                }`
          }
        >
          {title}
        </h2>
        {description && (
          <p
            id={descriptionId}
            className="mt-0.5 text-sm text-slate-500 dark:text-slate-400"
          >
            {description}
          </p>
        )}
        <div className="mt-3">{children}</div>
      </div>
    </div>,
    document.body
  );
}
