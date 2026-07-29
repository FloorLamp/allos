"use client";

import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";
import { useFocusTrap } from "./useFocusTrap";

// Accessible modal chrome, extracted from the pattern in ConfirmDialog.tsx so
// content modals don't re-implement (and drift on) the a11y wiring: a portal +
// backdrop, role="dialog"/aria-modal/aria-labelledby, Escape-to-close (capture
// phase + stopPropagation, so it doesn't also trip a background Escape handler),
// initial focus into the dialog, and a Tab focus trap. The consumer renders the
// body as children; the titled header (with a Close button) is drawn here.
//
// Pass initialFocusRef to focus a specific field on open (e.g. a search input)
// instead of the first focusable element (which would be the Close button).

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

  // Initial focus, Escape-to-close and the Tab trap all live in the ONE shared
  // hook (components/useFocusTrap.ts) — the bottom sheet is its second consumer.
  useFocusTrap({ panelRef, onClose, initialFocusRef });

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
            title="Close"
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
