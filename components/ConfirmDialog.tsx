"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import BottomSheet from "./BottomSheet";

// App-wide confirmation dialog, replacing native window.confirm(). Mounted once
// in the root layout; any client component calls `useConfirm()` to get an async
// `confirm(options)` that resolves true (confirmed) or false (cancelled or
// dismissed). It mirrors confirm()'s boolean contract, so a call site stays a
// one-line `if (!(await confirm({...}))) return;`.
//
// ── Presentation (issue #1428, section A) ────────────────────────────────────
//
// A confirm is a DECISION, and on a phone the decision used to be parked near
// the top of the screen (`mt-[10vh]`) — out of thumb reach, in the one place a
// one-handed user cannot answer it. It now renders through the shared
// BottomSheet primitive with `presentation="dialog"`: a thumb-reachable sheet
// below `md`, the familiar centered card from `md` up. Content is authored ONCE
// here and the primitive owns the viewport difference — no `hidden md:*` pair to
// drift (the responsive-surfaces rule), and no second focus trap / Escape
// handler / backdrop to keep in sync with the sheet's (this file used to carry
// its own hand-rolled copy of all three; useFocusTrap is now the one
// implementation, which is why lib/focus-trap.ts's nextTrapFocusIndex lost its
// last consumer here).
//
// The transactional lifecycle the sheet demands is exactly a confirm's: dismiss
// means "cancelled", and cancelling is safe. Destructive confirms keep their
// EXPLICIT buttons — no swipe-to-confirm (#1428 / #1425's no-destructive-
// gestures posture) — so the only gesture that reaches the sheet is dismissal.
export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string; // default "Confirm"
  cancelLabel?: string; // default "Cancel"
  danger?: boolean; // red confirm button for destructive actions
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);
// Is a confirm on screen right now? A SEPARATE context from the `confirm` fn
// above, because the two have opposite change profiles: `confirm` is stable for
// the life of the app and every call site consumes it, while this flips on every
// open/close and only a transient surface layered UNDERNEATH the dialog cares.
// One context carrying both would re-render every consumer of `useConfirm` twice
// per confirm.
//
// Defaults to `false` rather than throwing (unlike `useConfirm`): asking "is a
// decision open over me?" outside a provider has an honest answer — no — and a
// shared primitive must not become un-renderable outside the app shell just
// because it started asking.
const ConfirmOpenContext = createContext(false);

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

// The last request's options + a per-request nonce, RETAINED after the dialog
// closes. Two reasons: the panel keeps its text through the sheet's exit
// animation (a confirm that blanks to an empty card on its way out is worse than
// no animation), and the nonce keys the panel so each new request REMOUNTS it —
// which is what re-runs useFocusTrap's mount-time initial focus, so the second
// confirm of a session still opens with its confirm button focused (Enter
// confirms, the keyboard contract this dialog has always had).
interface Retained {
  options: ConfirmOptions;
  nonce: number;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [retained, setRetained] = useState<Retained | null>(null);

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
      // Set synchronously alongside `pending` (React batches both), so the panel
      // has its content on the very first render of the open state.
      setRetained((prev) => ({ options, nonce: (prev?.nonce ?? 0) + 1 }));
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
      <ConfirmOpenContext.Provider value={pending != null}>
        {children}
      </ConfirmOpenContext.Provider>
      {retained && (
        <ConfirmModal
          key={retained.nonce}
          options={retained.options}
          open={pending != null}
          onSettle={settle}
        />
      )}
    </ConfirmContext.Provider>
  );
}

function ConfirmModal({
  options,
  open,
  onSettle,
}: {
  options: ConfirmOptions;
  open: boolean;
  onSettle: (ok: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  const {
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  } = options;

  return (
    <BottomSheet
      open={open}
      // Dismissal — backdrop tap, Escape, or (below `md`) flicking the sheet away
      // once #1425 lands — is CANCEL, mirroring window.confirm()'s contract.
      onClose={() => onSettle(false)}
      title={title}
      testId="confirm-dialog"
      presentation="dialog"
      // Above the toasts (`z-100`): a confirm is a question the viewer has to
      // answer before anything else, so nothing may paint over it.
      zIndexClass="z-110"
      // Focus the confirm button on open so Enter confirms — the keyboard
      // contract this dialog has always had.
      initialFocusRef={confirmRef}
    >
      {message != null && (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {message}
        </div>
      )}
      {/* Explicit buttons, always — a destructive confirm is never a gesture. */}
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
    </BottomSheet>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}

// True while a confirm is on screen. For a surface that must stand down when a
// decision opens over it — see OverflowMenu, whose click-away backdrop otherwise
// outlives the interaction that opened the dialog (#2599).
export function useConfirmOpen(): boolean {
  return useContext(ConfirmOpenContext);
}
