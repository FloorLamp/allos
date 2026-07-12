// Tiny hand-rolled IndexedDB wrapper for the offline write queue (issue #28). No
// dependencies — a single object store keyed by the intent's idempotency `key`.
// Everything is guarded so it degrades to a no-op where IndexedDB is unavailable
// (SSR, private mode, older/embedded webviews): the app stays fully functional
// online, it just can't persist a queue. The pure intent shapes + decision logic
// live in lib/offline/queue.ts (unit-tested); this file is the browser-only glue and
// is exercised by the Playwright e2e (offline-queue.spec.ts), not the pure suite.

import type { QueuedIntent, RejectedEntry } from "@/lib/offline/queue";

const DB_NAME = "allos-offline";
// v2 adds the REJECTED dead-letter store (issue #475): a rejected/undeliverable
// intent leaves the live queue but is preserved here for the user to review + re-enter.
const DB_VERSION = 2;
const STORE = "intents";
const REJECTED = "rejected";

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
      // Keyed by the wrapped intent's idempotency key so re-parking the same key is
      // an overwrite, not a duplicate.
      if (!db.objectStoreNames.contains(REJECTED)) {
        db.createObjectStore(REJECTED, { keyPath: "intent.key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function rejectedTx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(REJECTED, mode).objectStore(REJECTED);
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

// Re-persist intents with their bumped attempt count (issue #475): an intent the
// server returned "error" for stays queued, but its `attempts` must survive the
// flush so the retry cap can eventually reclassify a permanently-stuck one. `put`
// overwrites by keyPath, so this is an in-place update of the live row.
export async function putIntents(
  intents: readonly QueuedIntent[]
): Promise<void> {
  if (!hasIndexedDB() || intents.length === 0) return;
  try {
    const db = await openDb();
    const store = tx(db, "readwrite");
    for (const i of intents) store.put(i);
    await done(store.transaction);
    db.close();
  } catch {
    /* ignore — the attempt count just doesn't advance this flush */
  }
}

// Park rejected/undeliverable entries in the dead-letter store for review (issue
// #475). Best-effort; keyed on intent.key so a re-park overwrites.
export async function saveRejected(
  entries: readonly RejectedEntry[]
): Promise<void> {
  if (!hasIndexedDB() || entries.length === 0) return;
  try {
    const db = await openDb();
    const store = rejectedTx(db, "readwrite");
    for (const e of entries) store.put(e);
    await done(store.transaction);
    db.close();
  } catch {
    /* ignore — a failed park is the pre-existing (invisible) behavior; no worse */
  }
}

// All parked rejected entries, most-recently-rejected first.
export async function allRejected(): Promise<RejectedEntry[]> {
  if (!hasIndexedDB()) return [];
  try {
    const db = await openDb();
    const store = rejectedTx(db, "readonly");
    const rows: RejectedEntry[] = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as RejectedEntry[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.sort((a, b) => b.rejectedAt.localeCompare(a.rejectedAt));
  } catch {
    return [];
  }
}

// Dismiss reviewed rejected entries by their intent key. Best-effort.
export async function removeRejected(keys: readonly string[]): Promise<void> {
  if (!hasIndexedDB() || keys.length === 0) return;
  try {
    const db = await openDb();
    const store = rejectedTx(db, "readwrite");
    for (const k of keys) store.delete(k);
    await done(store.transaction);
    db.close();
  } catch {
    /* ignore */
  }
}

// Count of parked rejected entries (drives the review badge).
export async function countRejected(): Promise<number> {
  if (!hasIndexedDB()) return 0;
  try {
    const db = await openDb();
    const store = rejectedTx(db, "readonly");
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

// Drop the entire queue AND the rejected dead-letter store. Called on logout /
// profile switch so one login's queued PHI never lingers for the next (issue #28:
// clear the queue on logout; #475: the parked rejected entries hold the same PHI).
export async function clearQueue(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    const t = db.transaction([STORE, REJECTED], "readwrite");
    t.objectStore(STORE).clear();
    t.objectStore(REJECTED).clear();
    await done(t);
    db.close();
  } catch {
    /* ignore */
  }
}
