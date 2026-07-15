"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";

// Accessible modal chrome, extracted from the pattern in ConfirmDialog.tsx so
// content modals don't re-implement (and drift on) the a11y wiring: a portal +
// backdrop, role="dialog"/aria-modal/aria-labelledby, Escape-to-close (capture
// phase + stopPropagation, so it doesn't also trip a background Escape handler),
// initial focus into the dialog, and a Tab focus trap. The consumer renders the
// body as children; the titled header (with a Close button) is drawn here.
//
// Pass initialFocusRef to focus a specific field on open (e.g. a search input)
// instead of the first focusable element (which would be the Close button).

function focusablesIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

export default function ModalShell({
  title,
  onClose,
  children,
  className = "w-full max-w-2xl rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900",
  initialFocusRef,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Read onClose through a ref so the focus/keydown effects can run once on
  // mount without depending on its identity. Consumers routinely pass an inline
  // arrow that changes every render; an effect keyed on it would re-run on every
  // keystroke and yank focus back to the first field mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Initial focus — once, on mount. Prefer the consumer's requested element,
  // then the first focusable (skipping past nothing — it's the Close button by
  // DOM order), then the panel itself.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    (initialFocusRef?.current ?? focusablesIn(panel)[0] ?? panel).focus();
  }, [initialFocusRef]);

  // Escape-to-close + Tab focus trap. Registered once; reads the latest onClose
  // through the ref so a consumer re-render (e.g. typing) never re-runs this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === "Escape") {
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
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8 dark:bg-black/70"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={className}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id={titleId}
            className="text-lg font-bold text-slate-900 dark:text-slate-100"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-slate-500 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-300"
            aria-label="Close"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
