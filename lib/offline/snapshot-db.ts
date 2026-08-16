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

// ── THE WIPE FENCE ───────────────────────────────────────────────────────────
//
// A monotonic generation counter. Every wipe bumps it; every refresh captures it
// before its first await and re-checks it immediately before its write lands. A
// captured generation that no longer matches means A WIPE HAPPENED WHILE I WAS
// AWAY, and the write is dropped.
//
// WHY A REACT FLAG CANNOT DO THIS JOB. The refresher's only guard used to be the
// effect's `cancelled` flag, which is set on UNMOUNT — and on logout the component
// unmounts only once the logout navigation completes. The sidebar wipes FIRST and
// then keeps the page alive for the whole logout round trip, so the entire logout
// POST was an open window in which an in-flight `putSnapshots(fresh)` re-wrote the
// full payload — a med list and a dose schedule — into a store that had just been
// cleared. Every snapshot then survived logout and rendered session-free at
// /offline. A flag tied to unmount cannot see a wipe; a generation can.
//
// It is deliberately NOT a bound/timeout. A lane held the store with a six-second
// transaction and the wipe still won; the leak was never the 2s race in
// SidebarContent, it was the re-write after it.
let epoch = 0;

/** The current generation — captured by a refresh before it starts. */
export function snapshotEpoch(): number {
  return epoch;
}

/** Invalidate every generation captured so far. Called by the wipes, nothing else. */
export function bumpSnapshotEpoch(): void {
  epoch += 1;
}

// ── AND THE CLOSE, WHICH THE FENCE CANNOT REPLACE ────────────────────────────
//
// The fence answers one question: "did a wipe land while I was away?" That is the
// right question for a refresh already in flight, and it is the whole answer for a
// profile switch or the off switch, where re-capturing afterwards is the POINT.
//
// It is not the whole answer for LOGOUT, and this is the hole the fence left. A
// refresh that STARTS after the logout wipe captures the post-wipe generation, so
// its fence holds — legitimately, by the fence's own rule. It then finds an empty
// store, concludes that every kind is missing, asks the server for ALL FIVE, and
// gets a 200, because the logout POST has not landed yet and the session is still
// alive. It writes the complete payload back into the store logout just cleared.
//
// Observed, not theorised (the run that leaked, times relative to the click):
//     NAV / @202 · POST-start / @356 · GET kinds=<all five> @356 · 200 @1886
//     → stored = [dose-schedule, food-tallies, medication-list, practice-week,
//                 recent-training]
// The page stays mounted and authenticated for the entire logout round trip, so any
// of the refresher's ordinary triggers — a navigation, a reconnect, the tab becoming
// visible — can start that refresh in the window.
//
// So logout is not a wipe, it is a TERMINAL STATE for this document: after it, this
// page never writes a snapshot again, whatever generation it holds. Closed is
// checked inside the fence itself, so every writer inherits it and none can forget.
let closed = false;

/**
 * End snapshot writing for this document. Called by the LOGOUT wipe only — the
 * profile switch and the off switch must both be able to re-capture afterwards, and
 * they bump the generation instead.
 *
 * A failed logout leaves it closed until the next mount. That is the safe direction:
 * the device has already been stripped, and a session the user asked to end is not a
 * session to re-cache for.
 */
export function closeSnapshotStore(): void {
  closed = true;
  bumpSnapshotEpoch();
}

/**
 * Re-open for a NEW authenticated session. Called once per mount of the refresher, so
 * logging back in re-opens — an (app) layout that is mounted IS a session — while the
 * effect re-runs that happen during a logout navigation never can.
 */
export function openSnapshotStore(): void {
  closed = false;
}

/** Whether logout has ended snapshot writing for this document. */
export function snapshotStoreClosed(): boolean {
  return closed;
}

/** Whether a write captured at `fence` may still land: no wipe since, and not closed. */
export function snapshotFenceHolds(fence: number): boolean {
  return !closed && fence === epoch;
}

// Store (overwriting by kind) the freshly-captured snapshots, unless a wipe has
// landed since `fence` was captured. Answers whether it actually wrote.
//
// Best-effort otherwise: a full or blocked quota throws and is swallowed — the online
// app is unaffected, only the offline copy is skipped, exactly as writeEmergencyPayload
// treats the same failure.
export async function putSnapshots(
  snapshots: readonly AnySnapshot[],
  // Required, not optional: a caller that does not say which generation its payload
  // was fetched under cannot be fenced, and this is the one write that must be.
  fence: number
): Promise<boolean> {
  if (!snapshotFenceHolds(fence)) return false;
  if (!hasIndexedDB() || snapshots.length === 0) return false;
  try {
    const db = await openDb();
    // Re-checked AFTER the open, because awaiting is exactly where a wipe gets in.
    // Past this point the check holds to completion: IndexedDB runs overlapping
    // readwrite transactions on one store in creation order, so a clear whose
    // transaction was created before ours would already have bumped the generation
    // above, and one created after ours runs after ours and wins.
    if (!snapshotFenceHolds(fence)) {
      db.close();
      return false;
    }
    const store = tx(db, "readwrite");
    for (const s of snapshots) store.put(s);
    await done(store.transaction);
    db.close();
    return true;
  } catch {
    /* quota / disabled storage — the offline copy simply isn't kept */
    return false;
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
  // BEFORE the guard and before the first await, so `void clearSnapshots()` fences an
  // in-flight refresh the instant it is CALLED rather than whenever its transaction
  // happens to complete. That ordering is what makes the settings off switch honest:
  // OfflineSnapshotsSettings fires and forgets and leaves the page mounted, so without
  // a synchronous bump a refresh already in flight would re-materialize everything the
  // toggle just erased.
  bumpSnapshotEpoch();
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
