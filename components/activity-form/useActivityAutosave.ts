import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { saveActivity } from "@/app/(app)/training/activity-actions";
import { saveOutcomeMessage } from "@/lib/activity-save-outcome";
import { shouldDeferRowlessSave } from "@/lib/live-workout";
// Declared in a leaf module so importing it from a spec cannot drag this file's
// Server Action graph into `playwright --list` — see lib/live-session-race-event.ts.
import { LIVE_CREATE_RACE_EVENT } from "@/lib/live-session-race-event";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { isStaleActionError } from "@/lib/sw-update";
import { reportStaleBuild } from "@/components/update-reload-channel";
import { isRetriableSaveError, saveFailureEvent } from "@/lib/sw-update";
import { useLatestRef } from "@/components/useLatestRef";

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

// Self-retry cadence for network-shaped save failures (#2866): quick enough to
// land inside a container swap (5s/15s), then HELD at the final 45s step for as
// long as the outage lasts — rate-bounded (one request per 45s can never storm)
// rather than count-bounded, because an outage that outlives a count leaves the
// save waiting on a keystroke, the very defect this fixes. The stale-action
// path is exempt by construction — it is never retriable, only reloadable.
export const SAVE_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000] as const;

export interface ActivityAutosave {
  status: SaveStatus;
  savedAt: number;
  // This tab's build can no longer call the server (deployment skew's Server
  // Action half): a save failed with the stale-action signature and none has
  // succeeded since. Retrying cannot help — only a reload can — so the form
  // renders an explicit banner off this instead of the bare error glyph.
  staleBuild: boolean;
  // A retriable-failure episode is live (#2866): the bounded backoff is
  // re-attempting network-shaped failures on its own, and the form should say
  // "Not saving right now — your entries are kept on this device" instead of a
  // bare triangle. The local draft (#1699) is what makes that sentence true.
  retryingSave: boolean;
  createdId: number | null;
  // The row a save targets: the edited row, else the auto-created one (read
  // synchronously off the ref so a trailing save UPDATEs rather than re-inserts).
  savableId: () => number | null;
  hasRow: boolean;
  dirty: boolean;
  // Durably commit the latest edit before the form closes. Bounded in ITERATIONS
  // (20), not in time — see the loop for what that is and is not worth.
  flushBeforeClose: () => Promise<void>;
  // Mark the row deleted: freeze the saved signature at the current form so the
  // unmount flush can't re-create it, and drop the created id.
  markDeleted: () => void;
}

export function useActivityAutosave({
  formSig,
  canSave,
  editId,
  adoptRowId = null,
  adoptPending = false,
  isPrefillCreate,
  buildFormData,
  toast,
  onQueueOffline,
  onRowOwned,
}: {
  formSig: string;
  canSave: boolean;
  // editData?.id ?? null — the stored row being edited (null in create mode).
  editId: number | null;
  // CREATE-AT-START adoption (#2870 step 3): the row the provider created the
  // moment the live session started. Handed in as a prop so the mounted form
  // takes ownership WITHOUT a re-key (a remount would drop in-flight state) —
  // it lands in the same created-row channel a create response uses, so every
  // save from here on UPDATEs. Ignored once any row is owned.
  adoptRowId?: number | null;
  // THE OTHER HALF OF THE ADOPTION CHANNEL (#3441): the create-at-start POST is
  // STILL IN FLIGHT, so the row this form is going to own exists (or is about to)
  // and has simply not been named yet. While that is true a rowless mid-session
  // save must DEFER rather than mint a row of its own — see the gate in `persist`,
  // which is where the whole defect lived.
  adoptPending?: boolean;
  // A "Log again"/"Repeat last" prefill create: starts the saved signature DIFFERENT
  // (an empty sentinel) so the seeded, already-complete activity auto-saves on open.
  isPrefillCreate: boolean;
  buildFormData: (savedId: number | null) => FormData;
  // Both posts from here are headless — the form has already unmounted — so they
  // pass `silent` (#3699): a cue for something the person is no longer looking at is
  // a phone buzzing on a table.
  toast: (msg: string, opts?: { silent?: boolean }) => void;
  // Offline capture for a NEVER-CREATED session (#1596): called from the CLOSE-path
  // flushes only, when the final save dies on a dead connection and the form has no
  // server row — the one moment the whole session is a pure capture (see the
  // lib/offline/queue.ts scope comment for why a server-rowed edit never queues,
  // and why nothing queues while the form is still open: the open form's own
  // reconnect auto-save would race the replay into a duplicate row). Returns true
  // once the intent is durably queued; the hook then treats the close like a save
  // (signature advanced, no dirty prompt) — the queue owns the data now.
  onQueueOffline?: (formData: FormData) => Promise<boolean>;
  // Fired ONCE, when a rowless form first OWNS a row — by adopting the
  // provider's create-at-start id, or by its own first create landing (#2870
  // step 3). The provider keys the one-URL navigation off this, so the
  // session's page appears whenever the row does, however it came to be.
  onRowOwned?: (id: number) => void;
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
  const savableId = useCallback(() => editId ?? createdIdRef.current, [editId]);
  const hasRow = editId != null || createdId != null;

  const onRowOwnedRef = useRef(onRowOwned);
  useEffect(() => {
    onRowOwnedRef.current = onRowOwned;
  });

  // Adopt the provider-created row (#2870 step 3) — ref first, so a save
  // already in flight when the prop lands still UPDATEs. Only while rowless:
  // an edit owns its row, and a create that already minted one keeps it (the
  // provider discards a create that arrived too late to be adopted).
  useEffect(() => {
    if (adoptRowId == null || editId != null) return;
    if (createdIdRef.current != null) return;
    createdIdRef.current = adoptRowId;
    setCreatedId(adoptRowId);
    onRowOwnedRef.current?.(adoptRowId);
  }, [adoptRowId, editId]);

  // The state we last persisted (or loaded). Starts equal to the initial state so
  // loading existing data — or opening a blank create form — saves nothing. A prefill
  // create is the exception (see isPrefillCreate).
  const initialSavedSig = isPrefillCreate ? "" : formSig;
  const savedSigRef = useRef<string>(initialSavedSig);
  const [savedSig, setSavedSig] = useState(initialSavedSig);
  // Keep the latest persist implementation behind one stable callback for the
  // debounce, trailing-save, and unmount paths.
  const persistImplRef = useRef<
    (opts?: { queueOnOffline?: boolean }) => unknown
  >(() => {});
  const persistLatest = useCallback(
    (opts?: { queueOnOffline?: boolean }) => persistImplRef.current(opts),
    []
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
  const buildFormDataRef = useLatestRef(buildFormData);
  // Read synchronously by `persist` (#3441) so the gate answers about the moment the
  // save is DISPATCHED, not about the render that armed the debounce.
  const adoptPendingRef = useLatestRef(adoptPending);
  // The announcement above is once per mount: the debounce can come due several
  // times inside one slow round trip, and one line per session is the signal.
  const raceAnnouncedRef = useRef(false);
  // Same for the offline-capture callback (#1596) — it closes over the parent's
  // queue context + draft handle.
  const onQueueOfflineRef = useLatestRef(onQueueOffline);
  // THIS CLOSE'S CAPTURE WAS REFUSED (#3170). `onQueueOffline` answering false means
  // the device kept nothing and the surface has ALREADY told the person so, in the
  // shared refused-capture sentence. Every further attempt from this same close is
  // then a write that would contradict a sentence on screen: the close path fires
  // ~20 attempts in ~80ms and the unmount flush fires one more, and if the link
  // comes back inside that burst one of them CREATES the session — a started,
  // unended row that turns up on the profile seconds after the person was told
  // nothing was saved (measured on this spec's own reconnect, and the row #3163
  // found). There is nothing to fall back to either: the refusal's own cause is
  // that IndexedDB is unavailable, and the #1699 local draft lives in that same
  // IndexedDB, so no draft was written and no dock can offer one.
  //
  // ONE WAY, AND NEVER RESET, because a refusal only ever happens on a close that
  // is proceeding: `requestClose` runs its confirm BEFORE `flushBeforeClose`, so
  // the flush is only reached once the close is settled, and the unmount that
  // follows takes this ref with it. A minimize does not flush at all.
  const closeCaptureRefusedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A retriable-failure EPISODE is live (#2866): saves are dying on the shapes a
  // mid-deploy swap window produces (a 502 page → Next's non-RSC-response
  // throw, or a connection TypeError), the backoff below is re-attempting on
  // its own, and the form owes the user the true sentence — "Not saving right
  // now, your entries are kept on this device" — not a bare triangle. Cleared
  // by the first success, by a stale verdict (the reload banner takes over),
  // by an ordinary rejection (whose honest error rendering stands), or by the
  // form catching up to the saved state (nothing left to save). While the flag
  // is up, a retry is ALWAYS armed — the banner never promises what no timer
  // will do.
  const [retryingSave, setRetryingSave] = useState(false);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const episodeLoggedRef = useRef(false);
  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current != null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);
  const endRetryEpisode = useCallback(() => {
    clearRetryTimer();
    retryAttemptRef.current = 0;
    episodeLoggedRef.current = false;
    if (mountedRef.current) setRetryingSave(false);
  }, [clearRetryTimer]);

  // A scheduled retry must not outlive the form.
  useEffect(() => clearRetryTimer, [clearRetryTimer]);

  // `queueOnOffline` marks a CLOSE-path persist (flushBeforeClose / the unmount
  // flush): when that final save dies on a dead connection and the session never
  // got a server row, the whole form is captured into the offline queue instead of
  // being stranded in the local draft (#1596). Debounced mid-session persists
  // never pass it — nothing may queue while the form is still open (see
  // onQueueOffline's doc above).
  const persist = useCallback(
    async (opts?: { queueOnOffline?: boolean }) => {
      // The two settled-state bails END a live retry episode: with autosave off
      // or the form matching the saved signature there is nothing a retry could
      // do, and the banner must not keep claiming one is coming (e.g. the user
      // reverted the very edit whose save died). The in-flight bail does NOT —
      // that save's own completion settles the episode.
      if (!canSave) {
        endRetryEpisode();
        return;
      }
      if (formSig === savedSigRef.current) {
        endRetryEpisode();
        return; // nothing changed
      }
      if (inFlightRef.current) return; // a save is running; its trailing re-check catches new edits
      // The refusal is already on screen (#3170). This bail is the half that covers
      // the UNMOUNT flush, which is a separate call `flushBeforeClose`'s own break
      // below cannot reach. Scoped to `queueOnOffline` so it can only ever silence a
      // CLOSE-path attempt: nothing about the debounced mid-session save changes.
      if (opts?.queueOnOffline && closeCaptureRefusedRef.current) return;
      // ONE LIVE SESSION IS ONE ROW (#3441). The create-at-start POST is in flight,
      // and this form has no row yet — so a save dispatched now would build its
      // FormData with a null id and INSERT A SECOND ROW for the same session. That
      // is not hypothetical and it is not a near-miss: it is the measured defect.
      // Hold the start POST for 2s and pick an exercise inside the window and the
      // profile ends with TWO live drafts — the provider adopts the created row and
      // navigates the tab to it, while the row this save minted keeps the user's
      // sets and is pointed at by nothing. Every on-screen assertion is green about
      // whichever one the editor happens to hold.
      //
      // WHY DEFERRING IS SAFE, and why it is not a promise this can fail to keep:
      // the create either lands (`adoptRowId` arrives, and the effect below re-arms
      // the debounce against the adopted id, so this same edit is saved ~700ms
      // later as an UPDATE) or it fails (the provider clears the flag, and the
      // rowless-fallback create that gym dead spots depend on happens exactly as it
      // did before). Nothing is dropped in either leg — the edit stays in the form,
      // which is where it already was.
      //
      // THE DECISION ITSELF IS `shouldDeferRowlessSave` (lib/live-workout.ts), not
      // an inline conjunction, because two of its three terms are EXEMPTIONS — and
      // an exemption is wrong in the direction nothing observes. `queueOnOffline`
      // is the CLOSE-path discriminator the #1596 comment above already defines;
      // why a close is exempt is argued at the predicate, and all four corners are
      // pinned there in both directions.
      const createPending = adoptPendingRef.current;
      const hasOwnRow = savableId() != null;
      // ANNOUNCED OUTSIDE THE DECISION, deliberately: this says the RACE HAPPENED,
      // which is true whatever the decision below then does about it. A spec can
      // therefore prove it drove the race without its fuse depending on the fix
      // being present, so a mutated tree still fails at the row COUNT rather than at
      // the fuse. See lib/live-session-race-event.ts for what reads it and why the
      // string lives in a leaf module.
      //
      // TO THE REVIEWER WHO WANTS TO DELETE THIS as instrumentation that pins
      // nothing: it is the only observable this race has. With the fix in place the
      // window produces no extra request, no extra row and no changed markup, so a
      // guard without it goes green either because the fix works or because the box
      // was slow enough that the create landed first — different facts. Measured:
      // +1200ms of client latency turned the un-fused guard green 4/4 with the
      // defect in the tree. It is also the line a real sighting would want.
      if (createPending && !hasOwnRow && !raceAnnouncedRef.current) {
        raceAnnouncedRef.current = true;
        console.warn(LIVE_CREATE_RACE_EVENT);
      }
      if (
        shouldDeferRowlessSave({
          createPending,
          hasRow: hasOwnRow,
          closePath: opts?.queueOnOffline === true,
        })
      ) {
        return;
      }
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
          // A server that ANSWERS with a rejection is deterministic, not an
          // outage: whatever retry episode was running is over, and the honest
          // error rendering stands instead of the "retrying" line.
          endRetryEpisode();
          if (mountedRef.current) setStatus("error");
          else toast(saveOutcomeMessage(res.reason), { silent: true });
          return;
        }
        if (res.id != null && savableId() == null) {
          createdIdRef.current = res.id; // ref first, so a trailing save UPDATEs
          if (mountedRef.current) setCreatedId(res.id);
          // First ownership (the rowless-fallback path minted its own row):
          // the one-URL navigation keys off this (#2870 step 3).
          if (mountedRef.current) onRowOwnedRef.current?.(res.id);
        }
        savedSigRef.current = sigAtSave;
        if (mountedRef.current) setSavedSig(sigAtSave);
        saved = true;
        endRetryEpisode();
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
              if (mountedRef.current) setSavedSig(sigAtSave);
              saved = true;
              if (mountedRef.current) {
                setStatus("saved");
                setSavedAt(Date.now());
              }
              return;
            }
            // Refused (#3170): no more attempts from this close. A THROW is
            // deliberately not latched — it means no sentence was rendered, so
            // there is no claim on screen for a later attempt to contradict.
            closeCaptureRefusedRef.current = true;
          } catch {
            /* IndexedDB unavailable — fall through to the honest failure below */
          }
        }
        // Deployment skew's Server Action half: the deploy invalidated this build's
        // action ids, so this failure — and every one after it — is a state, not an
        // event. The form renders the reload banner off the flag; the local draft
        // (#1699) is what makes "kept on this device" true.
        const stale = isStaleActionError(err);
        // Trigger A of the self-reloading deploy (#2471). Reported to the root
        // registrar, which is mounted above every provider this editor lives under,
        // so the tab can converge on the new build without the user tapping
        // anything — and without waiting for the `/api/version` detector, which this
        // signal is deliberately independent of.
        if (stale) reportStaleBuild();
        // A network-shaped failure is retriable IN PLACE (#2866) — the mid-deploy
        // swap window answers a 502 page (Next's non-RSC-response throw) or a
        // connection TypeError, and before this, recovery waited on the next
        // KEYSTROKE: each in-window retry failed the same unclassified way and
        // the sticky error rendered a bare triangle through the rest of the
        // workout. Backed off 5s → 15s → 45s, then HELD at 45s for as long as
        // the outage lasts: an outage that outlives the ladder must not strand
        // the banner over a save nothing will re-attempt (recovery would be
        // back to keystroke-only — the very defect this fixes). The first
        // attempt the new server answers either succeeds or returns the real
        // stale signature, and the paths above take over. One structured event
        // per episode names the leg for the next report.
        const retriable = !stale && isRetriableSaveError(err);
        if (retriable) {
          if (!episodeLoggedRef.current) {
            episodeLoggedRef.current = true;
            console.warn("activity-autosave-retriable", saveFailureEvent(err));
          }
          if (mountedRef.current) {
            setRetryingSave(true);
            const attempt = retryAttemptRef.current;
            retryAttemptRef.current = attempt + 1;
            clearRetryTimer();
            retryTimerRef.current = setTimeout(
              () => {
                retryTimerRef.current = null;
                void persistLatest();
              },
              SAVE_RETRY_BACKOFF_MS[
                Math.min(attempt, SAVE_RETRY_BACKOFF_MS.length - 1)
              ]
            );
          }
        } else {
          // An ordinary rejection or the stale signature: whatever retry episode
          // was running is over — those states own their own rendering.
          endRetryEpisode();
        }
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
              : "Couldn’t save your last change — reopen the activity.",
            { silent: true }
          );
        }
      } finally {
        inFlightRef.current = false;
        // Persist edits that landed while this save was in flight — even after
        // unmount, since the unmount flush skips while a save is running. Only
        // after a success though: chaining after a failure would retry in a loop.
        if (saved) void persistLatest();
      }
    },
    [
      adoptPendingRef,
      buildFormDataRef,
      canSave,
      clearRetryTimer,
      endRetryEpisode,
      formSig,
      onQueueOfflineRef,
      persistLatest,
      savableId,
      toast,
    ]
  );
  useLayoutEffect(() => {
    persistImplRef.current = persist;
  }, [persist]);

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
  //
  // `adoptPending` is in the deps for the SAME reason (#3441): a persist that bailed
  // at the create-at-start gate below left no timer behind, so the moment the flag
  // clears this must re-arm or the deferred edit waits for the next keystroke. It
  // re-arms in the commit that also delivers `adoptRowId`, and the adoption effect
  // is declared ABOVE this one, so by the time the timer fires the row is owned and
  // the save is an UPDATE.
  useEffect(() => {
    if (formSig === savedSigRef.current) return; // unchanged (incl. first mount)
    if (!canSave) return;
    const h = setTimeout(() => void persistLatest(), 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSig, canSave, savedAt, adoptPending, persistLatest]);

  // Flush any pending change when the form goes away (e.g. switching cards,
  // dismissing the modal, navigating off the page). A close path, so an offline
  // failure on a never-created session may capture to the queue (#1596).
  useEffect(() => {
    return () => void persistLatest({ queueOnOffline: true });
  }, [persistLatest]);

  // Durably commit the latest edit BEFORE the form closes. The 700ms debounced
  // auto-save and the unmount-time flush (both above) are fire-and-forget, so a
  // navigation that immediately follows the close — Escape/close then a route
  // change, or a card switch — can abort the in-flight save and silently drop the
  // last change. Awaiting the save on the close path closes that race: a change the
  // user made is persisted before we relinquish the form. (Surfaced by the
  // full-suite e2e census: an RPE half-point nudged just before close+navigate was
  // lost because the flush never landed.)
  async function flushBeforeClose() {
    // Await an in-flight save to settle, then persist the latest, until the saved
    // signature matches the current form — or until 20 iterations have gone by.
    //
    // THE BOUND IS 20 ITERATIONS, NOT A CLOCK, and this comment used to claim a
    // "~0.5s cap" that nothing enforces. Only the in-flight branch sleeps (25ms);
    // the persist branch AWAITS A ROUND TRIP of whatever length the server takes,
    // so the real elapsed time is 20 × that. Offline it is fast — ~80ms measured
    // for the whole loop, since every attempt fails at once — and against a slow
    // or wedged server it is unbounded, which is the opposite of what the old
    // number promised. Anyone reasoning about how long a close can block should
    // read it as "20 attempts", and anyone adding a time cap should add one.
    for (let i = 0; i < 20 && canSave && formSig !== savedSigRef.current; i++) {
      // The capture was refused (#3170): the signature will never advance, so the
      // remaining iterations are attempts that can only contradict the sentence the
      // person is already reading.
      if (closeCaptureRefusedRef.current) break;
      if (inFlightRef.current) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      // A close path (#1596): a dead-connection failure on a never-created
      // session captures to the offline queue, which advances the signature and
      // ends this loop like a successful save.
      await persistLatest({ queueOnOffline: true });
    }
  }

  function markDeleted() {
    // Don't let the unmount flush re-create the row we just deleted.
    savedSigRef.current = formSig;
    setSavedSig(formSig);
    createdIdRef.current = null;
  }

  return {
    status,
    savedAt,
    staleBuild,
    retryingSave,
    createdId,
    savableId,
    hasRow,
    dirty: formSig !== savedSig,
    flushBeforeClose,
    markDeleted,
  };
}
