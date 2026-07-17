"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { nextTrapFocusIndex } from "@/lib/focus-trap";

// App-wide confirmation dialog, replacing native window.confirm(). Mounted once
// in the root layout; any client component calls `useConfirm()` to get an async
// `confirm(options)` that resolves true (confirmed) or false (cancelled or
// dismissed). It mirrors confirm()'s boolean contract, so a call site stays a
// one-line `if (!(await confirm({...}))) return;`.
export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string; // default "Confirm"
  cancelLabel?: string; // default "Cancel"
  danger?: boolean; // red confirm button for destructive actions
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  // Mirror `pending` into a ref so the unmount cleanup below can settle an
  // outstanding request without capturing a stale value.
  const pendingRef = useRef<Pending | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  // If the provider unmounts with a dialog still open, resolve it (cancelled)
  // so the awaiting caller never hangs.
  useEffect(() => () => pendingRef.current?.resolve(false), []);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      // If a confirm is already open, settle it (cancelled) before replacing it,
      // so its awaiter never hangs when a second request supersedes it.
      setPending((prev) => {
        prev?.resolve(false);
        return { options, resolve };
      });
    });
  }, []);

  // Settle the outstanding promise and close. Resolving inside the updater keeps
  // the resolve tied to the exact pending request; a double-resolve (e.g. Esc
  // racing a click) is a harmless no-op.
  const settle = useCallback((ok: boolean) => {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmModal options={pending.options} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmModal({
  options,
  onSettle,
}: {
  options: ConfirmOptions;
  onSettle: (ok: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Esc cancels; focus the confirm button on open so Enter confirms and the
  // dialog is reachable by keyboard. The listener runs in the capture phase and
  // stops propagation, so while the dialog is open Escape is consumed here and
  // doesn't also reach a background handler (e.g. the activity editor's own
  // Escape-to-close, which would otherwise re-open a confirm). Tab is trapped at
  // the dialog edges so keyboard focus can't wander back to the (inert)
  // background — a real modal focus trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onSettle(false);
        return;
      }
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));
        const active = document.activeElement as HTMLElement | null;
        // Pure wrap decision (#832) — component owns the DOM, lib owns the branches.
        const target = nextTrapFocusIndex(
          focusables.length,
          active ? focusables.indexOf(active) : -1,
          !!active && root.contains(active),
          e.shiftKey
        );
        if (target !== null) {
          e.preventDefault();
          focusables[target].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onSettle]);

  const {
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  } = options;

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8 dark:bg-black/70"
      onClick={() => onSettle(false)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mt-[10vh] w-full max-w-md rounded-xl bg-white p-4 shadow-xl sm:p-6 dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id={titleId}
          className="text-lg font-bold text-slate-900 dark:text-slate-100"
        >
          {title}
        </h2>
        {message != null && (
          <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {message}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onSettle(false)}
            className="btn-ghost"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onSettle(true)}
            className={danger ? "btn-danger" : "btn"}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}
