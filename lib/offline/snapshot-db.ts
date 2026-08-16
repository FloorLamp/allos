// Browser-only IndexedDB glue for the offline read snapshots (issue #2908). The pure
// registry, the staleness rules and the queue overlay live in lib/offline/snapshots.ts
// (unit-tested); this file is the storage, exercised by the Playwright e2e tier.
//
// Same database as the write queue and the form drafts — lib/offline/idb.ts is the one
// opener, so there is ONE device-local PHI perimeter and ONE logout wipe. Everything is
// guarded so it degrades to a no-op where IndexedDB is unavailable (SSR, private mode,
// embedded webviews): the app stays fully functional online, it just holds no offline
// copy, and /offline then says so per section rather than spinning.

import {
  SNAPSHOTS_STORE as STORE,
  hasIndexedDB,
  openOfflineDb as openDb,
  txDone as done,
} from "@/lib/offline/idb";
import { parseSnapshot, type AnySnapshot } from "@/lib/offline/snapshots";

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

// Store (overwriting by kind) the freshly-captured snapshots. Best-effort: a full or
// blocked quota throws and is swallowed — the online app is unaffected, only the
// offline copy is skipped, exactly as writeEmergencyPayload treats the same failure.
export async function putSnapshots(
  snapshots: readonly AnySnapshot[]
): Promise<void> {
  if (!hasIndexedDB() || snapshots.length === 0) return;
  try {
    const db = await openDb();
    const store = tx(db, "readwrite");
    for (const s of snapshots) store.put(s);
    await done(store.transaction);
    db.close();
  } catch {
    /* quota / disabled storage — the offline copy simply isn't kept */
  }
}

// Every stored snapshot, validated. A row that fails `parseSnapshot` (wrong version,
// wrong shape, a blob written by an older build) is DROPPED rather than returned: the
// /offline page must never mis-render a payload it cannot vouch for.
export async function allSnapshots(): Promise<AnySnapshot[]> {
  if (!hasIndexedDB()) return [];
  try {
    const db = await openDb();
    const store = tx(db, "readonly");
    const rows: unknown[] = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.map(parseSnapshot).filter((s): s is AnySnapshot => s !== null);
  } catch {
    return [];
  }
}

// Drop every stored snapshot.
//
// THE WIPE IS THE FEATURE'S PRIMARY SAFETY PROPERTY, so it has exactly one
// implementation and three call sites, all of which are identity changes:
//   • logout               — components/SidebarContent.tsx, beside clearQueue/clearEmergencyPayload
//   • profile switch       — components/ProfileSwitchWatcher.tsx, which covers EVERY
//                            switch affordance by construction (the #600 fix)
//   • the off switch       — turning the per-profile toggle off wipes immediately and
//                            nothing re-materializes until it is turned back on
// It is also folded into clearQueue's own transaction so a logout path that forgets to
// call it still wipes — the #1699 "complete by construction" posture.
export async function clearSnapshots(): Promise<void> {
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
