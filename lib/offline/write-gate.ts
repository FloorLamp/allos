// THE DEVICE-LOCAL PHI WRITE GATE (#2908, and #28/#475/#1699 with it).
//
// Three rounds of review decided this PR on one shape of mistake, and it is worth
// stating before the code, because the code is only correct if the shape is:
//
//   THE GUARD WAS TRUE OF ITS OWN FUNCTION AND FALSE OF THE SYSTEM.
//
// A React `cancelled` flag was true about unmounting and false about wipes. An in-memory
// generation was true about one refresh's flight and false about the refresh that
// started after the wipe. A module-level `closed` was true about the document that
// pressed Log out and false about the second tab. Each fix was correct and each was
// scoped narrower than the property, so the next round found the next wipe or the next
// document. Patching a fourth instance would find a fifth.
//
// So the gate lives WHERE THE DATA LIVES — in the same IndexedDB the writes land in —
// and is checked INSIDE THE WRITE'S OWN TRANSACTION. That closes the whole class:
//
//   • it crosses documents, because tabs share one database (a module variable is the
//     one thing that cannot);
//   • it crosses wipes, because a wipe writes the gate in the same transaction that
//     clears the data, so there is no instant where one has landed and the other has not;
//   • it cannot be read-then-violated, because IndexedDB transactions are atomic: the
//     check and the put are the same transaction, so nothing can interleave between them.
//
// WHAT IT GATES, and why the lanes are separate. Logout ends every device-local write:
// the queue, the dead-letter entries, the drafts and the snapshots are all one login's
// PHI (#28/#475/#1699/#2908 share one perimeter and one wipe). The offline-reads OFF
// SWITCH is narrower — it must stop snapshots and must NOT stop the write queue, which
// is a different feature with a different promise.
//
// WHAT IT DOES NOT GATE: reads. `/offline` renders with no session and must keep doing
// so, and a read cannot leak what a wipe already removed.

import {
  META_STORE,
  hasIndexedDB,
  openOfflineDb as openDb,
  txDone as done,
} from "@/lib/offline/idb";

export const GATE_KEY = "device-writes";

// The lanes a write belongs to. Not a free string: a new device-local store has to say
// which promise governs it.
export type WriteLane = "snapshots" | "queue" | "drafts";

export interface WriteGate {
  key: string;
  // Bumped by every wipe. A writer captures it before its background work and the write
  // transaction refuses a stale one — that is the in-flight half, and it is what covers
  // a PROFILE SWITCH, which wipes so the next profile can be captured and therefore must
  // not close anything.
  generation: number;
  // Logout. Closes every lane until a new authenticated document opens it again.
  sessionClosed: boolean;
  // The offline-reads off switch. Closes the snapshots lane only, and survives a reload,
  // so the acceptance criterion — "nothing re-materializes until toggled back on" —
  // holds even while the Server Action that tells the SERVER is still in flight. The
  // server stays authoritative: its own `enabled: false` answer still wipes.
  snapshotsClosed: boolean;
}

export function defaultGate(): WriteGate {
  return {
    key: GATE_KEY,
    generation: 0,
    sessionClosed: false,
    snapshotsClosed: false,
  };
}

function parseGate(value: unknown): WriteGate {
  if (!value || typeof value !== "object") return defaultGate();
  const o = value as Partial<WriteGate>;
  return {
    key: GATE_KEY,
    generation: typeof o.generation === "number" ? o.generation : 0,
    sessionClosed: o.sessionClosed === true,
    snapshotsClosed: o.snapshotsClosed === true,
  };
}

/** Whether a write on `lane`, captured at `token`, may land. Pure — the tested part. */
export function gateAllows(
  gate: WriteGate,
  lane: WriteLane,
  token: number
): boolean {
  if (gate.sessionClosed) return false;
  if (lane === "snapshots" && gate.snapshotsClosed) return false;
  return gate.generation === token;
}

function readGate(store: IDBObjectStore): Promise<WriteGate> {
  return new Promise((resolve, reject) => {
    const req = store.get(GATE_KEY);
    req.onsuccess = () => resolve(parseGate(req.result));
    req.onerror = () => reject(req.error);
  });
}

/**
 * The generation a background task must carry to be allowed to write when it finishes.
 * Captured BEFORE the work (the fetch, the debounce, the flush round trip).
 *
 * Answers -1 where there is no IndexedDB, which no gate can equal, so a device with no
 * storage degrades to writing nothing rather than to writing unguarded.
 */
export async function captureWriteToken(): Promise<number> {
  if (!hasIndexedDB()) return -1;
  try {
    const db = await openDb();
    const gate = await readGate(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE)
    );
    db.close();
    return gate.generation;
  } catch {
    return -1;
  }
}

/**
 * THE ONE WRITER. Runs `work` against `stores` only if the gate still allows `lane` at
 * `token` — checked in the SAME transaction, so no wipe can interleave between the
 * check and the put. Answers whether it actually wrote.
 */
export async function guardedWrite(
  stores: readonly string[],
  lane: WriteLane,
  token: number,
  work: (tx: IDBTransaction) => void
): Promise<boolean> {
  if (!hasIndexedDB()) return false;
  try {
    const db = await openDb();
    const tx = db.transaction([META_STORE, ...stores], "readwrite");
    const gate = await readGate(tx.objectStore(META_STORE));
    if (!gateAllows(gate, lane, token)) {
      tx.abort();
      db.close();
      return false;
    }
    work(tx);
    await done(tx);
    db.close();
    return true;
  } catch {
    // A quota failure, a blocked open, or our own abort — the device simply does not
    // keep this copy, which is every caller's existing degraded path.
    return false;
  }
}

/**
 * Mutate the gate, and optionally clear stores in the SAME transaction. Wipes go through
 * here so the data and the gate can never disagree: there is no instant at which the
 * store is empty and the gate still says "writable at the old generation".
 */
export async function updateGate(
  change: (gate: WriteGate) => WriteGate,
  clearStores: readonly string[] = []
): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openDb();
    const tx = db.transaction([META_STORE, ...clearStores], "readwrite");
    const gate = await readGate(tx.objectStore(META_STORE));
    for (const name of clearStores) tx.objectStore(name).clear();
    tx.objectStore(META_STORE).put(change(gate));
    await done(tx);
    db.close();
  } catch {
    /* ignore — the caller's own degraded path applies */
  }
}

/** Bump only: an identity wipe that must still allow re-capture (the profile switch). */
export function bumpGeneration(gate: WriteGate): WriteGate {
  return { ...gate, generation: gate.generation + 1 };
}

/** Logout: every lane closed until a new authenticated document opens them. */
export function closeSession(gate: WriteGate): WriteGate {
  return { ...bumpGeneration(gate), sessionClosed: true };
}

/** A live authenticated document. Never touches the off switch's own state. */
export function openSession(gate: WriteGate): WriteGate {
  return { ...gate, sessionClosed: false };
}

/** The offline-reads off switch, and its opposite. */
export function closeSnapshots(gate: WriteGate): WriteGate {
  return { ...bumpGeneration(gate), snapshotsClosed: true };
}

export function openSnapshots(gate: WriteGate): WriteGate {
  return { ...gate, snapshotsClosed: false };
}

/** Read the gate as it stands. For tests and for the refresher's pre-fetch check. */
export async function currentGate(): Promise<WriteGate> {
  if (!hasIndexedDB()) return defaultGate();
  try {
    const db = await openDb();
    const gate = await readGate(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE)
    );
    db.close();
    return gate;
  } catch {
    return defaultGate();
  }
}
