import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveActivity } from "@/app/(app)/journal/actions";
import { saveOutcomeMessage } from "@/lib/activity-save-outcome";

// The ActivityForm auto-save state machine (#1189), extracted from the parent as a
// self-contained hook (#1207). It owns the whole save lifecycle: a 700ms debounced
// persist that keeps the form open (create-then-update), the created-row id it reuses
// so later saves UPDATE instead of inserting duplicates, the in-flight serialization
// that stops concurrent debounces from double-creating a row, the unmount flush, and
// the close-path flush that closes the "navigate immediately after close" drop race.
//
// It reports its outcome as `status`/`savedAt` (for the header/footer indicators) and
// `dirty` (unsaved-edits gate), and exposes `savableId()` + `createdId` (the live row
// id) and `markDeleted()` (so a delete doesn't get re-created by the trailing flush).
// Pure orchestration over the parent's `buildFormData` — no form field is read here,
// so the parent stays the single owner of form state.

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface ActivityAutosave {
  status: SaveStatus;
  savedAt: number;
  createdId: number | null;
  // The row a save targets: the edited row, else the auto-created one (read
  // synchronously off the ref so a trailing save UPDATEs rather than re-inserts).
  savableId: () => number | null;
  hasRow: boolean;
  dirty: boolean;
  // Durably commit the latest edit before the form closes (bounded, ~0.5s cap).
  flushBeforeClose: () => Promise<void>;
  // Mark the row deleted: freeze the saved signature at the current form so the
  // unmount flush can't re-create it, and drop the created id.
  markDeleted: () => void;
}

export function useActivityAutosave({
  formSig,
  canSave,
  editId,
  isPrefillCreate,
  buildFormData,
  toast,
}: {
  formSig: string;
  canSave: boolean;
  // editData?.id ?? null — the stored row being edited (null in create mode).
  editId: number | null;
  // A "Log again"/"Repeat last" prefill create: starts the saved signature DIFFERENT
  // (an empty sentinel) so the seeded, already-complete activity auto-saves on open.
  isPrefillCreate: boolean;
  buildFormData: (savedId: number | null) => FormData;
  toast: (msg: string) => void;
}): ActivityAutosave {
  const router = useRouter();
  const [status, setStatus] = useState<SaveStatus>("idle");
  // Timestamp of the last successful save; drives the SaveStatus check + fade.
  const [savedAt, setSavedAt] = useState(0);
  // After an auto-save creates a fresh row, remember its id so later saves update
  // it (the ref is read synchronously by saves; the state drives the UI).
  const [createdId, setCreatedId] = useState<number | null>(null);
  const createdIdRef = useRef<number | null>(null);
  const savableId = () => editId ?? createdIdRef.current;
  const hasRow = editId != null || createdId != null;

  // The state we last persisted (or loaded). Starts equal to the initial state so
  // loading existing data — or opening a blank create form — saves nothing. A prefill
  // create is the exception (see isPrefillCreate).
  const savedSigRef = useRef<string>(isPrefillCreate ? "" : formSig);
  // Keep the latest persist available to the unmount flush without re-running it.
  const persistRef = useRef<() => void>(() => {});
  // Serialize saves: only one in flight at a time, so concurrent debounces can't
  // both create a fresh row before the first returns its id (duplicate insert).
  const inFlightRef = useRef(false);
  // Avoid setState after unmount (the unmount flush awaits a server action). Set true
  // on mount too: under StrictMode the mount→cleanup→mount cycle would otherwise leave
  // it stuck false, skipping post-save state (Delete, status).
  const mountedRef = useRef(true);
  // buildFormData closes over live form state; keep the latest for the debounced /
  // unmount persist without re-arming the machine on every keystroke.
  const buildFormDataRef = useRef(buildFormData);
  buildFormDataRef.current = buildFormData;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function persist() {
    if (!canSave) return;
    if (formSig === savedSigRef.current) return; // nothing changed
    if (inFlightRef.current) return; // a save is running; its trailing re-check catches new edits
    inFlightRef.current = true;
    const sigAtSave = formSig;
    let saved = false;
    if (mountedRef.current) setStatus("saving");
    try {
      const res = await saveActivity(buildFormDataRef.current(savableId()));
      // Nothing persisted (invalid title/date or an id the active profile doesn't
      // own — e.g. after a profile switch). Do NOT advance savedSigRef: the form
      // stays dirty so the edit survives, the auto-saver can retry, and closing it
      // still prompts. Surface the failure instead of a false "Saved ✓" (#332).
      if (!res.ok) {
        if (mountedRef.current) setStatus("error");
        else toast(saveOutcomeMessage(res.reason));
        return;
      }
      if (res.id != null && savableId() == null) {
        createdIdRef.current = res.id; // ref first, so a trailing save UPDATEs
        if (mountedRef.current) setCreatedId(res.id);
      }
      savedSigRef.current = sigAtSave;
      saved = true;
      if (mountedRef.current) {
        setStatus("saved");
        setSavedAt(Date.now());
      }
      router.refresh();
    } catch {
      if (mountedRef.current) setStatus("error");
      // Failed after the form closed (the unmount flush): the status icon is
      // gone, so this toast is the only signal the change didn't stick.
      else toast("Couldn’t save your last change — reopen the activity.");
    } finally {
      inFlightRef.current = false;
      // Persist edits that landed while this save was in flight — even after
      // unmount, since the unmount flush skips while a save is running. Only
      // after a success though: chaining after a failure would retry in a loop.
      if (saved) void persistRef.current();
    }
  }
  persistRef.current = persist;

  // `savedAt` is in the deps on purpose: it bumps after every successful save, so
  // this effect RE-CHECKS dirtiness once a save completes. Without it, a rapid edit
  // whose debounced persist fired while the previous save was still `inFlightRef`
  // (so persist() bailed at the in-flight guard) could be dropped entirely — the
  // trailing re-persist can run against a stale render closure, and the effect
  // otherwise only re-arms on a `formSig` change, which doesn't happen again. Keying
  // on savedAt guarantees that as long as the form stays dirty, another debounced
  // save is scheduled with a fresh closure until the latest edit is persisted. (This
  // was the ~1/9-under-load rpe-logging:68 drop: the 8.5 step never reached the
  // server because its persist bailed on the in-flight 8-save and nothing re-armed.)
  useEffect(() => {
    if (formSig === savedSigRef.current) return; // unchanged (incl. first mount)
    if (!canSave) return;
    const h = setTimeout(() => void persistRef.current(), 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSig, canSave, savedAt]);

  // Flush any pending change when the form goes away (e.g. switching cards,
  // dismissing the modal, navigating off the page).
  useEffect(() => {
    return () => void persistRef.current();
  }, []);

  // Durably commit the latest edit BEFORE the form closes. The 700ms debounced
  // auto-save and the unmount-time flush (both above) are fire-and-forget, so a
  // navigation that immediately follows the close — Escape/close then a route
  // change, or a card switch — can abort the in-flight save and silently drop the
  // last change. Awaiting the save on the close path closes that race: a change the
  // user made is persisted before we relinquish the form. (Surfaced by the
  // full-suite e2e census: an RPE half-point nudged just before close+navigate was
  // lost because the flush never landed.)
  async function flushBeforeClose() {
    // Bounded: await an in-flight save to settle, then persist the latest, until
    // the saved signature matches the current form (or we give up after ~0.5s so
    // a wedged save never blocks the close).
    for (let i = 0; i < 20 && canSave && formSig !== savedSigRef.current; i++) {
      if (inFlightRef.current) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      await persistRef.current();
    }
  }

  function markDeleted() {
    // Don't let the unmount flush re-create the row we just deleted.
    savedSigRef.current = formSig;
    createdIdRef.current = null;
  }

  return {
    status,
    savedAt,
    createdId,
    savableId,
    hasRow,
    dirty: formSig !== savedSigRef.current,
    flushBeforeClose,
    markDeleted,
  };
}
