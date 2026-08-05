import { useEffect, useRef, useState } from "react";
import { saveActivity } from "@/app/(app)/training/activity-actions";
import { saveOutcomeMessage } from "@/lib/activity-save-outcome";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { isStaleActionError } from "@/lib/sw-update";

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
  // This tab's build can no longer call the server (deployment skew's Server
  // Action half): a save failed with the stale-action signature and none has
  // succeeded since. Retrying cannot help — only a reload can — so the form
  // renders an explicit banner off this instead of the bare error glyph.
  staleBuild: boolean;
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
  onQueueOffline,
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
  // Offline capture for a NEVER-CREATED session (#1596): called from the CLOSE-path
  // flushes only, when the final save dies on a dead connection and the form has no
  // server row — the one moment the whole session is a pure capture (see the
  // lib/offline/queue.ts scope comment for why a server-rowed edit never queues,
  // and why nothing queues while the form is still open: the open form's own
  // reconnect auto-save would race the replay into a duplicate row). Returns true
  // once the intent is durably queued; the hook then treats the close like a save
  // (signature advanced, no dirty prompt) — the queue owns the data now.
  onQueueOffline?: (formData: FormData) => Promise<boolean>;
}): ActivityAutosave {
  const [status, setStatus] = useState<SaveStatus>("idle");
  // Timestamp of the last successful save; drives the SaveStatus check + fade.
  const [savedAt, setSavedAt] = useState(0);
  // Sticky across failures, cleared by a success: once a save has failed on the
  // stale-action signature, every later one will too until the tab reloads.
  const [staleBuild, setStaleBuild] = useState(false);
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
  const persistRef = useRef<(opts?: { queueOnOffline?: boolean }) => unknown>(
    () => {}
  );
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
  // Same for the offline-capture callback (#1596) — it closes over the parent's
  // queue context + draft handle.
  const onQueueOfflineRef = useRef(onQueueOffline);
  onQueueOfflineRef.current = onQueueOffline;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `queueOnOffline` marks a CLOSE-path persist (flushBeforeClose / the unmount
  // flush): when that final save dies on a dead connection and the session never
  // got a server row, the whole form is captured into the offline queue instead of
  // being stranded in the local draft (#1596). Debounced mid-session persists
  // never pass it — nothing may queue while the form is still open (see
  // onQueueOffline's doc above).
  async function persist(opts?: { queueOnOffline?: boolean }) {
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
        setStaleBuild(false);
      }
    } catch (err) {
      // Close-path save on a dead connection, session never created server-side
      // (#1596): capture the whole form into the offline queue. On success the
      // signature advances — the close proceeds clean, and the queue (not the
      // draft) is the durable owner of the entry.
      if (
        opts?.queueOnOffline &&
        savableId() == null &&
        onQueueOfflineRef.current &&
        shouldQueueOffline(
          typeof navigator === "undefined" ? true : navigator.onLine,
          err
        )
      ) {
        try {
          const queued = await onQueueOfflineRef.current(
            buildFormDataRef.current(null)
          );
          if (queued) {
            savedSigRef.current = sigAtSave;
            saved = true;
            if (mountedRef.current) {
              setStatus("saved");
              setSavedAt(Date.now());
            }
            return;
          }
        } catch {
          /* IndexedDB unavailable — fall through to the honest failure below */
        }
      }
      // Deployment skew's Server Action half: the deploy invalidated this build's
      // action ids, so this failure — and every one after it — is a state, not an
      // event. The form renders the reload banner off the flag; the local draft
      // (#1699) is what makes "kept on this device" true.
      const stale = isStaleActionError(err);
      if (mountedRef.current) {
        if (stale) setStaleBuild(true);
        setStatus("error");
      } else {
        // Failed after the form closed (the unmount flush): the status icon is
        // gone, so this toast is the only signal the change didn't stick. On a
        // stale build, name the remedy that can actually work — reopening the
        // editor in this same tab would fail identically.
        toast(
          stale
            ? "Couldn’t save your last change — the app has updated. Reload the page; your entry is kept on this device."
            : "Couldn’t save your last change — reopen the activity."
        );
      }
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
  // dismissing the modal, navigating off the page). A close path, so an offline
  // failure on a never-created session may capture to the queue (#1596).
  useEffect(() => {
    return () => void persistRef.current({ queueOnOffline: true });
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
      // A close path (#1596): a dead-connection failure on a never-created
      // session captures to the offline queue, which advances the signature and
      // ends this loop like a successful save.
      await persistRef.current({ queueOnOffline: true });
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
    staleBuild,
    createdId,
    savableId,
    hasRow,
    dirty: formSig !== savedSigRef.current,
    flushBeforeClose,
    markDeleted,
  };
}
