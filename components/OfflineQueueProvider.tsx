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
  settledKeys,
  isAuthFailure,
  type FlowKind,
  type IntentPayload,
  type ReplayResult,
} from "@/lib/offline/queue";
import {
  enqueueIntent,
  allIntents,
  removeIntents,
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
}: {
  children: React.ReactNode;
}) {
  const [pending, setPending] = useState(0);
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
      let res: Response;
      try {
        res = await fetch("/api/offline-replay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intents }),
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
        return;
      }
      retriedAfterFailure.current = false;
      if (isAuthFailure(res.status)) {
        // Session lapsed (maybe while offline). Never drop the queue — prompt login.
        toast(
          "You've been signed out. Log back in to sync your offline entries.",
          { tone: "error", duration: null }
        );
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { results?: ReplayResult[] };
      const results = data.results ?? [];
      await removeIntents(settledKeys(results));
      // Count what this reconnect actually got to the server: "done" is our
      // apply, "duplicate" means a racing actor (the service worker's Background
      // Sync replays the queue independently) applied it first — either way the
      // user's offline entry is now safely synced and deserves the confirmation.
      // Only counting "done" made the toast (and the router refresh) vanish
      // whenever the service worker won the race.
      const synced = results.filter(
        (r) => r.status === "done" || r.status === "duplicate"
      ).length;
      await refreshCount();
      announceSynced(synced);
    } finally {
      flushing.current = false;
    }
  }, [toast, refreshCount, announceSynced]);

  const enqueue = useCallback(
    async (flow: FlowKind, date: string, payload: IntentPayload) => {
      await enqueueIntent(buildIntent(flow, date, payload));
      await refreshCount();
      void registerBackgroundSync();
    },
    [refreshCount]
  );

  useEffect(() => {
    void refreshCount();
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
  }, [flush, refreshCount, announceSynced]);

  return (
    <OfflineQueueContext.Provider value={{ pending, enqueue, flush }}>
      {children}
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
