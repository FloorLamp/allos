// Tiny hand-rolled IndexedDB wrapper for the offline write queue (issue #28). No
// dependencies — a single object store keyed by the intent's idempotency `key`.
// Everything is guarded so it degrades to a no-op where IndexedDB is unavailable
// (SSR, private mode, older/embedded webviews): the app stays fully functional
// online, it just can't persist a queue. The pure intent shapes + decision logic
// live in lib/offline/queue.ts (unit-tested); this file is the browser-only glue and
// is exercised by the Playwright e2e (offline-queue.spec.ts), not the pure suite.
//
// The database itself is opened through lib/offline/idb.ts, which is shared with the
// form-draft store (#1699) — one database, one version, one upgrade path. A QUEUED
// WRITE and a DRAFT are different things (see lib/offline/drafts.ts for the
// boundary); they cohabit only so there is a single PHI perimeter on the device.

import type { QueuedIntent, RejectedEntry } from "@/lib/offline/queue";
import {
  INTENTS_STORE as STORE,
  REJECTED_STORE as REJECTED,
  DRAFTS_STORE,
  SNAPSHOTS_STORE,
  hasIndexedDB,
  openOfflineDb as openDb,
  txDone as done,
} from "@/lib/offline/idb";
import {
  closeSession,
  guardedWrite,
  guardedWriteNow,
  updateGate,
} from "@/lib/offline/write-gate";

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function rejectedTx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(REJECTED, mode).objectStore(REJECTED);
}

// Append an intent to the queue. Best-effort: resolves even if IndexedDB is
// unavailable (returns false) so a caller can still surface a "queued" toast when it
// at least has the intent in memory — but in practice IndexedDB is present wherever a
// service worker is.
export async function enqueueIntent(intent: QueuedIntent): Promise<boolean> {
  // Gated like every other device-local PHI write (#2908's write gate), and gated as the
  // FOREGROUND write it is: the tap has already happened, so there is no in-flight work
  // for a wipe to land inside and no token worth carrying. `guardedWriteNow` asks the
  // closes inside this write's own transaction, which is the case the gate was built for
  // — a logged-out device must not accept new PHI just because a stale tab still has a
  // button.
  //
  // The answer is the caller's to read. It is `false` when the device refused to keep the
  // write, and components/OfflineQueueProvider says so rather than letting a flow toast
  // "saved offline — will sync when you reconnect" over a queue that captured nothing.
  return guardedWriteNow([STORE], "queue", (tx) => {
    tx.objectStore(STORE).put(intent);
  });
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
  intents: readonly QueuedIntent[],
  // The generation the FLUSH started at. A flush in flight when logout wiped the queue
  // used to re-write its retry entries afterwards — `attempts: 0 -> 1` in the store,
  // which is a re-write and not a wipe that missed. Replay being idempotent answers a
  // different question; this one is PHI at rest surviving logout, which is clearQueue's
  // entire purpose (#28/#475).
  token: number
): Promise<void> {
  if (intents.length === 0) return;
  await guardedWrite([STORE], "queue", token, (tx) => {
    const store = tx.objectStore(STORE);
    for (const i of intents) store.put(i);
  });
}

// Park rejected/undeliverable entries in the dead-letter store for review (issue
// #475). Best-effort; keyed on intent.key so a re-park overwrites.
export async function saveRejected(
  entries: readonly RejectedEntry[],
  // Same flush, same window, same PHI — and worse, because a parked entry is permanent.
  token: number
): Promise<void> {
  if (entries.length === 0) return;
  await guardedWrite([REJECTED], "queue", token, (tx) => {
    const store = tx.objectStore(REJECTED);
    for (const e of entries) store.put(e);
  });
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

// Drop the entire queue, the rejected dead-letter store, the form drafts AND the
// offline read snapshots. Called
// on logout so one login's device-local PHI never lingers for the next (issue #28:
// clear the queue on logout; #475: the parked rejected entries hold the same PHI;
// #1699: so do half-typed drafts; #2908: so do the read snapshots).
export async function clearQueue(): Promise<void> {
  // LOGOUT. Every device-local store goes, and the write GATE closes, IN ONE
  // TRANSACTION — which is the whole point, and the thing four rounds of review kept
  // finding the gap in. Clearing and closing atomically means there is no instant in
  // which the data is gone but a writer still believes it may write, and because the
  // gate lives in the database rather than in a module variable, "a writer" includes one
  // in ANOTHER TAB: tabs share a database and share no memory.
  //
  // The window this defends is long and fully authenticated. components/SidebarContent
  // wipes and then submits the logout, and the page, the session and every mounted
  // component stay alive for the entire POST. Three different writes were observed
  // landing inside it:
  //   • a snapshot refresh that STARTED after the wipe, holding a legitimately current
  //     generation, answered 200 by the still-live session — all five kinds back;
  //   • a queue flush already in flight re-writing its retry entries (`attempts: 0 -> 1`
  //     is what proves it a re-write) and parking rejected entries permanently;
  //   • a form draft's 600ms autosave debounce landing a half-typed record afterwards,
  //     against lib/offline/draft-db.ts's own stated contract.
  // None of them is stopped by anything a wipe can do to the DATA. All are stopped here.
  //
  // AND THE CLOSE IS A BET. The logout POST that justifies it has not been sent yet, and
  // when it never lands the close has to come back off — see `reopenAfterFailedLogout`,
  // and read the call site in components/SidebarContent for why "the call threw" is not
  // the signal that tells those two apart.
  await updateGate(closeSession, [
    STORE,
    REJECTED,
    // #1699: half-typed form drafts are PHI at rest too, and logout is the one moment
    // every device-local store must go.
    DRAFTS_STORE,
    // #2908: the read snapshots are the largest device-local PHI surface of the four —
    // a med list and a dose schedule, readable with no session at /offline.
    SNAPSHOTS_STORE,
  ]);
}
