// Tiny hand-rolled IndexedDB wrapper for the offline write queue (issue #28). No
// dependencies — a single object store keyed by the intent's idempotency `key`.
// Everything is guarded so it degrades to a no-op where IndexedDB is unavailable
// (SSR, private mode, older/embedded webviews): the app stays fully functional
// online, it just can't persist a queue. The pure intent shapes + decision logic
// live in lib/offline/queue.ts (unit-tested); this file is the browser-only glue and
// is exercised by the Playwright e2e (offline-queue.spec.ts), not the pure suite.

import type { QueuedIntent } from "@/lib/offline/queue";

const DB_NAME = "allos-offline";
const DB_VERSION = 1;
const STORE = "intents";

function hasIndexedDB(): boolean {
  return typeof indexedDB !== "undefined";
}

// Open (creating on first use) the queue database. Rejects are swallowed by callers
// so a blocked/failed open never breaks a submit.
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Append an intent to the queue. Best-effort: resolves even if IndexedDB is
// unavailable (returns false) so a caller can still surface a "queued" toast when it
// at least has the intent in memory — but in practice IndexedDB is present wherever a
// service worker is.
export async function enqueueIntent(intent: QueuedIntent): Promise<boolean> {
  if (!hasIndexedDB()) return false;
  try {
    const db = await openDb();
    const store = tx(db, "readwrite");
    store.put(intent);
    await done(store.transaction);
    db.close();
    return true;
  } catch {
    return false;
  }
}

// All queued intents, oldest first (insertion order — the store's default key
// order over uuid keys isn't chronological, so we sort by capturedAt).
export async function allIntents(): Promise<QueuedIntent[]> {
  if (!hasIndexedDB()) return [];
  try {
    const db = await openDb();
    const store = tx(db, "readonly");
    const rows: QueuedIntent[] = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as QueuedIntent[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  } catch {
    return [];
  }
}

// Delete the given idempotency keys (settled intents). Best-effort.
export async function removeIntents(keys: readonly string[]): Promise<void> {
  if (!hasIndexedDB() || keys.length === 0) return;
  try {
    const db = await openDb();
    const store = tx(db, "readwrite");
    for (const k of keys) store.delete(k);
    await done(store.transaction);
    db.close();
  } catch {
    /* ignore — a failed delete just means the next flush re-attempts, and the
       server's replayed_keys ledger keeps that idempotent */
  }
}

// Count of queued intents (drives the pending badge).
export async function countIntents(): Promise<number> {
  if (!hasIndexedDB()) return 0;
  try {
    const db = await openDb();
    const store = tx(db, "readonly");
    const n: number = await new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return n;
  } catch {
    return 0;
  }
}

// Drop the entire queue. Called on logout / profile switch so one login's queued
// PHI never lingers for the next (issue #28: clear the queue on logout).
export async function clearQueue(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    const store = tx(db, "readwrite");
    store.clear();
    await done(store.transaction);
    db.close();
  } catch {
    /* ignore */
  }
}
