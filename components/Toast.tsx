"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconCircleCheck,
  IconAlertTriangle,
  IconX,
  IconArrowRight,
} from "@tabler/icons-react";
import {
  upsertToast,
  dismissKeyed,
  beginExit,
  dropExited,
  visibleToasts,
  dismissOtherProfileToasts,
  clearProfileToasts,
  acceptsProfileToast,
  type ProfileToastScope,
} from "@/lib/toast-upsert";
import { motionClass, motionMs, overlayMotionClass } from "@/lib/motion";
import { useCompactViewport } from "@/components/useCompactViewport";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { useHaptics } from "@/components/useHaptics";
import { toastHaptic } from "@/lib/haptics";
import {
  BOTTOM_EDGE_GUTTER_LEFT,
  BOTTOM_EDGE_GUTTER_RIGHT,
  BOTTOM_EDGE_NOTICE_BOTTOM,
  BOTTOM_EDGE_NOTICE_LAYER,
} from "@/components/overlay/tokens";

// App-wide lightweight toast for confirming user actions (form saves, deletes,
// etc.). Mounted once in the root layout; any client component calls `useToast()`
// to get a `toast(message, options?)` function. Since #1315 this is the ONE toast
// system: the background watchers (ExtractionToaster for medical extraction,
// ImportJobsToaster for paste/CSV jobs) are headless and post through here. A toast
// posted with a `key` REPLACES the live toast with the same key in place — the
// upload confirmation and its extraction-complete toast share one slot that
// upgrades, instead of stacking — and `useDismissToast()` clears a keyed slot.
//
// ── TWO SHAPES, ONE SYSTEM (issue #3373) ─────────────────────────────────────
//
// Below `md` a toast is a SNACKBAR: one full-width bar gutter to gutter on the
// bottom edge, one at a time, with the rest queued behind it. From `md` up it is
// the corner stack it has always been — `w-72` cards at the right gutter, all of
// them at once. A 288px card hugging the right edge of a 390px screen reads as a
// misplaced fragment rather than a confirmation, which is what the phone shape
// fixes; the desktop shape was never the problem, so it is untouched.
//
// What does NOT fork: the `useToast`/`useDismissToast` API, the keyed upsert
// semantics, the tones, the durations, and the LAYER. The bar keeps riding the
// bottom-edge claim (#1520/#2651) so it clears whichever dock is up, and it keeps
// out-ranking the drawer's scrim and the sheets — a "saved offline" confirmation
// posted from inside an open sheet must be seen, not buried (#3038). Queueing is
// between toasts and NEVER between a toast and an overlay: nothing is ever held
// back because something else is open.
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
  // Subject stamp for health-data receipts that can survive navigation. Profile
  // switching clears every toast whose stamp no longer matches, queued or shown.
  profileId?: number;
  profileToken?: number;
  // Opaque interaction-lifecycle ownership for conditional keyed publication
  // and cleanup. A newer same-key claim still owns the shared slot globally.
  owner?: symbol;
  // A continuation may publish only while its interaction-start reservation
  // still owns the key. Initial/legacy keyed posts omit this and claim normally.
  onlyIfOwner?: boolean;
  // NOT THE PERSON'S DOING (#3699). A headless poster — extraction finishing, an
  // import job, autosave on a timer, the offline queue replaying — announces
  // something nobody just did, so it carries no haptic: a phone that buzzes while it
  // sits on a table is worse than one that never buzzes at all. Visually identical;
  // this says only "do not tap the shoulder".
  silent?: boolean;
}

interface ToastItem {
  id: number;
  key?: string;
  profileId?: number;
  profileToken?: number;
  owner?: symbol;
  // Bumped on each in-place replace so the card's dismiss timer restarts (#1315).
  revision: number;
  // Set while the bar plays its exit animation; see lib/toast-upsert.ts.
  exiting?: boolean;
  tone: Tone;
  message: string;
  duration: number | null;
  action?: ToastAction;
}

type ToastFn = (message: string, options?: ToastOptions) => void;
type DismissKeyFn = (key: string, owner?: symbol) => void;
type ClaimKeyFn = (
  key: string,
  owner: symbol,
  dismissCurrent?: boolean
) => void;
type ActivateProfileFn = (activeProfileId: number | null) => void;
type GetProfileScopeFn = () => ProfileToastScope | null;

interface ToastApi {
  toast: ToastFn;
  dismissKey: DismissKeyFn;
  claimKey: ClaimKeyFn;
  activateProfile: ActivateProfileFn;
  profileScope: ProfileToastScope | null;
  getProfileScope: GetProfileScopeFn;
}

// Default auto-dismiss by tone (ms). Errors linger longer since they carry
// something to read.
const DEFAULT_DURATION: Record<Tone, number> = { success: 6000, error: 10000 };

const ToastContext = createContext<ToastApi | null>(null);
const mountedProfileActivators = new Set<ActivateProfileFn>();

// Sign-out begins before the authenticated layout unmounts. These module-level
// relays let that boundary clear/re-arm every mounted provider without making the
// reusable logout control require a ToastProvider in isolation tests.
export function clearProfileToastsForLogout(): void {
  for (const activate of mountedProfileActivators) activate(null);
}

export function restoreToastProfileAfterFailedLogout(profileId: number): void {
  for (const activate of mountedProfileActivators) activate(profileId);
}

let seq = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [profileScope, setProfileScope] = useState<ProfileToastScope | null>(
    null
  );
  const profileScopeRef = useRef<ProfileToastScope | null>(null);
  const profileTokenRef = useRef(0);
  const keyedOwnersRef = useRef(new Map<string, symbol>());
  const reduceMotion = usePrefersReducedMotion();
  const haptic = useHaptics();
  const snackbar = useCompactViewport();
  const exitMs = motionMs("notice", reduceMotion);

  // Dismissal is two steps: mark the toast so it plays its exit animation, then
  // drop it when the animation is over. Under reduced motion `exitMs` is 0 and the
  // timeout runs on the next tick, so the sequence is the same and simply snaps.
  const dismiss = useCallback(
    (id: number, preserveOwner = false) => {
      setToasts((list) => {
        const item = list.find((toast) => toast.id === id);
        if (
          !preserveOwner &&
          item?.key != null &&
          item.owner != null &&
          keyedOwnersRef.current.get(item.key) === item.owner
        )
          keyedOwnersRef.current.delete(item.key);
        return beginExit(list, id);
      });
      setTimeout(() => setToasts((list) => dropExited(list, id)), exitMs);
    },
    [exitMs]
  );

  const dismissKey = useCallback<DismissKeyFn>((key, owner) => {
    if (owner != null && keyedOwnersRef.current.get(key) !== owner) return;
    keyedOwnersRef.current.delete(key);
    setToasts((list) => dismissKeyed(list, key, owner));
  }, []);

  const claimKey = useCallback<ClaimKeyFn>(
    (key, owner, dismissCurrent = true) => {
      keyedOwnersRef.current.set(key, owner);
      if (dismissCurrent) setToasts((list) => dismissKeyed(list, key));
    },
    []
  );

  const activateProfile = useCallback<ActivateProfileFn>((activeProfileId) => {
    const token = ++profileTokenRef.current;
    const next =
      activeProfileId == null ? null : { profileId: activeProfileId, token };
    profileScopeRef.current = next;
    setProfileScope(next);
    setToasts((list) =>
      activeProfileId == null
        ? clearProfileToasts(list)
        : dismissOtherProfileToasts(list, activeProfileId)
    );
  }, []);
  useEffect(() => {
    mountedProfileActivators.add(activateProfile);
    return () => {
      mountedProfileActivators.delete(activateProfile);
    };
  }, [activateProfile]);

  // State is for consumers that render the scope. Interaction handlers need the
  // commit-current value synchronously, including hydration-replayed events that
  // run before passive effects have caused another render.
  const getProfileScope = useCallback<GetProfileScopeFn>(
    () => profileScopeRef.current,
    []
  );

  // WHERE EVERY WRITE IN THE APP GAINS A CONFIRMATION YOUR HAND CAN FEEL (#3699).
  // This provider is mounted once and is the ONE toast system (#1315), so a cue fired
  // here reaches all ~105 `useToast()` callers with no call site changed and no new API
  // surface — which is the whole reason haptics mount on substrates rather than on
  // hand-placed calls. It fires only for a toast that actually posts: a scope-refused
  // or unowned keyed post has announced nothing, so it must not buzz either.
  const toast = useCallback<ToastFn>((message, options = {}) => {
    if (!acceptsProfileToast(profileScopeRef.current, options)) return;
    if (options.key != null) {
      if (options.onlyIfOwner) {
        if (
          options.owner == null ||
          keyedOwnersRef.current.get(options.key) !== options.owner
        )
          return;
      } else if (options.owner != null) {
        keyedOwnersRef.current.set(options.key, options.owner);
      } else {
        // A legacy/global keyed post is itself a newer claim.
        keyedOwnersRef.current.delete(options.key);
      }
    }
    const tone = options.tone ?? "success";
    const cue = toastHaptic({ tone, silent: options.silent });
    if (cue) haptic(cue);
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
        profileId: options.profileId,
        profileToken: options.profileToken,
        owner: options.owner,
      })
    );
  }, [haptic]);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismissKey,
      claimKey,
      activateProfile,
      profileScope,
      getProfileScope,
    }),
    [
      toast,
      dismissKey,
      claimKey,
      activateProfile,
      profileScope,
      getProfileScope,
    ]
  );

  const shown = visibleToasts(toasts, snackbar);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {shown.length > 0 && (
        // Bottom-edge LAYER 2 (#1520): the notices sit above the nav dock and the
        // workout dock when one is present (the shared inset resolves to the plain
        // safe-area gutter when neither is) instead of covering them. Below `md`
        // the bar claims BOTH gutters; from `md` up `left-auto` hands the left side
        // back and the corner stack is exactly what it was.
        <div
          className={`fixed ${BOTTOM_EDGE_NOTICE_BOTTOM} ${BOTTOM_EDGE_GUTTER_LEFT} ${BOTTOM_EDGE_GUTTER_RIGHT} ${BOTTOM_EDGE_NOTICE_LAYER} flex flex-col gap-2 md:left-auto`}
        >
          {shown.map((t) => (
            <ToastCard
              key={t.id}
              toast={t}
              dismiss={dismiss}
              reduceMotion={reduceMotion}
            />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({
  toast,
  dismiss,
  reduceMotion,
}: {
  toast: ToastItem;
  dismiss: (id: number, preserveOwner?: boolean) => void;
  reduceMotion: boolean;
}) {
  const success = toast.tone === "success";
  const { duration, exiting } = toast;
  // Stable per-toast dismiss (keyed by id). Building `() => dismiss(id)` inline in
  // the parent map produced a fresh closure on every render, so the auto-dismiss
  // effect below re-ran and restarted every toast's countdown whenever any toast
  // was added or removed. `dismiss` is a stable useCallback, so this is too.
  const onDismiss = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);
  const onAction = useCallback(() => {
    // The card may leave while a slow inverse runs, but its lifecycle reservation
    // remains current until a newer claim or an explicit/manual timeout dismissal.
    dismiss(toast.id, true);
    toast.action?.onClick();
  }, [dismiss, toast]);
  // Auto-dismiss after `duration` ms; a null duration keeps the toast up until
  // the user closes it by hand. `toast.revision` is a dep so an in-place keyed
  // replace (which keeps the id, so onDismiss is stable) restarts the countdown
  // (#1315) instead of letting the pre-replace timer fire on the new message.
  // A card already on its way out has nothing left to count.
  const { revision } = toast;
  useEffect(() => {
    if (duration == null || exiting) return;
    const id = setTimeout(onDismiss, duration);
    return () => clearTimeout(id);
  }, [onDismiss, duration, revision, exiting]);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast"
      data-toast-key={toast.key}
      // ONE grid, two placements. The phone bar is a single row — icon, message,
      // action, dismiss — and the desktop card puts the action on a second row
      // under the message, which is where it has always been. Doing that with grid
      // placement rather than two subtrees keeps exactly ONE action button and ONE
      // dismiss button in the accessibility tree at every width.
      className={motionClass(
        `mx-auto grid w-full max-w-sm grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 rounded-xl border bg-surface px-4 py-2 shadow-lg md:mx-0 md:w-72 md:max-w-none md:grid-cols-[auto_1fr_auto] md:items-start md:p-3.5 ${
          success
            ? "border-emerald-200 dark:border-emerald-800"
            : "border-rose-200 dark:border-rose-800"
        }`,
        overlayMotionClass("notice", exiting ? "exit" : "enter", reduceMotion),
        reduceMotion
      )}
    >
      <span className="col-start-1 row-start-1 leading-none">
        {success ? (
          <IconCircleCheck className="h-5 w-5 text-emerald-500" />
        ) : (
          <IconAlertTriangle className="h-5 w-5 text-amber-500" />
        )}
      </span>
      <p className="col-start-2 row-start-1 min-w-0 text-sm text-slate-700 dark:text-slate-200">
        {toast.message}
      </p>
      {toast.action && (
        <button
          onClick={onAction}
          // The snackbar-action idiom below `md`: a full-height trailing button on
          // the bar, so a 10s undo window is actually hittable while walking
          // (#2642). From `md` up it is the inline link under the message it has
          // always been.
          className="tap-target col-start-3 row-start-1 inline-flex h-11 shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-medium text-brand-700 hover:bg-brand-50 md:col-start-2 md:row-start-2 md:mt-1.5 md:h-auto md:rounded-none md:px-0 md:hover:bg-transparent md:hover:underline dark:text-brand-400 dark:hover:bg-brand-950/40"
        >
          {toast.action.label}
          <IconArrowRight className="h-4 w-4" />
        </button>
      )}
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        // A real 44px box below `md` (#644), not the `tap-target` pseudo-element
        // on its own — that extension is coarse-pointer-only and invisible to a
        // layout measurement, and this is the control a thumb reaches for while
        // the bar is on a 6s clock. The desktop card keeps its 16px glyph.
        className="tap-target col-start-4 row-start-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:text-slate-500 md:col-start-3 md:h-auto md:w-auto md:rounded-none dark:text-slate-600 dark:hover:text-slate-400"
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

export function useClaimToastKey(): ClaimKeyFn {
  const ctx = useContext(ToastContext);
  if (!ctx)
    throw new Error("useClaimToastKey must be used within a ToastProvider");
  return ctx.claimKey;
}

export function useActivateToastProfile(): ActivateProfileFn {
  const ctx = useContext(ToastContext);
  if (!ctx)
    throw new Error(
      "useActivateToastProfile must be used within a ToastProvider"
    );
  return ctx.activateProfile;
}

export function useToastProfileScope(): ProfileToastScope | null {
  const ctx = useContext(ToastContext);
  if (!ctx)
    throw new Error("useToastProfileScope must be used within a ToastProvider");
  return ctx.profileScope;
}

export function useToastProfileScopeGetter(): GetProfileScopeFn {
  const ctx = useContext(ToastContext);
  if (!ctx)
    throw new Error(
      "useToastProfileScopeGetter must be used within a ToastProvider"
    );
  return ctx.getProfileScope;
}
