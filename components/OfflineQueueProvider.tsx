"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useToast } from "@/components/Toast";
import { useChromeRefresh } from "@/components/DirtyFormRegistry";
import {
  BOTTOM_EDGE_ALERT_LAYER,
  BOTTOM_EDGE_GUTTER_LEFT,
  BOTTOM_EDGE_GUTTER_RIGHT,
  BOTTOM_EDGE_NOTICE_BOTTOM,
  BOTTOM_EDGE_NOTICE_LAYER,
} from "@/components/overlay/tokens";
import {
  buildIntent,
  chunkIntents,
  planFlushDisposition,
  syncedAnnouncement,
  describeIntent,
  isAuthFailure,
  MAX_INTENTS,
  type FlowKind,
  type IntentPayload,
  type ReplayResult,
  type RejectedEntry,
} from "@/lib/offline/queue";
import type { StatedTimeRefusal } from "@/lib/stated-time";
import {
  captureWriteToken,
  openSessionForDocument,
} from "@/lib/offline/write-gate";
import {
  enqueueIntent,
  allIntents,
  removeIntents,
  putIntents,
  saveRejected,
  allRejected,
  removeRejected,
  countIntents,
} from "@/lib/offline/queue-db";

// Client provider that owns the offline write queue (issue #28): it enqueues the
// three quick-log intents while offline, replays them to /api/offline-replay on
// reconnect, and renders a pending-writes badge. Mounted once inside the
// authenticated (app) layout so it's only active for a logged-in session (the
// replay route needs one) and can raise toasts via the root ToastProvider.
//
// REPLAY TRIGGERS (belt-and-braces — the server's replayed_keys ledger makes them
// all idempotent so overlapping fires can't double-log):
//   • on mount (on-load flush — catches a reload while a queue is pending),
//   • the window "online" event,
//   • tab becoming visible again,
//   • a message from the service worker's Background Sync handler (public/sw.js).
// Background Sync (registered in enqueue) is a PROGRESSIVE ENHANCEMENT: it's
// Chromium/Android-only (no Firefox/Safari support as of 2026), so the online +
// on-load flush are the authoritative path and work everywhere.

const SYNC_TAG = "allos-offline-replay";

interface OfflineQueueApi {
  // Number of writes currently queued (drives the badge + lets forms hint state).
  pending: number;
  // Persist an intent for later replay. `date` is the captured local date the write
  // lands on; `payload` is the flow's raw fields.
  //
  // ANSWERS WHETHER THE DEVICE ACTUALLY KEPT IT. It can say no — the write gate is closed
  // because this device was logged out (#2908), or there is no IndexedDB at all (private
  // mode, an embedded webview) — and a caller that ignores the answer tells someone
  // "saved offline, will sync when you reconnect" about a write that was never recorded.
  enqueue: (
    flow: FlowKind,
    date: string,
    payload: IntentPayload
  ) => Promise<boolean>;
  // Attempt to replay the whole queue now (safe to call redundantly).
  flush: () => Promise<void>;
}

const OfflineQueueContext = createContext<OfflineQueueApi | null>(null);

export function useOfflineQueue(): OfflineQueueApi {
  const ctx = useContext(OfflineQueueContext);
  if (!ctx) {
    throw new Error(
      "useOfflineQueue must be used within an OfflineQueueProvider"
    );
  }
  return ctx;
}

// Best-effort Background Sync registration — silently absent where unsupported.
async function registerBackgroundSync(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const withSync = reg as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    await withSync.sync?.register(SYNC_TAG);
  } catch {
    /* unsupported / denied — the online + on-load flush covers replay */
  }
}

export default function OfflineQueueProvider({
  children,
  activeProfileId,
  deviceSessionKey,
}: {
  children: React.ReactNode;
  // The session's active profile at render time (issue #599). Every intent enqueued
  // here is STAMPED with it, so a late replay lands on the profile the write was
  // captured under — not whatever profile is active at flush time. The layout passes
  // the current session's profile.id; a profile switch re-renders with the new value.
  activeProfileId: number;
  // WHICH SESSION this document belongs to (#2908) — opaque, and it grants nothing (see
  // lib/auth.ts). It is what re-opens the device write gate, and it has to be an identity
  // rather than the mere fact of mounting: a tab open at logout is still mounted, so
  // "mounted" re-opened the gate for the session that had just closed it.
  deviceSessionKey: string;
}) {
  const [pending, setPending] = useState(0);
  // Parked rejected/undeliverable entries the user can review + re-enter (issue
  // #475): a replay that failed server validation, or a transient error that
  // exhausted its retries, is preserved here instead of silently discarded.
  const [rejected, setRejected] = useState<RejectedEntry[]>([]);
  const flushing = useRef(false);
  // One delayed retry per failure streak (see the fetch catch below) — reset by
  // any flush that reaches the server, so a dead server can't turn the retry
  // into a permanent 1.5s poll loop.
  const retriedAfterFailure = useRef(false);
  const toast = useToast();
  // CHROME-INITIATED (#1878): this repaint answers a background sync landing —
  // reconnect, a service-worker Background Sync message — not anything the user
  // just did, so it defers while a record form holds unsaved input and runs when
  // that form releases. Never dropped, only delayed.
  const chromeRefresh = useChromeRefresh();

  const refreshCount = useCallback(async () => {
    setPending(await countIntents());
  }, []);

  const refreshRejected = useCallback(async () => {
    setRejected(await allRejected());
  }, []);

  // Dismiss a reviewed rejected entry (the user has re-entered it, or is letting it
  // go) — removes it from the dead-letter store and the panel.
  const dismissRejected = useCallback(
    async (keys: string[]) => {
      await removeRejected(keys);
      await refreshRejected();
    },
    [refreshRejected]
  );

  // Announce a completed sync exactly once even when several replay actors
  // report it — the page flush AND the service worker's Background Sync both
  // replay the queue (idempotent server-side), so the same reconnect can settle
  // via either or both. A short suppression window collapses their reports.
  const lastSyncToastAt = useRef(0);
  const announceSynced = useCallback(
    (n: number, timeNotices: readonly StatedTimeRefusal[] = []) => {
      if (n <= 0) return;
      const now = Date.now();
      if (now - lastSyncToastAt.current < 3000) return;
      lastSyncToastAt.current = now;
      // The sync confirmation, amended when a replay kept a row but refused the time
      // it was told (#2296). Same toast, same default tone, same auto-dismiss: the
      // entries DID land, so this must not read like the dead-letter alert below,
      // which says "these weren't saved" and would be false here.
      //
      // The service-worker call site passes no notices, and that is exact rather than
      // lossy: sw.js DELEGATES to an open tab (posting synced: 0, which returns above)
      // and only replays itself when NO tab is open — where there is no client to post
      // a notice to and no one to read it. A missing minute is cosmetic, the serving is
      // on the right day, and the row stays correctable from its own ⋯ sheet, so
      // "nobody was there" is an acceptable place for this to go unsaid. Claiming the
      // time WAS recorded would not be, and nothing does.
      toast(syncedAnnouncement(n, timeNotices));
      // Survives the #1473 sweep: the queue replays through the /api/offline-replay
      // route handler (and the service worker), never a Server Action, so nothing
      // else brings the newly-landed rows into the current view.
      chromeRefresh();
    },
    [toast, chromeRefresh]
  );

  const flush = useCallback(async () => {
    // A single in-flight flush at a time; the server ledger makes any missed
    // overlap idempotent anyway.
    if (flushing.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    flushing.current = true;
    try {
      // The generation this flush started at. Everything below writes back into the
      // queue AFTER a network round trip, and logout can land inside it: a retry
      // re-written afterwards is one login's PHI back on a logged-out device
      // (`attempts: 0 -> 1` in the store is what proves it a re-write rather than a wipe
      // that missed). The gate refuses it — see lib/offline/write-gate.ts.
      const token = await captureWriteToken();
      const intents = await allIntents();
      if (intents.length === 0) {
        // The queue may have been drained by ANOTHER actor since the badge last
        // rendered — the service worker's Background Sync handler replays the
        // queue itself and then messages this tab. Re-read the count before
        // bailing, or the badge sticks at "N queued offline" forever.
        await refreshCount();
        return;
      }
      // Chunk the queue into ≤MAX_INTENTS POSTs (issue #604): a long offline stretch
      // can accumulate 200+ intents, and one over-size batch dead-ends on a permanent
      // 413 that the old "send everything" path silently swallowed. The per-intent
      // replayed_keys ledger makes each chunk independently idempotent, so we apply
      // each chunk's disposition as it settles and iterate until the queue drains or a
      // chunk fails.
      const chunks = chunkIntents(intents, MAX_INTENTS);
      let totalSynced = 0;
      let totalRejected = 0;
      const timeNotices: StatedTimeRefusal[] = [];
      let batchTooLarge = false;
      for (const chunk of chunks) {
        let res: Response;
        try {
          res = await fetch("/api/offline-replay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ intents: chunk }),
          });
        } catch {
          // Still offline / a blip mid-flush — keep everything queued. When the
          // browser SAYS it's online, this was likely the reconnect race (the
          // "online" event can fire while the network stack is still coming up and
          // the flush's own fetch then dies), and no other trigger may follow for
          // a long time — so schedule ONE short retry (per failure streak) rather
          // than stranding the queue until the next visibility change.
          if (
            typeof navigator !== "undefined" &&
            navigator.onLine !== false &&
            !retriedAfterFailure.current
          ) {
            retriedAfterFailure.current = true;
            setTimeout(() => void flush(), 1500);
          }
          break;
        }
        retriedAfterFailure.current = false;
        if (isAuthFailure(res.status)) {
          // Session lapsed (maybe while offline). Never drop the queue — prompt login.
          toast(
            "You've been signed out. Log back in to sync your offline entries.",
            { tone: "error", duration: null }
          );
          break;
        }
        if (res.status === 413) {
          // Belt-and-suspenders (issue #604): chunking should keep every POST under
          // the cap, so a 413 means an unexpected over-size chunk. Surface it
          // persistently instead of silently returning, and stop — retrying the same
          // over-size chunk would only 413 again.
          batchTooLarge = true;
          break;
        }
        if (!res.ok) break;
        const data = (await res.json()) as { results?: ReplayResult[] };
        const results = data.results ?? [];
        // Split the honest per-intent answers into the four dispositions (issue #475):
        // synced (done/duplicate) → delete; server-rejected → park in the dead-letter
        // store, NEVER silently discard; transient error → re-persist with a bumped
        // attempt count, or park once it exhausts the retry cap. `synced` counts
        // done+duplicate — "duplicate" means a racing actor (the service worker's
        // Background Sync) applied it first, which is still a safe sync worth
        // confirming (only counting "done" made the toast vanish on that race).
        const plan = planFlushDisposition(chunk, results);
        await removeIntents(plan.deleteKeys);
        await putIntents(plan.retry, token);
        await saveRejected(plan.rejected, token);
        totalSynced += plan.syncedCount;
        totalRejected += plan.rejected.length;
        timeNotices.push(...plan.timeNotices);
      }
      await refreshCount();
      await refreshRejected();
      announceSynced(totalSynced, timeNotices);
      if (totalRejected > 0) {
        // A dropped record is data loss — surface it persistently (never
        // auto-dismiss), and the review panel below lets the user re-enter it.
        toast(
          `${totalRejected} offline ${totalRejected === 1 ? "entry" : "entries"} couldn't be applied. Review below to re-enter.`,
          { tone: "error", duration: null }
        );
      }
      if (batchTooLarge) {
        toast(
          "Some offline entries couldn't be synced (batch too large). They're still queued — reload to retry.",
          { tone: "error", duration: null }
        );
      }
    } finally {
      flushing.current = false;
    }
  }, [toast, refreshCount, refreshRejected, announceSynced]);

  const enqueue = useCallback(
    async (flow: FlowKind, date: string, payload: IntentPayload) => {
      // Stamp the write with the profile it's captured under (issue #599) so replay
      // attributes it correctly no matter which profile is active on reconnect.
      const kept = await enqueueIntent(
        buildIntent(flow, date, payload, activeProfileId)
      );
      if (!kept) return false;
      await refreshCount();
      void registerBackgroundSync();
      return true;
    },
    [refreshCount, activeProfileId]
  );

  // A NEW SESSION re-opens the device write gate (#2908). Logout closes every lane
  // persistently — it has to, or a second tab writes everything back — so something must
  // say the close is over, and this provider is it: mounted once in the (app) layout,
  // which only renders for a logged-in session, and the owner of the largest
  // device-local store.
  //
  // A NEW SESSION, NOT A NEW MOUNT, and the difference is the whole finding. This effect
  // used to call `updateGate(openSession)` unconditionally, which reads as "a document
  // exists, therefore someone is logged in". Every tab open at the moment of logout is
  // also a document that exists — the session outlives the logout POST, so those tabs are
  // mounted, authenticated, and each about to run this effect. CI caught it against the
  // second-tab test itself: tab B re-opened the gate and wrote all five snapshots into
  // the store tab A had just cleared. Passing the session's own name lets the gate refuse
  // the session that closed it and admit only a genuinely new one.
  //
  // `[]` still matters for a second, separate reason: the deps of the sync effect below
  // are four useCallbacks, so riding it re-ran this at arbitrary moments, including inside
  // the logout window.
  //
  // It deliberately does not touch the offline-reads OFF SWITCH, which is a separate
  // promise with its own toggle.
  useEffect(() => {
    void openSessionForDocument(deviceSessionKey);
  }, [deviceSessionKey]);

  useEffect(() => {
    // Start the initial IndexedDB reads and replay from a browser task. Their state
    // updates then originate in that external callback, just like every later
    // online/visibility/service-worker trigger below.
    const initialSync = window.setTimeout(() => {
      void refreshCount();
      void refreshRejected();
      void flush(); // on-load flush for a queue left pending across a reload
    }, 0);

    const onOnline = () => void flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    const onSwMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === "allos-flush-queue") {
        // The worker replayed the queue itself; it reports how many entries it
        // settled so the user still gets the confirmation when the tab's own
        // flush finds nothing left to send (announceSynced dedups the race
        // where both actors replayed the same reconnect).
        announceSynced(Number(e.data.synced) || 0);
        void flush();
      }
    };

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const sw =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? navigator.serviceWorker
        : null;
    sw?.addEventListener("message", onSwMessage);

    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      sw?.removeEventListener("message", onSwMessage);
    };
  }, [flush, refreshCount, refreshRejected, announceSynced]);

  return (
    <OfflineQueueContext.Provider value={{ pending, enqueue, flush }}>
      {children}
      {rejected.length > 0 && (
        <div
          data-testid="offline-rejected-review"
          role="alert"
          aria-live="assertive"
          // Bottom-edge LAYER 2 (#1520): above the toast stack (a write that
          // didn't land out-ranks a confirmation) and above the workout dock.
          className={`fixed ${BOTTOM_EDGE_NOTICE_BOTTOM} ${BOTTOM_EDGE_GUTTER_RIGHT} ${BOTTOM_EDGE_ALERT_LAYER} w-[min(22rem,calc(100vw-2rem))] space-y-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 shadow-lg dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">
              {rejected.length} offline{" "}
              {rejected.length === 1 ? "entry" : "entries"} couldn’t be applied
            </p>
            <button
              type="button"
              className="shrink-0 text-xs font-medium underline underline-offset-2"
              onClick={() =>
                void dismissRejected(rejected.map((r) => r.intent.key))
              }
            >
              Dismiss all
            </button>
          </div>
          <p className="text-xs text-rose-700 dark:text-rose-300">
            These weren&rsquo;t saved. Re-enter them, then dismiss.
          </p>
          <ul className="space-y-1.5">
            {rejected.map((r) => (
              <li
                key={r.intent.key}
                className="flex items-start justify-between gap-2 rounded-lg bg-surface px-2 py-1.5"
              >
                <span>
                  <span className="font-medium">
                    {describeIntent(r.intent)}
                  </span>
                  <span className="block text-xs text-rose-700 dark:text-rose-300">
                    {r.reason}
                  </span>
                </span>
                <button
                  type="button"
                  className="shrink-0 text-xs font-medium underline underline-offset-2"
                  onClick={() => void dismissRejected([r.intent.key])}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pending > 0 && (
        <div
          data-testid="offline-queue-badge"
          role="status"
          aria-live="polite"
          // Bottom-edge LAYER 1 (#1520), left gutter — same layer as the toast
          // stack, opposite corner, and clear of the workout dock.
          className={`fixed ${BOTTOM_EDGE_NOTICE_BOTTOM} ${BOTTOM_EDGE_GUTTER_LEFT} ${BOTTOM_EDGE_NOTICE_LAYER} flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 shadow-lg dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200`}
        >
          <span
            className="h-2 w-2 rounded-full bg-amber-500"
            aria-hidden="true"
          />
          {pending} queued offline
        </div>
      )}
    </OfflineQueueContext.Provider>
  );
}
