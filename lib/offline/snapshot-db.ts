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
} from "@/lib/offline/idb";
import {
  bumpGeneration,
  captureWriteToken,
  closeSnapshots,
  currentGate,
  guardedWrite,
  openSnapshots,
  updateGate,
} from "@/lib/offline/write-gate";
import { parseSnapshot, type AnySnapshot } from "@/lib/offline/snapshots";

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

// ── THE WRITE GATE ───────────────────────────────────────────────────────────
//
// This module used to hold an in-memory generation and an in-memory `closed` flag. Both
// were correct about what they measured and both were scoped narrower than the property
// they defended — the generation could not see a refresh that STARTED after a wipe, and
// `closed` could not see a second TAB. lib/offline/write-gate.ts explains the shape that
// replaced them; the short version is that the gate now lives in the same database the
// writes land in and is checked inside the write's own transaction, so it crosses both
// wipes and documents by construction.
//
// The snapshot lane's three wipes stay deliberately different, and this is the asymmetry
// four rounds of review kept circling:
//   • LOGOUT closes every lane (lib/offline/queue-db's clearQueue) — nothing on this
//     device writes again until a new authenticated document opens the session.
//   • THE OFF SWITCH closes the snapshots lane only, and survives a reload and a
//     second tab.
//   • A PROFILE SWITCH closes nothing: it wipes so the NEXT profile can be captured, so
//     it only moves the generation, which drops writes already in flight.

/** The generation a refresh must still be at when its payload comes back. */
export const captureSnapshotToken = captureWriteToken;

/**
 * Wipe the snapshots for an identity change that must still allow re-capture — the
 * profile switch. Moves the generation in the same transaction as the clear, so a
 * refresh already in flight for the previous profile cannot land afterwards.
 */
export async function clearSnapshots(): Promise<void> {
  await updateGate(bumpGeneration, [STORE]);
}

/**
 * The offline-reads OFF SWITCH. Wipes AND closes the snapshots lane, so nothing
 * re-materialises until it is turned back on — including from a refresh that starts
 * after the toggle and is answered `enabled: true` by a server the Server Action has not
 * reached yet, and including from another tab.
 */
export async function disableSnapshotWrites(): Promise<void> {
  await updateGate(closeSnapshots, [STORE]);
}

/** Turning the off switch back on. */
export async function enableSnapshotWrites(): Promise<void> {
  await updateGate(openSnapshots);
}

/** Whether the snapshots lane is closed right now — asked before the server is. */
export async function snapshotWritesClosed(): Promise<boolean> {
  const gate = await currentGate();
  return gate.sessionClosed || gate.snapshotsClosed;
}

// Store (overwriting by kind) the freshly-captured snapshots — if the gate still allows
// it. Answers whether it actually wrote.
//
// Best-effort otherwise: a full or blocked quota throws and is swallowed — the online
// app is unaffected, only the offline copy is skipped, exactly as writeEmergencyPayload
// treats the same failure.
export async function putSnapshots(
  snapshots: readonly AnySnapshot[],
  // Required, not optional: a caller that does not say which generation its payload was
  // fetched under cannot be gated, and this is the write that must be.
  token: number
): Promise<boolean> {
  if (snapshots.length === 0) return false;
  return guardedWrite([STORE], "snapshots", token, (tx) => {
    const store = tx.objectStore(STORE);
    for (const s of snapshots) store.put(s);
  });
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
