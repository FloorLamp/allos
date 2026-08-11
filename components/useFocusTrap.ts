"use client";

import { useEffect } from "react";
import { useLatestRef } from "./useLatestRef";

// The modal a11y wiring — initial focus, Escape-to-close, and a Tab focus trap —
// as ONE hook (issue #1416).
//
// It was inlined in ModalShell; the bottom sheet (components/BottomSheet.tsx) is
// the second overlay that owes a viewer exactly the same contract, and a
// hand-copied second trap is how two overlays come to disagree about whether
// Escape bubbles or which element takes focus on open. Both now call this, so
// there is one implementation to fix.
//
// Escape is handled on the CAPTURE phase with stopPropagation so closing the
// top-most overlay doesn't also trip a background Escape handler (e.g. the
// mobile drawer's, under a sheet opened from it).

export function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

export function useFocusTrap({
  panelRef,
  onClose,
  initialFocusRef,
  active = true,
}: {
  panelRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  // Lets a consumer that keeps the panel mounted through an exit animation stop
  // trapping focus (and stop answering Escape) the moment it starts closing.
  active?: boolean;
}) {
  // Read onClose through a ref so the focus/keydown effects can run once on
  // mount without depending on its identity. Consumers routinely pass an inline
  // arrow that changes every render; an effect keyed on it would re-run on every
  // keystroke and yank focus back to the first field mid-typing.
  const onCloseRef = useLatestRef(onClose);

  // Initial focus — once, on mount. Prefer the consumer's requested element,
  // then the first focusable (skipping past nothing — it's the Close button by
  // DOM order), then the panel itself.
  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;
    (initialFocusRef?.current ?? focusablesIn(panel)[0] ?? panel).focus();
    // panelRef/initialFocusRef are stable refs; `active` only flips on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape-to-close + Tab focus trap. Registered once; reads the latest onClose
  // through the ref so a consumer re-render (e.g. typing) never re-runs this.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === "Escape") {
        // A nested picker may own this Escape first (DateField's portaled
        // calendar is the first tenant). The marker is present only while that
        // child layer is open; its own key handler closes the child as the event
        // continues down from this window-capture listener. A second Escape then
        // reaches the parent modal normally.
        const target = e.target;
        if (
          target instanceof Element &&
          target.closest('[data-escape-layer="true"]')
        ) {
          return;
        }
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const els = focusablesIn(panel);
      if (els.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panelRef, active, onCloseRef]);
}
