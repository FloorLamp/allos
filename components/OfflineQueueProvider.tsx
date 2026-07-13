"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import {
  buildIntent,
  chunkIntents,
  planFlushDisposition,
  describeIntent,
  isAuthFailure,
  MAX_INTENTS,
  type FlowKind,
  type IntentPayload,
  type ReplayResult,
  type RejectedEntry,
} from "@/lib/offline/queue";
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
  enqueue: (
    flow: FlowKind,
    date: string,
    payload: IntentPayload
  ) => Promise<void>;
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
}: {
  children: React.ReactNode;
  // The session's active profile at render time (issue #599). Every intent enqueued
  // here is STAMPED with it, so a late replay lands on the profile the write was
  // captured under — not whatever profile is active at flush time. The layout passes
  // the current session's profile.id; a profile switch re-renders with the new value.
  activeProfileId: number;
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
  const router = useRouter();

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
    (n: number) => {
      if (n <= 0) return;
      const now = Date.now();
      if (now - lastSyncToastAt.current < 3000) return;
      lastSyncToastAt.current = now;
      toast(`Synced ${n} offline ${n === 1 ? "entry" : "entries"}.`);
      // Reflect the newly-landed rows in the current view.
      router.refresh();
    },
    [toast, router]
  );

  const flush = useCallback(async () => {
    // A single in-flight flush at a time; the server ledger makes any missed
    // overlap idempotent anyway.
    if (flushing.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    flushing.current = true;
    try {
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
        await putIntents(plan.retry);
        await saveRejected(plan.rejected);
        totalSynced += plan.syncedCount;
        totalRejected += plan.rejected.length;
      }
      await refreshCount();
      await refreshRejected();
      announceSynced(totalSynced);
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
      await enqueueIntent(buildIntent(flow, date, payload, activeProfileId));
      await refreshCount();
      void registerBackgroundSync();
    },
    [refreshCount, activeProfileId]
  );

  useEffect(() => {
    void refreshCount();
    void refreshRejected();
    void flush(); // on-load flush for a queue left pending across a reload

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
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-[101] w-[min(22rem,calc(100vw-2rem))] space-y-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 shadow-lg dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">
              {rejected.length} offline{" "}
              {rejected.length === 1 ? "entry" : "entries"} couldn&rsquo;t be
              applied
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
                className="flex items-start justify-between gap-2 rounded-lg bg-white/60 px-2 py-1.5 dark:bg-black/20"
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
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-[100] flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 shadow-lg dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
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
