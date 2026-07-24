"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  IconCircleCheck,
  IconAlertTriangle,
  IconX,
  IconArrowRight,
} from "@tabler/icons-react";
import { upsertToast, dismissKeyed } from "@/lib/toast-upsert";

// App-wide lightweight toast for confirming user actions (form saves, deletes,
// etc.). Mounted once in the root layout; any client component calls `useToast()`
// to get a `toast(message, options?)` function. Since #1315 this is the ONE toast
// system: the background watchers (ExtractionToaster for medical extraction,
// ImportJobsToaster for paste/CSV jobs) are headless and post through here. A toast
// posted with a `key` REPLACES the live toast with the same key in place — the
// upload confirmation and its extraction-complete toast share one slot that
// upgrades, instead of stacking — and `useDismissToast()` clears a keyed slot.
type Tone = "success" | "error";

// An optional call-to-action rendered as a link inside the toast (e.g. "View
// results" to jump to a preview). Clicking it runs `onClick` and dismisses.
interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  tone?: Tone;
  // Auto-dismiss delay in ms, or null to keep the toast up until the user
  // dismisses it by hand (the close button).
  duration?: number | null;
  action?: ToastAction;
  // When set, this toast REPLACES the live toast carrying the same key in place
  // (position kept, timer reset) instead of stacking — so a lifecycle slot can
  // upgrade ("Uploaded — reading…" → "12 records ✓"). Keyless toasts always stack.
  key?: string;
}

interface ToastItem {
  id: number;
  key?: string;
  // Bumped on each in-place replace so the card's dismiss timer restarts (#1315).
  revision: number;
  tone: Tone;
  message: string;
  duration: number | null;
  action?: ToastAction;
}

type ToastFn = (message: string, options?: ToastOptions) => void;
type DismissKeyFn = (key: string) => void;

interface ToastApi {
  toast: ToastFn;
  dismissKey: DismissKeyFn;
}

// Default auto-dismiss by tone (ms). Errors linger longer since they carry
// something to read.
const DEFAULT_DURATION: Record<Tone, number> = { success: 6000, error: 10000 };

const ToastContext = createContext<ToastApi | null>(null);

let seq = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const dismissKey = useCallback<DismissKeyFn>((key) => {
    setToasts((list) => dismissKeyed(list, key));
  }, []);

  const toast = useCallback<ToastFn>((message, options = {}) => {
    const tone = options.tone ?? "success";
    const duration =
      options.duration === undefined
        ? DEFAULT_DURATION[tone]
        : options.duration;
    setToasts((list) =>
      upsertToast(list, {
        id: ++seq,
        key: options.key,
        revision: 0,
        tone,
        message,
        duration,
        action: options.action,
      })
    );
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ toast, dismissKey }),
    [toast, dismissKey]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-[100] flex flex-col gap-2">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} dismiss={dismiss} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({
  toast,
  dismiss,
}: {
  toast: ToastItem;
  dismiss: (id: number) => void;
}) {
  const success = toast.tone === "success";
  const { duration } = toast;
  // Stable per-toast dismiss (keyed by id). Building `() => dismiss(id)` inline in
  // the parent map produced a fresh closure on every render, so the auto-dismiss
  // effect below re-ran and restarted every toast's countdown whenever any toast
  // was added or removed. `dismiss` is a stable useCallback, so this is too.
  const onDismiss = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);
  // Auto-dismiss after `duration` ms; a null duration keeps the toast up until
  // the user closes it by hand. `toast.revision` is a dep so an in-place keyed
  // replace (which keeps the id, so onDismiss is stable) restarts the countdown
  // (#1315) instead of letting the pre-replace timer fire on the new message.
  const { revision } = toast;
  useEffect(() => {
    if (duration == null) return;
    const id = setTimeout(onDismiss, duration);
    return () => clearTimeout(id);
  }, [onDismiss, duration, revision]);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast"
      data-toast-key={toast.key}
      className={`flex w-72 items-start gap-3 rounded-xl border bg-white p-3.5 shadow-lg dark:bg-ink-900 ${
        success
          ? "border-emerald-200 dark:border-emerald-800"
          : "border-rose-200 dark:border-rose-800"
      }`}
    >
      <span className="leading-none">
        {success ? (
          <IconCircleCheck className="h-5 w-5 text-emerald-500" />
        ) : (
          <IconAlertTriangle className="h-5 w-5 text-amber-500" />
        )}
      </span>
      <div className="flex-1">
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {toast.message}
        </p>
        {toast.action && (
          <button
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            {toast.action.label}
            <IconArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400"
      >
        <IconX className="h-4 w-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx.toast;
}

// Programmatically dismiss a keyed toast slot (#1315) — used by the headless
// watchers to clear the upload confirmation once real extraction results arrive.
// Dismissing an unknown key is a no-op.
export function useDismissToast(): DismissKeyFn {
  const ctx = useContext(ToastContext);
  if (!ctx)
    throw new Error("useDismissToast must be used within a ToastProvider");
  return ctx.dismissKey;
}
